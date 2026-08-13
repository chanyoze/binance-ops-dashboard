/**
 * 스트림이 살아 있다고 **말만 하는** 상태를 판정한다.
 *
 * 수집기는 같은 문제를 이미 풀어 두었다 — 소켓은 OPEN 인데 메시지만 오지 않는
 * 좀비 연결을 watchdog 이 잡는다(`ws-collector.ts`). 브라우저 쪽에는 그 장치가 없었다.
 *
 * `EventSource` 는 **응답 헤더를 받은 시점에** `open` 을 발생시킨다. 본문이 한 바이트도
 * 오지 않아도 마찬가지다. 그래서 중간 프록시가 스트림을 버퍼링하면
 * **화면은 "연결됨"이라고 표시한 채 영원히 아무것도 받지 못한다.**
 * 오류도 나지 않고 재연결도 걸리지 않는다. 조용히 멎은 화면이 된다.
 *
 * 실제로 Cloudflare 터널 뒤에서 이 상태를 재현했다. SSE 를 버퍼링하는 프록시는
 * 드물지 않다 — 사내 프록시와 일부 CDN 이 같은 동작을 한다.
 *
 * 판정은 서버 watchdog 과 같은 방식이다. "마지막으로 뭔가 받은 지 얼마나 됐나."
 */

/**
 * 이 시간 동안 아무 이벤트도 없으면 멎은 것으로 본다.
 *
 * 서버는 운영 지표를 2초마다 밀어 준다(`realtime.ts` 의 `OPS_INTERVAL_MS`).
 * 즉 정상이라면 최소 2초에 한 번은 무언가 도착한다. 8초는 그것을 네 번 놓친 것이라
 * 정상 변동으로 보기 어렵다. 더 짧게 잡으면 잠깐의 지연에도 폴백이 켜진다.
 *
 * heartbeat(15초)는 기준으로 쓸 수 없다. SSE 주석 줄이라 `EventSource` 가
 * 이벤트로 노출하지 않는다.
 */
export const STALL_THRESHOLD_MS = 8_000

/**
 * 멎었을 때 다시 받아오는 주기.
 *
 * `/api/dashboard` 는 커버리지·상대강도·24h 집계를 전부 도는 무거운 엔드포인트다.
 * 헬스체크를 따로 가볍게 만든 이유가 바로 이것이다(`api/health/route.ts`).
 * 그래서 이 폴링은 **멎었을 때만** 돈다. 정상 환경에서는 한 번도 실행되지 않는다.
 *
 * 무거운 것을 감수하는 이유는 단순하다 — 이 상황에서는
 * "무거워도 갱신되는 화면"이 "가벼운데 멈춘 화면"보다 낫다.
 */
export const FALLBACK_POLL_MS = 5_000

export type StreamPhase = 'connecting' | 'live' | 'stalled' | 'reconnecting'

export interface StreamPhaseInput {
  /** 마지막으로 무언가 도착한 시각. `open` 도 신호로 친다. 아직 없으면 null */
  lastSignalAt: number | null
  /** `EventSource` 가 error 를 낸 뒤 아직 다시 열리지 않았는가 */
  errored: boolean
  now: number
  stallMs?: number
}

/**
 * 지금 스트림이 어떤 상태인지.
 *
 * `reconnecting` 과 `stalled` 를 나누는 것이 요점이다. 둘 다 화면이 갱신되지
 * 않는 상태지만 원인이 다르다 — 전자는 연결이 끊어진 것이고, 후자는
 * **연결은 멀쩡한데 데이터만 오지 않는 것**이다. 후자에만 폴백이 필요하다.
 * 끊긴 경우는 `EventSource` 가 알아서 다시 붙고, 다시 붙는 순간 resync 가 돈다.
 */
export function deriveStreamPhase({
  lastSignalAt,
  errored,
  now,
  stallMs = STALL_THRESHOLD_MS,
}: StreamPhaseInput): StreamPhase {
  if (errored) return 'reconnecting'
  if (lastSignalAt === null) return 'connecting'
  return now - lastSignalAt >= stallMs ? 'stalled' : 'live'
}

/**
 * 폴백 폴링을 돌려야 하는가.
 *
 * `stalled` 에서만 켠다. `reconnecting` 은 연결 자체가 없는 상태라,
 * 그때는 폴링도 같이 실패한다 — 부하만 늘고 얻는 것이 없다.
 */
export function shouldPoll(phase: StreamPhase): boolean {
  return phase === 'stalled'
}
