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
  /** 지금 화면이 보고 있는 해상도 */
  interval: Interval
  /** 수집기가 저장하는 원본 해상도. 이보다 작은 봉은 만들 수 없다. */
  baseInterval: Interval
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
  const { SYMBOLS, KLINE_INTERVAL } = getConfig()

  // 기본 해상도는 수집기가 저장하는 것과 같다. '1m' 을 박아 두면 수집 해상도를
  // 바꿨을 때 대시보드만 조용히 빈 차트를 그린다.
  const interval = options.interval ?? KLINE_INTERVAL
  const candleLimit = options.candleLimit ?? 120
  const relativeHours = options.relativeHours ?? 6
  const eventLimit = options.eventLimit ?? 30

  // 서로 의존하지 않는 조회다. 순서대로 기다릴 이유가 없다.
  const [ops, stats, coverage, relativeStrength, events, ...candleLists] = await Promise.all([
    analytics.getOpsSnapshot(),
    analytics.getMarketStats(SYMBOLS),
    analytics.getCoverage(SYMBOLS, KLINE_INTERVAL),
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
    baseInterval: KLINE_INTERVAL,
    ops,
    stats,
    coverage,
    candles,
    relativeStrength,
    events,
  }
}
