import type { Logger } from '@app/shared'
import pg from 'pg'

/**
 * 수집기(별도 프로세스)가 새 데이터를 받았을 때, 웹 서버가 그걸 어떻게 알 것인가.
 * (docs/DECISIONS.md D-09)
 *
 *   [collector] ──RealtimeBus──▶ [web] ──SSE──▶ [browser]
 *
 * 기본 구현은 Postgres LISTEN/NOTIFY 다. 인프라를 하나도 늘리지 않으면서
 * 진짜 push 를 구현한다 — 웹이 1초마다 "새거 있어?"를 묻지 않아도 된다.
 *
 * **이 인터페이스가 존재하는 이유가 핵심이다.** 규모가 커지면 Redis Pub/Sub 으로
 * 교체해야 하는데, 그때 바꿔야 할 것이 이 파일 하나뿐이도록 분리해 두었다.
 * 확장성에 대한 고민을 말이 아니라 코드 구조로 남긴 것이다.
 */
export interface RealtimeBus {
  publish(channel: string, payload: unknown): Promise<void>
  subscribe(channel: string, handler: (payload: unknown) => void): Promise<void>
  close(): Promise<void>
}

/** NOTIFY 페이로드 상한. Postgres 제약은 8000바이트이며 보수적으로 잡는다. */
const MAX_PAYLOAD_BYTES = 7_000

/**
 * Postgres LISTEN/NOTIFY 구현.
 *
 * 주의: LISTEN 은 커넥션이 계속 살아 있어야 하므로 **서버리스 환경에서는 동작하지 않는다.**
 * Vercel 같은 곳에 배포하면 폴백(PollingBus)으로 바꿔야 한다.
 * Railway 는 컨테이너라 문제없다. 이 제약을 알고 선택했다.
 */
export class PgNotifyBus implements RealtimeBus {
  private listener: pg.Client | null = null
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>()
  private closed = false

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {}

  async publish(channel: string, payload: unknown): Promise<void> {
    const serialized = JSON.stringify(payload)

    // 페이로드가 크면 알림만 보내고 본문은 생략한다.
    // 수신 측은 "뭔가 바뀌었다"는 신호만으로도 DB 를 다시 읽으면 되므로 정합성은 유지된다.
    const body =
      Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES
        ? JSON.stringify({ oversized: true })
        : serialized

    const client = await this.getPublisher()
    // pg_notify 를 쓰는 이유: NOTIFY 는 채널명을 파라미터로 받지 못해
    // 문자열 연결이 필요하고, 그러면 SQL 인젝션 경로가 열린다.
    await client.query('SELECT pg_notify($1, $2)', [channel, body])
  }

  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const existing = this.handlers.get(channel)
    if (existing) {
      existing.push(handler)
      return
    }
    this.handlers.set(channel, [handler])

    const client = await this.getListener()
    // 채널명은 식별자라 파라미터 바인딩이 불가능하다. 화이트리스트 검증으로 막는다.
    assertSafeChannelName(channel)
    await client.query(`LISTEN "${channel}"`)
    this.logger.info('실시간 채널 구독', { channel })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.listener?.end().catch(() => undefined)
    await this.publisher?.end().catch(() => undefined)
    this.listener = null
    this.publisher = null
  }

  private publisher: pg.Client | null = null

  private async getPublisher(): Promise<pg.Client> {
    if (this.publisher) return this.publisher
    const client = new pg.Client({ connectionString: this.connectionString })
    await client.connect()
    this.publisher = client
    return client
  }

  private async getListener(): Promise<pg.Client> {
    if (this.listener) return this.listener

    const client = new pg.Client({ connectionString: this.connectionString })
    await client.connect()

    client.on('notification', (message) => {
      const handlers = this.handlers.get(message.channel)
      if (!handlers) return

      let payload: unknown = null
      try {
        payload = message.payload ? JSON.parse(message.payload) : null
      } catch {
        payload = null
      }

      for (const handler of handlers) {
        try {
          handler(payload)
        } catch (error) {
          this.logger.error('실시간 핸들러 오류', {
            channel: message.channel,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })

    // LISTEN 커넥션이 끊기면 재연결해야 한다. 끊긴 채로 두면 대시보드가 조용히 멈춘다.
    client.on('error', (error) => {
      this.logger.error('LISTEN 커넥션 오류 — 재연결 예약', { error: error.message })
      this.listener = null
      if (!this.closed) setTimeout(() => void this.resubscribeAll(), 2_000)
    })

    this.listener = client
    return client
  }

  private async resubscribeAll(): Promise<void> {
    if (this.closed) return
    try {
      const client = await this.getListener()
      for (const channel of this.handlers.keys()) {
        assertSafeChannelName(channel)
        await client.query(`LISTEN "${channel}"`)
      }
      this.logger.info('실시간 채널 재구독 완료', { channels: [...this.handlers.keys()] })
    } catch (error) {
      this.logger.error('재구독 실패 — 재시도 예약', {
        error: error instanceof Error ? error.message : String(error),
      })
      if (!this.closed) setTimeout(() => void this.resubscribeAll(), 5_000)
    }
  }
}

/** 채널명은 식별자로 들어가므로 영숫자와 언더스코어만 허용한다. */
function assertSafeChannelName(channel: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(channel)) {
    throw new Error(`허용되지 않는 채널명입니다: ${channel}`)
  }
}

/** 실시간 채널 상수 — 발행/구독 양쪽이 같은 이름을 쓰도록 한곳에 모은다. */
export const CHANNELS = {
  kline: 'kline_update',
  ticker: 'ticker_update',
  pipeline: 'pipeline_event',
} as const
