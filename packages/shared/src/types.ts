/** 지원 인터벌과 밀리초 환산 */
export const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
} as const

export type Interval = keyof typeof INTERVAL_MS

export function intervalToMs(interval: Interval): number {
  return INTERVAL_MS[interval]
}

/**
 * 정규화된 캔들 한 개.
 *
 * 가격/수량은 전부 문자열로 다룬다. JS number 는 배정밀도 부동소수라
 * 큰 값과 소수점이 섞인 시세를 정확히 표현하지 못한다.
 * Postgres NUMERIC 컬럼과 문자열로 주고받아 정밀도 손실을 원천 차단한다.
 */
export interface Kline {
  symbol: string
  interval: Interval
  /** 봉 시작 시각 (epoch ms, UTC) — PK의 일부 */
  openTime: number
  closeTime: number
  open: string
  high: string
  low: string
  close: string
  /** 기초자산 거래량 (예: BTC 수량) */
  volume: string
  /** 견적자산 거래대금 (예: USDT 금액) */
  quoteVolume: string
  tradeCount: number
  /**
   * Taker 매수 거래량 — 시장가로 밀어붙인 매수 물량.
   * Binance 가 집계해서 주므로 개별 체결(aggTrade)을 저장할 필요가 없다. (D-08)
   */
  takerBuyBase: string
  takerBuyQuote: string
  /** 봉이 확정되었는가. WS 로 받은 진행 중 봉은 false. */
  isClosed: boolean
  /** 이 행이 어디서 왔는가 — 백필이 실제로 동작했음을 데이터로 증명한다. (D-03) */
  source: KlineSource
}

export type KlineSource = 'ws' | 'rest'

/** 파이프라인 운영 이벤트 — 그대로 대시보드 운영 지표가 된다. */
export type PipelineEventType =
  | 'connected'
  | 'disconnected'
  | 'stale_detected'
  | 'reconnecting'
  | 'gap_detected'
  | 'backfill_started'
  | 'backfill_completed'
  | 'rate_limit_throttled'
  | 'error'

export interface PipelineEvent {
  ts: Date
  symbol: string | null
  type: PipelineEventType
  detail: Record<string, unknown>
}

/** 심볼별 수집기 상태 — 재시작 시 백필 시작점을 결정하는 근거이자 운영 지표. */
export interface CollectorState {
  symbol: string
  interval: Interval
  lastOpenTime: number | null
  /** aggTrade 로 갱신되는 틱 최신가. 저장하지 않고 이 한 행만 갱신한다. (D-08) */
  lastPrice: string | null
  lastPriceAt: Date | null
  /** 마지막으로 WS 메시지를 받은 시각 — Data Lag 지표의 원천 */
  lastMessageAt: Date | null
  wsConnectedSince: Date | null
  reconnectCount: number
}

/** SSE 로 브라우저에 밀어주는 실시간 페이로드 */
export type RealtimeMessage =
  | { channel: 'kline'; symbol: string; kline: Kline }
  | { channel: 'ticker'; symbol: string; price: string; at: number }
  | { channel: 'pipeline'; event: PipelineEvent }
