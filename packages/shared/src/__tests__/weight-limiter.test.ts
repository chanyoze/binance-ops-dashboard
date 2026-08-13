import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WeightLimiter } from '../binance/weight-limiter.js'
import type { Logger } from '../logger.js'

/**
 * REST weight 관리 — **여기가 틀리면 곧바로 데이터에 구멍이 난다.**
 *
 * 이 프로젝트는 "429 를 맞고 나서 대응하면 이미 늦다"고 판단해 능동적으로
 * 사용량을 세기로 했다 (D-06). 그런데 그 판단을 지키는 코드에 테스트가 없었다.
 *
 * 두 방향으로 다 위험하다.
 *  - 덜 기다리면 Binance 가 429/418 로 막는다. 백필이 멈추고 그 구간이 구멍으로 남는다.
 *  - 더 기다리면 백필이 하염없이 느려진다. 최초 실행에서 특히 티가 난다.
 *
 * 시간에 걸린 로직이라 가짜 타이머로 고정해서 본다.
 */

const silent = (): Logger => {
  const noop = (): void => undefined
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  return logger
}

const LIMIT = 6_000
const SOFT = 0.8
/** 소프트 임계 — 이 값을 넘기려는 요청은 다음 분까지 기다린다. */
const CEILING = LIMIT * SOFT

/** 분 경계에서 시작해야 창 굴림을 정확히 잴 수 있다. */
const T0 = Math.floor(1_700_000_000_000 / 60_000) * 60_000

const make = (onThrottle?: (d: Record<string, unknown>) => void): WeightLimiter =>
  new WeightLimiter(LIMIT, SOFT, silent(), onThrottle)

/**
 * 약속이 끝났는지를 **플래그로** 추적한다.
 *
 * 처음에는 `Promise.race([p.then(...), Promise.resolve(marker)])` 로 짰는데,
 * 이미 해결된 약속이어도 마커 쪽이 먼저 이긴다 — 마이크로태스크가 한 틱 빠르기 때문이다.
 * 그래서 그 헬퍼는 **항상 "대기 중"이라고 답했고**, 그것을 쓴 단언은 아무것도 검증하지
 * 못했다. 페널티 기본값을 60초에서 1초로 바꿔 보고서야 드러났다.
 *
 * 타이머를 감으면 마이크로태스크도 함께 비워지므로, 플래그를 보면 정확하다.
 */
const track = (promise: Promise<unknown>): { done: boolean } => {
  const state = { done: false }
  void promise.then(() => {
    state.done = true
  })
  return state
}

describe('WeightLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('여유가 있으면 기다리지 않는다', async () => {
    const limiter = make()
    await limiter.acquire(1)
    expect(limiter.snapshot().used).toBe(1)
  })

  it('소프트 임계 안에서는 계속 통과시킨다', async () => {
    const limiter = make()
    await limiter.acquire(CEILING - 1)
    await limiter.acquire(1)

    expect(limiter.snapshot().used).toBe(CEILING)
  })

  it('임계를 넘기려는 요청은 다음 분 경계까지 기다린다', async () => {
    // 여기서 안 기다리면 Binance 가 막는다. 막히면 백필이 멈추고 구멍이 남는다.
    const limiter = make()
    await limiter.acquire(CEILING)

    const pending = limiter.acquire(10)
    const state = track(pending)

    // 아직 같은 분 안이면 계속 기다린다.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.done).toBe(false)

    // 분이 넘어가면 Binance 카운터가 리셋되므로 통과한다.
    await vi.advanceTimersByTimeAsync(30_100)
    await pending
    expect(state.done).toBe(true)
    expect(limiter.snapshot().used).toBe(10)
  })

  it('분이 바뀌면 사용량이 리셋된다', async () => {
    const limiter = make()
    await limiter.acquire(1_000)
    expect(limiter.snapshot().used).toBe(1_000)

    vi.setSystemTime(T0 + 60_000)
    expect(limiter.snapshot().used).toBe(0)
  })

  it('임계에 걸리면 운영 지표로 알린다', async () => {
    // 대시보드가 읽는 이벤트다. 조용히 기다리면 왜 느린지 아무도 모른다.
    const seen: Record<string, unknown>[] = []
    const limiter = make((detail) => seen.push(detail))

    await limiter.acquire(CEILING)
    const pending = limiter.acquire(10)
    await vi.advanceTimersByTimeAsync(61_000)
    await pending

    expect(seen[0]).toMatchObject({ reason: 'soft_threshold' })
  })

  describe('응답 헤더 보정', () => {
    it('서버가 알려준 값이 더 크면 그것을 따른다', () => {
      // 다른 프로세스가 같은 키로 요청했을 수 있다. 우리 카운터만 믿으면 초과한다.
      const limiter = make()
      limiter.observeHeader(3_000)
      expect(limiter.snapshot().used).toBe(3_000)
    })

    it('우리 카운터가 더 크면 보수적으로 큰 쪽을 유지한다', async () => {
      // 헤더는 직전 응답 기준이라 우리보다 뒤처져 있을 수 있다.
      // 여기서 낮은 값으로 덮으면 방금 쓴 weight 를 잊고 초과한다.
      const limiter = make()
      await limiter.acquire(3_000)
      limiter.observeHeader(100)

      expect(limiter.snapshot().used).toBe(3_000)
    })

    it('값이 없거나 숫자가 아니면 무시한다', async () => {
      // 헤더가 빠졌다고 카운터를 0 으로 만들면 그 순간 제한이 사라진다.
      const limiter = make()
      await limiter.acquire(500)
      limiter.observeHeader(null)
      limiter.observeHeader(Number.NaN)

      expect(limiter.snapshot().used).toBe(500)
    })
  })

  describe('429/418 페널티', () => {
    it('Retry-After 만큼 모든 요청을 막는다', async () => {
      const limiter = make()
      limiter.applyPenalty(30)

      const pending = limiter.acquire(1)
      const state = track(pending)

      await vi.advanceTimersByTimeAsync(29_000)
      expect(state.done).toBe(false)

      await vi.advanceTimersByTimeAsync(1_500)
      await pending
      expect(state.done).toBe(true)
    })

    it('Retry-After 가 없으면 60초를 기다린다', async () => {
      // 모르면 짧게 잡는 쪽이 위험하다. 다시 맞으면 차단이 길어진다.
      const limiter = make()
      limiter.applyPenalty(null)

      const pending = limiter.acquire(1)
      const state = track(pending)

      await vi.advanceTimersByTimeAsync(59_000)
      expect(state.done).toBe(false)

      await vi.advanceTimersByTimeAsync(1_500)
      await pending
      expect(state.done).toBe(true)
    })

    it('페널티도 운영 지표로 알린다', () => {
      const seen: Record<string, unknown>[] = []
      make((detail) => seen.push(detail)).applyPenalty(10)

      expect(seen[0]).toMatchObject({ reason: 'penalty', waitMs: 10_000 })
    })
  })

  it('snapshot 이 사용 비율을 낸다 — 대시보드가 읽는 값이다', async () => {
    const limiter = make()
    await limiter.acquire(600)

    expect(limiter.snapshot()).toMatchObject({ used: 600, limit: LIMIT, ratio: 0.1 })
  })
})
