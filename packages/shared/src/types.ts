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

/* ============================================================
 *  대시보드 조회 결과 (읽기 경로)
 *
 *  쓰기 경로(Kline / CollectorState)와 타입을 나눈다. 수집기가 넣는 모양과
 *  화면이 읽는 모양은 애초에 다른 것이고, 하나로 합치면 한쪽 요구가 다른 쪽을
 *  오염시킨다. 집계는 전부 SQL 에서 끝내므로(D-07) 여기 오는 값은 이미 완성형이다.
 * ============================================================ */

/**
 * 차트에 그릴 봉 하나. 원본 1분봉을 요청 인터벌로 접은 결과다.
 *
 * 가격·수량은 여전히 문자열이다 — 집계를 거쳤다고 정밀도 규칙이 달라지지 않는다.
 */
export interface Candle {
  openTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  quoteVolume: string
  tradeCount: number
  takerBuyQuote: string
  /** 이동평균. 구간이 아직 안 찬 앞부분은 null 이라 선이 끊긴다. */
  ma: string | null
  /** 이 봉에 REST 백필분이 섞였는가 — 자가 치유의 흔적을 차트에서 보여준다 */
  hasBackfill: boolean
  /** 확정된 봉인가. 마지막 봉은 보통 진행 중이다. */
  isClosed: boolean
}

/** 심볼 하나의 24시간 요약 — stat tile 이 그대로 읽는다 */
export interface MarketStats {
  symbol: string
  last: string
  open24h: string
  high24h: string
  low24h: string
  volume: string
  quoteVolume: string
  tradeCount: number
  /** 0~1. 0.5 가 매수·매도 균형이고, 화면은 이 기준선을 중심으로 그린다 */
  takerBuyRatio: number
  vwap: string
  changePct: number
  candleCount: number
}

/** 데이터 완전성 SLA — 기대 봉 수 대비 실제 적재 수 */
export interface CoverageStat {
  symbol: string
  interval: Interval
  actual: number
  expected: number
  pct: number
  /** 실시간 수집분 / 백필분. 둘의 비가 곧 "백필이 동작했다"는 증거다 */
  wsCount: number
  restCount: number
  firstOpenTime: number | null
  lastOpenTime: number | null
}

/** 상대 강도 한 점 — 구간 시작을 100 으로 지수화한 값 (D-07, 이중 축 회피) */
export interface RelativeStrengthPoint {
  openTime: number
  /** symbol -> 지수값. 시작점이 100 이다. */
  values: Record<string, number>
}

/** 심볼별 실시간 상태 */
export interface SymbolLiveState {
  symbol: string
  lastPrice: string | null
  lastPriceAt: number | null
  lastOpenTime: number | null
  /** 이 심볼의 마지막 수신으로부터 흐른 시간 (초) */
  lagSeconds: number | null
}

/**
 * 파이프라인 운영 스냅샷 — 대시보드 헬스 밴드가 통째로 읽는 객체.
 *
 * lagSeconds 가 이 화면의 Hero 다. 이 값이 틀어지면 나머지 지표가 전부
 * 거짓말이 되므로, 다른 무엇보다 먼저 읽혀야 한다. (docs/DESIGN.md §7)
 */
export interface OpsSnapshot {
  /** 스냅샷을 뜬 서버 시각. 클라이언트 시계를 믿지 않기 위해 함께 보낸다. */
  at: number
  connected: boolean
  lagSeconds: number | null
  uptimeMs: number | null
  reconnectCount: number
  lastError: string | null
  symbols: SymbolLiveState[]
  /** 갭 복구로 메운 봉 수 — 최초 적재(reason=initial)는 제외한다 */
  recoveredCandles: number
  recoveryRuns: number
  /** 최근 봉들의 체결 수에서 환산한 유입량 (건/초) */
  tradeRate: number
}

/** SSE 로 브라우저에 밀어주는 실시간 페이로드 */
export type RealtimeMessage =
  | { channel: 'kline'; symbol: string; kline: Kline }
  | { channel: 'ticker'; symbol: string; price: string; at: number }
  | { channel: 'pipeline'; event: PipelineEvent }
