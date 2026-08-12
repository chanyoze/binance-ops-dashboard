import type { Interval, Kline, Logger, PipelineEventType } from '@app/shared'

/**
 * 수집기 테스트용 대역.
 *
 * 실제 Binance 와 Postgres 없이 **복구 로직만** 검증하기 위한 것이다.
 * 여기서 확인하려는 것은 "네트워크가 되는가"가 아니라
 * "구멍을 발견했을 때 무엇을 하는가" 이므로 외부는 전부 가짜로 둔다.
 *
 * 통합 테스트(`packages/db`)와 역할이 다르다 — 그쪽은 SQL 이 맞는지 보고,
 * 이쪽은 **판단이 맞는지** 본다.
 */

export function fakeLogger(): Logger {
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

export interface RecordedEvent {
  type: PipelineEventType
  symbol: string | null
  detail: Record<string, unknown>
}

/**
 * KlineRepository 대역 — 봉을 메모리 맵에 담는다.
 *
 * 키를 `(symbol, interval, openTime)` 으로 잡아 **실제 PK 와 같은 멱등성**을 흉내낸다.
 * 그래야 "같은 구간을 두 번 백필해도 늘지 않는다"를 여기서도 확인할 수 있다.
 */
export class FakeRepo {
  readonly candles = new Map<string, Kline>()
  readonly events: RecordedEvent[] = []
  readonly stateUpdates: Array<{ symbol: string; patch: Record<string, unknown> }> = []

  /** 다음 upsert 를 한 번 실패시킨다 (DB 일시 장애 재현) */
  failNextUpsert = false

  private key(symbol: string, interval: string, openTime: number): string {
    return `${symbol}|${interval}|${openTime}`
  }

  seed(rows: readonly Kline[]): void {
    for (const row of rows) {
      this.candles.set(this.key(row.symbol, row.interval, row.openTime), row)
    }
  }

  async upsertKlines(rows: readonly Kline[]): Promise<number> {
    if (this.failNextUpsert) {
      this.failNextUpsert = false
      throw new Error('DB 쓰기 실패 (테스트)')
    }
    for (const row of rows) {
      this.candles.set(this.key(row.symbol, row.interval, row.openTime), row)
    }
    return rows.length
  }

  async getLastOpenTime(symbol: string, interval: Interval): Promise<number | null> {
    const times = [...this.candles.values()]
      .filter((c) => c.symbol === symbol && c.interval === interval)
      .map((c) => c.openTime)
    return times.length === 0 ? null : Math.max(...times)
  }

  async getOpenTimes(
    symbol: string,
    interval: Interval,
    fromMs: number,
    toMs: number,
  ): Promise<number[]> {
    return [...this.candles.values()]
      .filter(
        (c) =>
          c.symbol === symbol &&
          c.interval === interval &&
          c.openTime >= fromMs &&
          c.openTime <= toMs,
      )
      .map((c) => c.openTime)
      .sort((a, b) => a - b)
  }

  async countInRange(
    symbol: string,
    interval: Interval,
    fromMs: number,
    toMs: number,
  ): Promise<number> {
    return (await this.getOpenTimes(symbol, interval, fromMs, toMs)).length
  }

  async recordEvent(
    type: PipelineEventType,
    symbol: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    this.events.push({ type, symbol, detail })
  }

  async updateState(
    symbol: string,
    _interval: Interval,
    patch: Record<string, unknown>,
  ): Promise<void> {
    this.stateUpdates.push({ symbol, patch })
  }

  eventsOfType(type: PipelineEventType): RecordedEvent[] {
    return this.events.filter((e) => e.type === type)
  }
}

/** RealtimeBus 대역 */
export class FakeBus {
  readonly published: Array<{ channel: string; payload: unknown }> = []
  failPublish = false

  async publish(channel: string, payload: unknown): Promise<void> {
    if (this.failPublish) throw new Error('NOTIFY 실패 (테스트)')
    this.published.push({ channel, payload })
  }

  async subscribe(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * BinanceRestClient 대역.
 *
 * 요청한 구간에 해당하는 봉을 생성해서 돌려준다 — 실제 API 처럼
 * "요청 구간 안의 봉"만 준다. 백필이 페이지를 어떻게 나누는지 검증하려면
 * 이 동작이 실제와 같아야 한다.
 */
export class FakeRestClient {
  readonly calls: Array<{ symbol: string; startTime: number; endTime: number }> = []

  /** 이 시각 이전에는 데이터가 없다고 응답한다 (상장 이전 구간 재현) */
  listedAt = 0
  /** 봉을 하나도 주지 않는다 */
  returnEmpty = false

  constructor(private readonly intervalMs = 60_000) {}

  async fetchKlines(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
    limit: number,
  ): Promise<Kline[]> {
    this.calls.push({ symbol, startTime, endTime })
    if (this.returnEmpty) return []

    const rows: Kline[] = []
    const first = Math.max(startTime, this.listedAt)

    for (let t = alignUp(first, this.intervalMs); t <= endTime; t += this.intervalMs) {
      if (rows.length >= limit) break
      rows.push(makeKline(symbol, interval as Interval, t, this.intervalMs, 'rest'))
    }
    return rows
  }
}

const alignUp = (ms: number, step: number): number => Math.ceil(ms / step) * step

export function makeKline(
  symbol: string,
  interval: Interval,
  openTime: number,
  intervalMs = 60_000,
  source: 'ws' | 'rest' = 'rest',
): Kline {
  return {
    symbol,
    interval,
    openTime,
    closeTime: openTime + intervalMs - 1,
    open: '100.00000000',
    high: '101.00000000',
    low: '99.00000000',
    close: '100.50000000',
    volume: '1.00000000',
    quoteVolume: '100.50000000',
    tradeCount: 10,
    takerBuyBase: '0.60000000',
    takerBuyQuote: '60.30000000',
    isClosed: true,
    source,
  }
}
