import {
  type BinanceRestClient,
  type Interval,
  type Logger,
  MAX_KLINES_PER_REQUEST,
  intervalToMs,
  planBackfillPages,
  resolveBackfillStart,
} from '@app/shared'
import { CHANNELS, type KlineRepository, type RealtimeBus } from '@app/db'

/**
 * 백필 서비스 — 이 프로젝트의 심장부.
 *
 * 과제의 두 요구사항("최초 실행 시 백필", "재시작 후 누락 구간 백필")과
 * 명시되지 않은 두 경우(WS 재연결 직후, 스캐너가 발견한 중간 구멍)까지
 * **전부 ensureRange 하나로 처리한다.** (docs/DECISIONS.md D-02)
 *
 * 네 상황의 차이는 from / to 값뿐이다.
 */

/** 백필이 호출된 맥락 — 이벤트 로그에 남아 대시보드에서 구분된다. */
export type BackfillReason =
  | 'initial' // 최초 실행 (DB 가 비어 있음)
  | 'restart' // 서버 재시작 후 갭
  | 'reconnect' // WS 재연결 직후
  | 'scanner' // 무결성 스캐너가 발견한 구멍

export interface BackfillResult {
  reason: BackfillReason
  fromMs: number
  toMs: number
  pages: number
  fetched: number
  written: number
  durationMs: number
}

export class BackfillService {
  constructor(
    private readonly rest: BinanceRestClient,
    private readonly repo: KlineRepository,
    private readonly bus: RealtimeBus,
    private readonly logger: Logger,
  ) {}

  /**
   * 부팅 시퀀스가 호출하는 진입점.
   *
   * **여기 있는 한 줄이 "최초 백필"과 "재시작 갭 백필"을 가른다.**
   * DB 에 물어본 답이 null 이냐 값이냐가 전부다.
   */
  async backfillFromLastKnown(
    symbol: string,
    interval: Interval,
    backfillDays: number,
    now = Date.now(),
  ): Promise<BackfillResult> {
    const lastOpenTime = await this.repo.getLastOpenTime(symbol, interval)
    const intervalMs = intervalToMs(interval)

    const fromMs = resolveBackfillStart({ lastOpenTime, now, backfillDays, intervalMs })
    const reason: BackfillReason = lastOpenTime === null ? 'initial' : 'restart'

    this.logger.info(
      lastOpenTime === null
        ? '최초 실행 — 과거 데이터를 백필합니다'
        : '재시작 감지 — 누락 구간을 백필합니다',
      {
        symbol,
        lastOpenTime: lastOpenTime === null ? null : new Date(lastOpenTime).toISOString(),
        fromMs: new Date(fromMs).toISOString(),
        gapMinutes: Math.round((now - fromMs) / 60_000),
      },
    )

    return this.ensureRange(symbol, interval, fromMs, now, reason)
  }

  /**
   * WS 재연결 직후 호출된다. 끊겨 있던 동안의 구멍을 메운다.
   *
   * 부팅 시퀀스와 로직이 같다 — DB 의 마지막 봉부터 지금까지 채운다.
   * 다른 것은 이벤트 로그에 남는 reason 뿐이며, 그 덕분에 대시보드에서
   * "재연결로 복구된 갭"과 "재시작으로 복구된 갭"을 구분할 수 있다.
   *
   * 끊긴 시각(disconnectedAt)이 아니라 **DB 의 마지막 봉**을 기준으로 삼는 이유:
   * 끊기기 직전 몇 초의 데이터가 저장에 실패했을 수도 있다. DB 를 진실로 삼으면
   * 그 경우까지 함께 복구된다.
   */
  async backfillFromLastKnownForReconnect(
    symbol: string,
    interval: Interval,
    now = Date.now(),
  ): Promise<BackfillResult> {
    const lastOpenTime = await this.repo.getLastOpenTime(symbol, interval)
    const intervalMs = intervalToMs(interval)

    // DB 가 비어 있는 상태에서 재연결된 경우는 사실상 없지만,
    // 그때도 안전하도록 최소 구간(직전 1시간)을 잡는다.
    const fromMs = lastOpenTime ?? now - 60 * intervalMs

    return this.ensureRange(symbol, interval, fromMs, now, 'reconnect')
  }

  /**
   * [fromMs, toMs] 구간의 캔들이 DB 에 존재하도록 보장한다.
   *
   * 이미 있는 봉을 다시 긁어도 안전하다 — UPSERT 가 멱등성을 보장하기 때문이다(D-03).
   * 그래서 구간을 여유 있게 겹쳐 잡아도 되고, 실제로 그렇게 쓴다.
   */
  async ensureRange(
    symbol: string,
    interval: Interval,
    fromMs: number,
    toMs: number,
    reason: BackfillReason,
  ): Promise<BackfillResult> {
    const startedAt = Date.now()
    const intervalMs = intervalToMs(interval)
    const pages = planBackfillPages(fromMs, toMs, intervalMs, MAX_KLINES_PER_REQUEST)

    const result: BackfillResult = {
      reason,
      fromMs,
      toMs,
      pages: pages.length,
      fetched: 0,
      written: 0,
      durationMs: 0,
    }

    // 채울 구간이 없다 — 이미 최신이다.
    if (pages.length === 0) {
      result.durationMs = Date.now() - startedAt
      return result
    }

    await this.repo.recordEvent('backfill_started', symbol, {
      reason,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      pages: pages.length,
      expectedCandles: pages.reduce((sum, page) => sum + page.expectedCount, 0),
    })

    for (const [index, page] of pages.entries()) {
      const candles = await this.rest.fetchKlines(
        symbol,
        interval,
        page.startTime,
        page.endTime,
        MAX_KLINES_PER_REQUEST,
      )

      if (candles.length === 0) {
        // 상장 이전 구간이거나 거래가 없던 구간. 정상적인 상황이므로 계속 진행한다.
        this.logger.debug('빈 페이지 — 건너뜀', {
          symbol,
          from: new Date(page.startTime).toISOString(),
        })
        continue
      }

      const written = await this.repo.upsertKlines(candles)
      result.fetched += candles.length
      result.written += written

      // 페이지가 여러 개면 진행 상황을 알린다 — 최초 백필은 수십 초가 걸린다.
      if (pages.length > 1) {
        this.logger.info('백필 진행', {
          symbol,
          page: `${index + 1}/${pages.length}`,
          candles: candles.length,
        })
      }
    }

    result.durationMs = Date.now() - startedAt

    await this.repo.recordEvent('backfill_completed', symbol, {
      reason,
      fetched: result.fetched,
      written: result.written,
      durationMs: result.durationMs,
    })

    // 마지막 봉 시각을 상태 테이블에 반영한다.
    const lastOpenTime = await this.repo.getLastOpenTime(symbol, interval)
    await this.repo.updateState(symbol, interval, { lastOpenTimeMs: lastOpenTime })

    this.logger.info('백필 완료', {
      symbol,
      reason,
      fetched: result.fetched,
      pages: result.pages,
      durationMs: result.durationMs,
    })

    // 대시보드가 즉시 갱신되도록 알린다.
    await this.bus
      .publish(CHANNELS.pipeline, { type: 'backfill_completed', symbol, ...result })
      .catch((error) => {
        // 알림 실패가 백필을 실패로 만들면 안 된다. 데이터는 이미 DB 에 있다.
        this.logger.warn('백필 완료 알림 발행 실패', {
          error: error instanceof Error ? error.message : String(error),
        })
      })

    return result
  }
}
