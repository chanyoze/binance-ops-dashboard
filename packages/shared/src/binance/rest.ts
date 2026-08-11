import { nextReconnectDelay, sleep } from '../backoff.js'
import type { Logger } from '../logger.js'
import type { Interval, Kline } from '../types.js'
import type { WeightLimiter } from './weight-limiter.js'

/**
 * `GET /api/v3/klines` 의 weight. 문서상 2 이며, 실제 값은 응답 헤더로 보정한다.
 * 상수를 틀리게 잡아도 헤더 보정이 흡수하도록 설계했다.
 */
const KLINES_WEIGHT = 2

/** Binance 1회 조회 상한 */
export const MAX_KLINES_PER_REQUEST = 1000

/** klines 응답은 배열의 배열로 온다. 인덱스 의미를 상수로 고정해 오독을 막는다. */
const enum K {
  OpenTime = 0,
  Open = 1,
  High = 2,
  Low = 3,
  Close = 4,
  Volume = 5,
  CloseTime = 6,
  QuoteVolume = 7,
  TradeCount = 8,
  TakerBuyBase = 9,
  TakerBuyQuote = 10,
}

type RawKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
]

export interface BinanceRestOptions {
  baseUrl: string
  limiter: WeightLimiter
  logger: Logger
  maxRetries?: number
}

export class BinanceRestClient {
  private readonly maxRetries: number

  constructor(private readonly options: BinanceRestOptions) {
    this.maxRetries = options.maxRetries ?? 5
  }

  /**
   * 지정 구간의 캔들을 가져온다. 양 끝 모두 포함(inclusive).
   *
   * 반환된 캔들에는 `source: 'rest'` 가 찍힌다 — 백필로 채워진 행과
   * 실시간 수집 행을 구분해, 백필이 실제로 동작했음을 데이터로 증명하기 위함이다. (D-03)
   */
  async fetchKlines(
    symbol: string,
    interval: Interval,
    startTime: number,
    endTime: number,
    limit = MAX_KLINES_PER_REQUEST,
  ): Promise<Kline[]> {
    const url = new URL('/api/v3/klines', this.options.baseUrl)
    url.searchParams.set('symbol', symbol)
    url.searchParams.set('interval', interval)
    url.searchParams.set('startTime', String(startTime))
    url.searchParams.set('endTime', String(endTime))
    url.searchParams.set('limit', String(Math.min(limit, MAX_KLINES_PER_REQUEST)))

    const raw = await this.request<RawKline[]>(url, KLINES_WEIGHT)

    return raw.map((row) => parseRestKline(row, symbol, interval))
  }

  /** 서버 시각 — 로컬 시계가 틀어졌을 때를 대비한 보정용. */
  async fetchServerTime(): Promise<number> {
    const url = new URL('/api/v3/time', this.options.baseUrl)
    const body = await this.request<{ serverTime: number }>(url, 1)
    return body.serverTime
  }

  /**
   * 공통 요청 처리 — weight 확보, 재시도, 429/418 페널티, 헤더 보정을 한곳에서 담당한다.
   */
  private async request<T>(url: URL, weight: number): Promise<T> {
    const { limiter, logger } = this.options
    let lastError: unknown = null

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await limiter.acquire(weight)

      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        })

        limiter.observeHeader(parseIntOrNull(response.headers.get('x-mbx-used-weight-1m')))

        // 429 = rate limit 초과, 418 = 밴. 둘 다 Retry-After 를 존중해야 한다.
        if (response.status === 429 || response.status === 418) {
          limiter.applyPenalty(parseIntOrNull(response.headers.get('retry-after')))
          lastError = new Error(`Binance rate limit: HTTP ${response.status}`)
          continue
        }

        // 5xx 는 일시적 장애로 보고 재시도한다.
        if (response.status >= 500) {
          lastError = new Error(`Binance 서버 오류: HTTP ${response.status}`)
          logger.warn('Binance 5xx — 재시도', { status: response.status, attempt })
          await sleep(nextReconnectDelay(attempt, 500, 8_000))
          continue
        }

        // 4xx 는 우리 요청이 잘못된 것이므로 재시도해봐야 의미가 없다.
        if (!response.ok) {
          const body = await response.text()
          throw new Error(`Binance 요청 실패: HTTP ${response.status} ${body.slice(0, 200)}`)
        }

        return (await response.json()) as T
      } catch (error) {
        // 요청 자체가 잘못된 경우(4xx)는 위에서 throw 되어 여기로 오지 않는다.
        if (error instanceof Error && error.message.startsWith('Binance 요청 실패')) throw error

        lastError = error
        logger.warn('Binance 요청 오류 — 재시도', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(nextReconnectDelay(attempt, 500, 8_000))
      }
    }

    throw new Error(
      `Binance 요청이 ${this.maxRetries}회 모두 실패했습니다: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }
}

/** REST 응답 한 행을 정규화된 Kline 으로 변환한다. */
export function parseRestKline(row: RawKline, symbol: string, interval: Interval): Kline {
  return {
    symbol,
    interval,
    openTime: row[K.OpenTime],
    closeTime: row[K.CloseTime],
    open: row[K.Open],
    high: row[K.High],
    low: row[K.Low],
    close: row[K.Close],
    volume: row[K.Volume],
    quoteVolume: row[K.QuoteVolume],
    tradeCount: row[K.TradeCount],
    takerBuyBase: row[K.TakerBuyBase],
    takerBuyQuote: row[K.TakerBuyQuote],
    // REST 로 가져온 봉은 이미 확정된 과거 봉이다.
    // 단, 현재 진행 중인 봉이 섞여 올 수 있으므로 종료 시각으로 판별한다.
    isClosed: row[K.CloseTime] < Date.now(),
    source: 'rest',
  }
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}
