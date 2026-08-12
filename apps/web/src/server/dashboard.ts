import type {
  Candle,
  CoverageStat,
  Interval,
  MarketStats,
  OpsSnapshot,
  PipelineEvent,
  RelativeStrengthPoint,
} from '@app/shared'
import { getAnalytics, getConfig } from './db.js'

/**
 * 대시보드 초기 로드 페이로드.
 *
 * 화면이 뜰 때 필요한 것을 **한 번에** 내려보낸다. 조각마다 요청을 나누면
 * 패널들이 서로 다른 시각의 데이터를 들고 있게 되는데, 운영 대시보드에서
 * "Data Lag 는 0.4초인데 커버리지는 3초 전 값"인 상태는 그 자체로 거짓말이다.
 * 이후 갱신은 SSE 가 맡는다.
 */
export interface DashboardPayload {
  /** 서버 시각. 클라이언트 시계를 믿지 않고 이 값으로 경과를 계산한다. */
  at: number
  symbols: string[]
  interval: Interval
  ops: OpsSnapshot
  stats: MarketStats[]
  coverage: CoverageStat[]
  candles: Record<string, Candle[]>
  relativeStrength: RelativeStrengthPoint[]
  events: PipelineEvent[]
}

export interface DashboardOptions {
  interval?: Interval
  candleLimit?: number
  relativeHours?: number
  eventLimit?: number
}

export async function buildDashboardPayload(
  options: DashboardOptions = {},
): Promise<DashboardPayload> {
  const analytics = getAnalytics()
  const { SYMBOLS } = getConfig()

  const interval = options.interval ?? '1m'
  const candleLimit = options.candleLimit ?? 120
  const relativeHours = options.relativeHours ?? 6
  const eventLimit = options.eventLimit ?? 30

  // 서로 의존하지 않는 조회다. 순서대로 기다릴 이유가 없다.
  const [ops, stats, coverage, relativeStrength, events, ...candleLists] = await Promise.all([
    analytics.getOpsSnapshot(),
    analytics.getMarketStats(SYMBOLS),
    analytics.getCoverage(SYMBOLS, '1m'),
    analytics.getRelativeStrength(SYMBOLS, relativeHours),
    analytics.getRecentEvents(eventLimit),
    ...SYMBOLS.map((symbol) => analytics.getCandles(symbol, interval, candleLimit)),
  ])

  const candles: Record<string, Candle[]> = {}
  SYMBOLS.forEach((symbol, i) => {
    candles[symbol] = candleLists[i] ?? []
  })

  return {
    at: ops.at,
    symbols: [...SYMBOLS],
    interval,
    ops,
    stats,
    coverage,
    candles,
    relativeStrength,
    events,
  }
}
