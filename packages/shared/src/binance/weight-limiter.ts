import { sleep } from '../backoff.js'
import type { Logger } from '../logger.js'

/**
 * Binance REST weight 가드. (docs/DECISIONS.md D-06)
 *
 * 제약: IP당 6,000 weight / 분. 초과하면 429, 무시하고 계속 때리면 418 -> IP 밴.
 * 백필은 순간적으로 REST 를 집중 호출하는 구간이라 여기서 밴을 당하면 시연 자체가 불가능해진다.
 * 그래서 보수적으로 설계했다.
 *
 * 자체 카운터만 믿지 않고 응답 헤더 `x-mbx-used-weight-1m` 으로 실제 값을 보정한다.
 * 같은 IP 에서 다른 프로세스가 API 를 쓰고 있을 수 있기 때문이다.
 */
export class WeightLimiter {
  private windowStart = 0
  private used = 0
  private penaltyUntil = 0

  constructor(
    private readonly limitPerMin: number,
    private readonly softThreshold: number,
    private readonly logger: Logger,
    private readonly onThrottle?: (detail: Record<string, unknown>) => void,
  ) {}

  /** 요청 직전에 호출한다. 여유가 없으면 확보될 때까지 대기한다. */
  async acquire(weight: number): Promise<void> {
    for (;;) {
      const now = Date.now()

      // 429/418 페널티 구간이면 무조건 기다린다.
      if (now < this.penaltyUntil) {
        const waitMs = this.penaltyUntil - now
        this.logger.warn('rate limit 페널티 대기', { waitMs })
        await sleep(waitMs)
        continue
      }

      this.rollWindowIfNeeded(now)

      const ceiling = this.limitPerMin * this.softThreshold
      if (this.used + weight <= ceiling) {
        this.used += weight
        return
      }

      // 다음 분 경계까지 대기하면 Binance 카운터가 리셋된다.
      const waitMs = this.windowStart + 60_000 - now + 50
      this.logger.warn('weight 임계 도달 — 다음 분까지 대기', {
        used: this.used,
        ceiling,
        waitMs,
      })
      this.onThrottle?.({ reason: 'soft_threshold', used: this.used, ceiling, waitMs })
      await sleep(waitMs)
    }
  }

  /** 응답 헤더로 실제 사용량을 보정한다. */
  observeHeader(usedWeight: number | null): void {
    if (usedWeight === null || Number.isNaN(usedWeight)) return
    this.rollWindowIfNeeded(Date.now())
    // 서버가 알려준 값이 항상 진실이다. 단, 우리 카운터가 더 크면 보수적으로 큰 쪽을 유지한다.
    this.used = Math.max(this.used, usedWeight)
  }

  /** 429/418 수신 시 호출. Retry-After 를 존중한다. */
  applyPenalty(retryAfterSeconds: number | null): void {
    const waitMs = (retryAfterSeconds ?? 60) * 1000
    this.penaltyUntil = Date.now() + waitMs
    this.logger.error('Binance rate limit 위반 — 페널티 적용', { waitMs })
    this.onThrottle?.({ reason: 'penalty', waitMs })
  }

  /** 대시보드 운영 지표로 노출된다. */
  snapshot(): { used: number; limit: number; ratio: number } {
    this.rollWindowIfNeeded(Date.now())
    return {
      used: this.used,
      limit: this.limitPerMin,
      ratio: this.used / this.limitPerMin,
    }
  }

  private rollWindowIfNeeded(now: number): void {
    const currentWindow = Math.floor(now / 60_000) * 60_000
    if (currentWindow !== this.windowStart) {
      this.windowStart = currentWindow
      this.used = 0
    }
  }
}
