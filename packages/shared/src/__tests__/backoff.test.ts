import { describe, expect, it } from 'vitest'
import { applyJitter, calculateBackoffDelay, nextReconnectDelay } from '../backoff.js'

/**
 * 테스트 6 — 재연결 백오프.
 *
 * 상한이 없으면 몇 시간 뒤에나 재접속을 시도하게 되어 사실상 영영 복구하지 못한다.
 * "상한이 실제로 걸리는가"가 이 테스트의 존재 이유다. (docs/DECISIONS.md D-10 #6)
 */
describe('calculateBackoffDelay — 지수 증가 후 상한에서 고정', () => {
  it('1s 부터 2배씩 증가한다', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => calculateBackoffDelay(attempt, 1_000, 30_000))

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('상한(30s)을 넘지 않는다', () => {
    expect(calculateBackoffDelay(6, 1_000, 30_000)).toBe(30_000)
    expect(calculateBackoffDelay(7, 1_000, 30_000)).toBe(30_000)
    expect(calculateBackoffDelay(100, 1_000, 30_000)).toBe(30_000)
  })

  it('시도 횟수가 아무리 커져도 유한한 값을 유지한다 (오버플로 방지)', () => {
    const delay = calculateBackoffDelay(1_000_000, 1_000, 30_000)

    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBe(30_000)
  })

  it('attempt 는 1부터 시작한다 — 0 이하는 프로그래밍 오류로 간주해 즉시 실패시킨다', () => {
    expect(() => calculateBackoffDelay(0, 1_000, 30_000)).toThrow()
    expect(() => calculateBackoffDelay(-1, 1_000, 30_000)).toThrow()
  })
})

/**
 * jitter 는 워커를 여러 개로 확장했을 때 동시 재접속(thundering herd)을 막기 위한 장치다.
 * 난수를 주입 가능하게 만들어 결정론적으로 검증한다.
 */
describe('applyJitter — 대기 시간을 [delay*(1-ratio), delay] 범위로 흩는다', () => {
  it('난수가 0이면 원래 값 그대로', () => {
    expect(applyJitter(10_000, 0.2, () => 0)).toBe(10_000)
  })

  it('난수가 1이면 최대로 당겨진다 (20% 감소)', () => {
    expect(applyJitter(10_000, 0.2, () => 1)).toBe(8_000)
  })

  it('난수가 0.5면 중간값', () => {
    expect(applyJitter(10_000, 0.2, () => 0.5)).toBe(9_000)
  })

  it('어떤 난수에도 원래 값을 넘지 않는다', () => {
    for (const r of [0, 0.13, 0.5, 0.77, 0.999, 1]) {
      const jittered = applyJitter(30_000, 0.2, () => r)

      expect(jittered).toBeLessThanOrEqual(30_000)
      expect(jittered).toBeGreaterThanOrEqual(24_000)
    }
  })
})

describe('nextReconnectDelay — 실사용 진입점', () => {
  it('지수 백오프와 지터가 함께 적용된다', () => {
    // attempt 3 -> 4,000ms, 난수 1 -> 20% 감소 -> 3,200ms
    expect(nextReconnectDelay(3, 1_000, 30_000, () => 1)).toBe(3_200)
  })

  it('상한 이후에도 지터 범위를 유지한다', () => {
    const delay = nextReconnectDelay(50, 1_000, 30_000, () => 0.5)

    expect(delay).toBe(27_000)
  })
})
