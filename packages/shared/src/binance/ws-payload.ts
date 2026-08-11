import type { Interval, Kline } from '../types.js'

/**
 * Binance WebSocket 페이로드 파서.
 *
 * combined stream 은 모든 메시지를 { stream, data } 로 감싸서 보낸다.
 * 파싱을 순수 함수로 분리해두면 수집기 로직을 네트워크 없이 테스트할 수 있다.
 */

interface CombinedMessage {
  stream?: string
  data?: unknown
}

interface RawKlineEvent {
  e: 'kline'
  E: number
  s: string
  k: {
    t: number // 봉 시작 시각
    T: number // 봉 종료 시각
    s: string
    i: Interval
    o: string
    c: string
    h: string
    l: string
    v: string // 기초자산 거래량
    n: number // 체결 건수
    x: boolean // 봉 확정 여부
    q: string // 견적자산 거래대금
    V: string // taker 매수 기초자산 거래량
    Q: string // taker 매수 견적자산 거래대금
  }
}

interface RawAggTradeEvent {
  e: 'aggTrade'
  E: number
  s: string
  p: string // 체결가
  q: string // 체결 수량
  T: number // 체결 시각
  m: boolean // 매수자가 maker 인가
}

export type ParsedMessage =
  | { kind: 'kline'; kline: Kline }
  | { kind: 'trade'; symbol: string; price: string; quantity: string; tradeTime: number; isBuyerMaker: boolean }
  | { kind: 'unknown' }

/**
 * 원시 WS 메시지를 파싱한다. 알 수 없는 메시지는 조용히 'unknown' 으로 흘린다 —
 * Binance 가 새 필드나 새 이벤트를 추가해도 수집기가 죽지 않아야 한다.
 */
export function parseWsMessage(raw: string): ParsedMessage {
  let payload: unknown

  try {
    payload = JSON.parse(raw)
  } catch {
    return { kind: 'unknown' }
  }

  // combined stream 래퍼를 벗긴다.
  const envelope = payload as CombinedMessage
  const event = (envelope.data ?? payload) as { e?: string }

  if (event?.e === 'kline') {
    return { kind: 'kline', kline: parseWsKline(event as RawKlineEvent) }
  }

  if (event?.e === 'aggTrade') {
    const trade = event as RawAggTradeEvent
    return {
      kind: 'trade',
      symbol: trade.s,
      price: trade.p,
      quantity: trade.q,
      tradeTime: trade.T,
      isBuyerMaker: trade.m,
    }
  }

  return { kind: 'unknown' }
}

/**
 * WS kline 이벤트를 정규화한다.
 *
 * 주의: 1분봉은 1분에 한 번 오는 게 아니라, 진행 중인 봉이 매초 갱신되며 계속 온다.
 * 마지막에 x=true 로 확정된다. UPSERT 가 이 갱신 흐름을 그대로 흡수하므로
 * "진행 중 봉"과 "확정 봉"을 구분하는 별도 로직이 필요 없다. (docs/DECISIONS.md D-03)
 */
export function parseWsKline(event: RawKlineEvent): Kline {
  const k = event.k

  return {
    symbol: k.s,
    interval: k.i,
    openTime: k.t,
    closeTime: k.T,
    open: k.o,
    high: k.h,
    low: k.l,
    close: k.c,
    volume: k.v,
    quoteVolume: k.q,
    tradeCount: k.n,
    takerBuyBase: k.V,
    takerBuyQuote: k.Q,
    isClosed: k.x,
    source: 'ws',
  }
}

/**
 * combined stream URL 을 만든다.
 *
 * 심볼이 늘어나도 이 함수만으로 대응된다. Binance 는 연결당 스트림 수에 제한이 있어,
 * 확장 시에는 여기서 심볼을 나눠 여러 연결로 쪼개게 된다. (D-01 확장 경로)
 */
export function buildStreamUrl(baseUrl: string, symbols: readonly string[], interval: Interval): string {
  const streams = symbols.flatMap((symbol) => {
    const lower = symbol.toLowerCase()
    return [`${lower}@kline_${interval}`, `${lower}@aggTrade`]
  })

  return `${baseUrl.replace(/\/$/, '')}/stream?streams=${streams.join('/')}`
}
