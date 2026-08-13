import {
  type AppConfig,
  type Interval,
  type Logger,
  alignToInterval,
  calculateCoverage,
  findGaps,
  intervalToMs,
} from '@app/shared'
import type { KlineRepository } from '@app/db'
import type { BackfillService } from './backfill-service.js'

/**
 * 무결성 스캐너 — 자가 치유의 마지막 방어선.
 *
 * 재연결 갭 복구(D-02)와 부팅 백필이 대부분을 막아주지만, 그 둘이 놓치는 경우가 있다.
 *  - DB 쓰기가 일시적으로 실패한 봉 (버퍼를 두지 않기로 했으므로 구멍으로 남는다, D-12)
 *  - Binance 가 일부 봉을 늦게 채워 넣는 경우
 *  - 우리가 아직 모르는 경우
 *
 * 그래서 "왜 구멍이 났는지" 묻지 않고 **주기적으로 훑어서 있으면 메운다.**
 * 원인별 대응 대신 상태 수렴(convergence)으로 푸는 쪽을 택했다.
 */

/** 한 번의 스캔에서 검사할 구간. 너무 길면 매 분 전체를 훑게 된다. */
const SCAN_WINDOW_HOURS = 24

/** 한 번에 복구할 구멍 개수 상한. 나머지는 다음 스캔에서 처리한다. */
const MAX_GAPS_PER_SCAN = 20

export class IntegrityScanner {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly config: AppConfig,
    private readonly repo: KlineRepository,
    private readonly backfill: BackfillService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.scanAll()
    }, this.config.INTEGRITY_SCAN_INTERVAL_MS)

    this.logger.info('무결성 스캐너 시작', {
      intervalMs: this.config.INTEGRITY_SCAN_INTERVAL_MS,
      windowHours: SCAN_WINDOW_HOURS,
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 모든 심볼을 훑는다. 이전 스캔이 아직 돌고 있으면 건너뛴다. */
  async scanAll(now = Date.now()): Promise<void> {
    if (this.running) {
      this.logger.debug('이전 스캔이 진행 중 — 이번 주기는 건너뜁니다')
      return
    }

    this.running = true
    try {
      // try 를 루프 **안쪽**에 두는 것이 요점이다. 바깥에 두면 첫 심볼이 던지는 순간
      // 나머지 심볼의 스캔이 그 주기째로 사라진다. 한 심볼의 실패가 지속되는 상황
      // (REST 429/451 지속, 특정 행의 제약 위반)에서는 다른 심볼의 구멍이 영원히
      // 복구되지 않는다 — 마지막 방어선이 첫 심볼 하나 때문에 무력화되는 셈이다.
      for (const symbol of this.config.SYMBOLS) {
        try {
          await this.scanSymbol(symbol, this.config.KLINE_INTERVAL, now)
        } catch (error) {
          this.logger.error('무결성 스캔 실패', {
            symbol,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      this.running = false
    }
  }

  /**
   * 심볼 하나를 검사하고 구멍을 메운다.
   * @returns 복구한 봉의 개수
   */
  async scanSymbol(symbol: string, interval: Interval, now = Date.now()): Promise<number> {
    const intervalMs = intervalToMs(interval)

    // 현재 진행 중인 봉은 아직 미완성이므로 검사 대상에서 뺀다.
    // 넣으면 매번 "마지막 봉이 없다"고 오탐한다.
    const toMs = alignToInterval(now, intervalMs) - intervalMs
    const fromMs = toMs - SCAN_WINDOW_HOURS * 60 * 60 * 1000

    const openTimes = await this.repo.getOpenTimes(symbol, interval, fromMs, toMs)

    // 데이터가 아예 없으면 스캐너가 관여할 일이 아니다 — 부팅 백필의 몫이다.
    if (openTimes.length === 0) return 0

    const gaps = findGaps(openTimes, intervalMs)
    const coverage = calculateCoverage(openTimes.length, openTimes[0]!, toMs, intervalMs)

    if (gaps.length === 0) {
      this.logger.debug('무결성 정상', { symbol, candles: openTimes.length, coverage })
      return 0
    }

    const totalMissing = gaps.reduce((sum, gap) => sum + gap.missingCount, 0)

    this.logger.warn('구멍 감지 — 복구를 시작합니다', {
      symbol,
      gaps: gaps.length,
      missingCandles: totalMissing,
      coverage: Number(coverage.toFixed(6)),
    })

    await this.repo.recordEvent('gap_detected', symbol, {
      gaps: gaps.length,
      missingCandles: totalMissing,
      coverage,
      ranges: gaps.slice(0, 5).map((gap) => ({
        from: new Date(gap.startTime).toISOString(),
        to: new Date(gap.endTime).toISOString(),
        missing: gap.missingCount,
      })),
    })

    let recovered = 0

    // 한 번에 전부 메우려 하면 rate limit 을 태운다. 나눠서 처리하고 나머지는 다음 주기로.
    for (const gap of gaps.slice(0, MAX_GAPS_PER_SCAN)) {
      const result = await this.backfill.ensureRange(
        symbol,
        interval,
        gap.startTime,
        gap.endTime,
        'scanner',
      )
      recovered += result.fetched
    }

    if (gaps.length > MAX_GAPS_PER_SCAN) {
      this.logger.info('구멍이 많아 이번 주기에는 일부만 복구했습니다', {
        symbol,
        처리: MAX_GAPS_PER_SCAN,
        남음: gaps.length - MAX_GAPS_PER_SCAN,
      })
    }

    this.logger.info('구멍 복구 완료', { symbol, recovered })
    return recovered
  }
}
