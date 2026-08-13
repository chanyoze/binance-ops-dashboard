import { subscribe, type StreamEvent } from '@/server/realtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * SSE 스트림.
 *
 * ## 왜 WebSocket 이 아닌가 (D-10)
 *
 * 이 화면의 통신은 **서버 -> 클라이언트 단방향**이다. 브라우저가 서버로 보낼 말이 없다.
 * SSE 는 그 경우를 위한 프로토콜이고, 대신 두 가지를 공짜로 준다:
 * 재연결이 브라우저에 내장돼 있고, 평범한 HTTP 라 프록시·로드밸런서를 그냥 통과한다.
 * WebSocket 은 양방향을 얻는 대신 그 둘을 직접 만들어야 한다.
 *
 * 폴링과 비교하면 지연이 낮고, 아무 일도 없을 때 트래픽이 0 이다.
 */

/** 프록시가 유휴 연결을 끊지 않도록 주기적으로 주석 줄을 보낸다. */
const HEARTBEAT_MS = 15_000

export function GET(request: Request): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false

      const write = (chunk: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // 클라이언트가 이미 끊은 경우다. 정리는 abort 핸들러가 한다.
          closed = true
        }
      }

      const send = (event: StreamEvent): void => {
        write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      }

      // 브라우저에 재연결 간격을 알려준다. 끊겨도 알아서 다시 붙는다.
      write('retry: 3000\n\n')

      let unsubscribe: (() => void) | null = null
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS)

      /**
       * 여러 번 불려도 안전해야 한다 — `if (closed) return` 으로 막으면 안 된다.
       *
       * 이 함수는 두 경로에서 불린다: abort 핸들러와, 구독을 마친 뒤의 "이미 떠났나" 확인.
       * 구독이 끝나기 **전에** 클라이언트가 끊으면 abort 가 먼저 돌면서 `closed` 만
       * 세우고 가는데(그 시점의 `unsubscribe` 는 아직 null 이다), 뒤이은 확인이
       * 조기 반환되면 구독이 영영 해지되지 않는다. `write()` 가 enqueue 실패로
       * `closed` 를 세운 경우도 같다 — heartbeat 와 구독이 함께 샌다.
       *
       * 그래서 가드 대신, 각 자원을 한 번만 놓도록 만든다.
       */
      const cleanup = (): void => {
        closed = true
        clearInterval(heartbeat)

        const release = unsubscribe
        unsubscribe = null
        release?.()

        try {
          controller.close()
        } catch {
          // 이미 닫혔으면 그만이다.
        }
      }

      request.signal.addEventListener('abort', cleanup)

      try {
        unsubscribe = await subscribe(send)
        // 구독을 마치기 전에 클라이언트가 떠났으면 바로 정리한다.
        if (request.signal.aborted) cleanup()
      } catch (error) {
        console.error('[api/stream] 구독 실패', error)
        write(`event: error\ndata: ${JSON.stringify({ message: '실시간 연결에 실패했습니다.' })}\n\n`)
        cleanup()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Nginx 계열이 응답을 버퍼링하면 이벤트가 뭉쳐서 도착한다.
      'X-Accel-Buffering': 'no',
    },
  })
}
