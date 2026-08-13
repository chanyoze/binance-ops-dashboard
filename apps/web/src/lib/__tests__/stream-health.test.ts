import { describe, expect, it } from 'vitest'
import {
  deriveStreamPhase,
  FALLBACK_POLL_MS,
  STALL_THRESHOLD_MS,
  shouldPoll,
  type StreamPhase,
} from '../stream-health.js'

/**
 * 스트림 상태 판정.
 *
 * 여기가 틀리면 두 방향으로 손해가 난다.
 *  - 너무 민감하면 정상인데도 무거운 집계 폴링이 상시로 돈다
 *  - 너무 둔하면 멎은 화면을 오래 방치한다. 그 화면은 **틀린 값을 맞다고 보여준다**
 */

const T0 = 1_700_000_000_000

const phaseAt = (
  lastSignalAt: number | null,
  elapsedMs: number,
  errored = false,
): StreamPhase => deriveStreamPhase({ lastSignalAt, errored, now: T0 + elapsedMs })

describe('deriveStreamPhase', () => {
  it('아직 아무 신호도 없으면 연결 중이다', () => {
    expect(phaseAt(null, 0)).toBe('connecting')
    // 신호가 없는 동안에는 시간이 아무리 흘러도 stalled 로 넘어가지 않는다.
    // 열리지도 않은 연결을 "멎었다"고 할 수는 없다.
    expect(phaseAt(null, 60_000)).toBe('connecting')
  })

  it('임계 안에 신호가 있으면 live 다', () => {
    expect(phaseAt(T0, 0)).toBe('live')
    expect(phaseAt(T0, STALL_THRESHOLD_MS - 1)).toBe('live')
  })

  it('임계를 넘도록 조용하면 stalled 다', () => {
    expect(phaseAt(T0, STALL_THRESHOLD_MS)).toBe('stalled')
    expect(phaseAt(T0, STALL_THRESHOLD_MS * 10)).toBe('stalled')
  })

  it('신호가 도착하면 stalled 에서 곧바로 회복된다', () => {
    // 폴백이 도는 중에 SSE 가 살아나는 경우다. 여기서 회복되지 않으면
    // 폴링과 SSE 가 동시에 상태를 쓰게 된다.
    expect(phaseAt(T0, STALL_THRESHOLD_MS)).toBe('stalled')
    const recovered = T0 + STALL_THRESHOLD_MS
    expect(deriveStreamPhase({ lastSignalAt: recovered, errored: false, now: recovered })).toBe(
      'live',
    )
  })

  it('error 는 조용함보다 우선한다 — 끊긴 것과 멎은 것은 다르다', () => {
    // 끊긴 것은 EventSource 가 알아서 다시 붙는다. 폴백을 켤 이유가 없다.
    expect(phaseAt(T0, 0, true)).toBe('reconnecting')
    expect(phaseAt(T0, STALL_THRESHOLD_MS * 10, true)).toBe('reconnecting')
    expect(phaseAt(null, 0, true)).toBe('reconnecting')
  })

  it('임계는 호출자가 바꿀 수 있다', () => {
    expect(deriveStreamPhase({ lastSignalAt: T0, errored: false, now: T0 + 500, stallMs: 400 })).toBe(
      'stalled',
    )
  })
})

describe('shouldPoll', () => {
  it('멎었을 때만 켠다', () => {
    expect(shouldPoll('stalled')).toBe(true)
    expect(shouldPoll('live')).toBe(false)
    expect(shouldPoll('connecting')).toBe(false)
    // 연결이 없는 상태에서는 폴링도 실패한다. 부하만 늘고 얻는 것이 없다.
    expect(shouldPoll('reconnecting')).toBe(false)
  })
})

describe('임계값', () => {
  it('폴링 주기가 감지 임계보다 짧다', () => {
    // 반대가 되면 "멎었다"고 판정하고도 한참 뒤에야 처음 받아오게 된다.
    expect(FALLBACK_POLL_MS).toBeLessThan(STALL_THRESHOLD_MS)
  })

  it('감지 임계가 서버의 지표 push 주기보다 넉넉하다', () => {
    // realtime.ts 의 OPS_INTERVAL_MS 는 2초다. 최소 두 번은 놓쳐야 의심한다.
    const OPS_INTERVAL_MS = 2_000
    expect(STALL_THRESHOLD_MS).toBeGreaterThanOrEqual(OPS_INTERVAL_MS * 3)
  })
})
