import { describe, expect, it } from 'vitest'
import { parseRestKline } from '../binance/rest.js'
import { buildStreamUrl, parseWsKline, parseWsMessage } from '../binance/ws-payload.js'

/**
 * Binance 응답 파싱 — **타입이 닿지 않는 경계.**
 *
 * 이 프로젝트는 `sql<Date>` 사건에서 "타입은 경계 안쪽을 지키고, 경계에는 테스트를
 * 둬야 한다"를 배웠다. 그런데 정작 가장 큰 경계인 여기에 테스트가 없었다.
 *
 * 여기가 특히 위험한 이유는 **틀려도 조용하기 때문**이다.
 *  - REST 는 배열을 **인덱스**로 읽는다 (`row[9]`, `row[10]`)
 *  - WS 는 **한 글자 키**로 읽는다 (`k.v`, `k.q`, `k.V`, `k.Q`)
 * 둘 중 하나를 바꿔 써도 타입은 통과하고, 파싱도 성공하고, 저장도 된다.
 * 화면에는 그럴듯한 숫자가 뜬다. 잘못됐다는 신호가 어디에도 없다.
 *
 * 그래서 픽스처의 값을 전부 다르게 둔다 — 하나라도 뒤바뀌면 즉시 드러나도록.
 */

const SYMBOL = 'BTCUSDT'
const OPEN_TIME = 1_700_000_000_000
const CLOSE_TIME = OPEN_TIME + 59_999

/**
 * 값을 일부러 전부 다르게 잡는다.
 * `volume`/`quoteVolume`, `takerBuyBase`/`takerBuyQuote` 처럼 짝을 이루는 필드가
 * 뒤바뀌는 것이 이 파서에서 가장 흔한 사고인데, 값이 같으면 그것을 못 잡는다.
 */
const FIXTURE = {
  open: '100.10',
  high: '100.90',
  low: '99.50',
  close: '100.40',
  volume: '11.0',
  quoteVolume: '22.0',
  tradeCount: 33,
  takerBuyBase: '44.0',
  takerBuyQuote: '55.0',
} as const

type RawRow = Parameters<typeof parseRestKline>[0]

/** Binance `/api/v3/klines` 응답 한 행의 실제 배열 순서 그대로. */
const restRow = (closeTime = CLOSE_TIME): RawRow =>
  [
    OPEN_TIME,
    FIXTURE.open,
    FIXTURE.high,
    FIXTURE.low,
    FIXTURE.close,
    FIXTURE.volume,
    closeTime,
    FIXTURE.quoteVolume,
    FIXTURE.tradeCount,
    FIXTURE.takerBuyBase,
    FIXTURE.takerBuyQuote,
    '0', // 사용하지 않는 자리
  ] as RawRow

/** `<symbol>@kline_1m` 이벤트의 실제 키 이름 그대로. */
const wsEvent = (isClosed = true) => ({
  e: 'kline' as const,
  E: OPEN_TIME + 1,
  s: SYMBOL,
  k: {
    t: OPEN_TIME,
    T: CLOSE_TIME,
    s: SYMBOL,
    i: '1m' as const,
    o: FIXTURE.open,
    c: FIXTURE.close,
    h: FIXTURE.high,
    l: FIXTURE.low,
    v: FIXTURE.volume,
    n: FIXTURE.tradeCount,
    x: isClosed,
    q: FIXTURE.quoteVolume,
    V: FIXTURE.takerBuyBase,
    Q: FIXTURE.takerBuyQuote,
  },
})

describe('parseRestKline — 배열 인덱스', () => {
  it('각 필드를 제 자리에서 읽는다', () => {
    const kline = parseRestKline(restRow(), SYMBOL, '1m')

    expect(kline).toMatchObject({
      symbol: SYMBOL,
      interval: '1m',
      openTime: OPEN_TIME,
      closeTime: CLOSE_TIME,
      ...FIXTURE,
      source: 'rest',
    })
  })

  it('거래량과 거래대금을 뒤바꾸지 않는다', () => {
    // 이 둘은 인덱스가 5 와 7 로 떨어져 있고 타입도 같다. 바꿔 써도 아무도 모른다.
    const kline = parseRestKline(restRow(), SYMBOL, '1m')

    expect(kline.volume).toBe(FIXTURE.volume)
    expect(kline.quoteVolume).toBe(FIXTURE.quoteVolume)
    expect(kline.volume).not.toBe(kline.quoteVolume)
  })

  it('taker 매수 기초자산과 견적자산을 뒤바꾸지 않는다', () => {
    // 뒤바뀌면 Taker 매수 비율이 통째로 틀리는데, 화면에는 그럴듯한 숫자가 뜬다.
    const kline = parseRestKline(restRow(), SYMBOL, '1m')

    expect(kline.takerBuyBase).toBe(FIXTURE.takerBuyBase)
    expect(kline.takerBuyQuote).toBe(FIXTURE.takerBuyQuote)
  })

  it('가격을 문자열 그대로 둔다 — number 로 내리지 않는다', () => {
    // number 로 바뀌면 시세에 부동소수 오차가 생기고, 그 오차는 조용하다.
    const kline = parseRestKline(restRow(), SYMBOL, '1m')

    for (const value of [kline.open, kline.high, kline.low, kline.close, kline.volume]) {
      expect(typeof value).toBe('string')
    }
  })

  it('종료 시각이 지났으면 확정 봉으로 본다', () => {
    const past = parseRestKline(restRow(Date.now() - 60_000), SYMBOL, '1m')
    expect(past.isClosed).toBe(true)
  })

  it('아직 진행 중인 봉은 확정으로 보지 않는다', () => {
    // REST 응답에는 현재 진행 중인 봉이 섞여 온다. 이것을 확정으로 저장하면
    // 미완성 값이 확정본으로 굳어 UPSERT 가 다시 덮을 기회를 잃는다.
    const ongoing = parseRestKline(restRow(Date.now() + 60_000), SYMBOL, '1m')
    expect(ongoing.isClosed).toBe(false)
  })
})

describe('parseWsKline — 한 글자 키', () => {
  it('각 필드를 제 키에서 읽는다', () => {
    const kline = parseWsKline(wsEvent())

    expect(kline).toMatchObject({
      symbol: SYMBOL,
      interval: '1m',
      openTime: OPEN_TIME,
      closeTime: CLOSE_TIME,
      ...FIXTURE,
      isClosed: true,
      source: 'ws',
    })
  })

  it('v/q 와 V/Q 를 구분한다 — 대소문자만 다른 키다', () => {
    // `v`(거래량)와 `V`(taker 매수 거래량)는 글자 하나 차이다. 사람이 가장 틀리기 쉽고
    // 틀려도 타입은 통과한다.
    const kline = parseWsKline(wsEvent())

    expect(kline.volume).toBe(FIXTURE.volume)
    expect(kline.takerBuyBase).toBe(FIXTURE.takerBuyBase)
    expect(kline.quoteVolume).toBe(FIXTURE.quoteVolume)
    expect(kline.takerBuyQuote).toBe(FIXTURE.takerBuyQuote)
  })

  it('진행 중인 봉을 그대로 전달한다', () => {
    // 1분봉은 매초 갱신되며 오고 마지막에 x=true 로 확정된다.
    // 진행 중 봉을 버리면 화면이 1분마다 한 번씩만 움직인다.
    expect(parseWsKline(wsEvent(false)).isClosed).toBe(false)
  })
})

describe('REST 와 WS 는 같은 봉을 같은 값으로 만든다', () => {
  it('source 와 isClosed 를 빼면 완전히 같다', () => {
    // **이 테스트가 이 파일의 핵심이다.**
    //
    // 두 파서가 어긋나면 WS 가 저장한 봉을 백필이 다른 값으로 덮어쓴다.
    // 그러면 "같은 구간을 몇 번을 다시 긁어도 안전하다"는 UPSERT 멱등성이 깨지고,
    // ensureRange 하나로 네 가지 복구 경로를 처리하는 설계 전체가 무너진다.
    // 게다가 그 붕괴는 조용하다 — 오류 없이 값만 달라진다.
    const { source: _rs, isClosed: _ri, ...fromRest } = parseRestKline(restRow(), SYMBOL, '1m')
    const { source: _ws, isClosed: _wi, ...fromWs } = parseWsKline(wsEvent())

    expect(fromRest).toEqual(fromWs)
  })

  it('출처만 서로 다르게 표시한다', () => {
    // source 는 복구가 실제로 일어났다는 증거로 화면에 쓰인다. 여기가 같아지면
    // "어느 봉을 백필이 메웠는가"를 데이터로 보여줄 수 없다.
    expect(parseRestKline(restRow(), SYMBOL, '1m').source).toBe('rest')
    expect(parseWsKline(wsEvent()).source).toBe('ws')
  })
})

describe('parseWsMessage', () => {
  it('combined stream 래퍼를 벗긴다', () => {
    const raw = JSON.stringify({ stream: 'btcusdt@kline_1m', data: wsEvent() })
    const parsed = parseWsMessage(raw)

    expect(parsed.kind).toBe('kline')
    if (parsed.kind !== 'kline') return
    expect(parsed.kline.openTime).toBe(OPEN_TIME)
  })

  it('래퍼가 없는 단독 메시지도 받는다', () => {
    const parsed = parseWsMessage(JSON.stringify(wsEvent()))
    expect(parsed.kind).toBe('kline')
  })

  it('aggTrade 를 최신가 갱신용으로 넘긴다', () => {
    const raw = JSON.stringify({
      data: { e: 'aggTrade', s: SYMBOL, p: '101.5', q: '0.25', T: OPEN_TIME, m: false, a: 7 },
    })
    const parsed = parseWsMessage(raw)

    expect(parsed).toMatchObject({
      kind: 'trade',
      symbol: SYMBOL,
      price: '101.5',
      quantity: '0.25',
      isBuyerMaker: false,
    })
  })

  it('모르는 이벤트에는 죽지 않는다', () => {
    // Binance 가 새 이벤트나 새 필드를 추가해도 수집기가 멈추면 안 된다.
    // 여기서 던지면 WS 핸들러가 통째로 죽고 그 순간부터 구멍이 생긴다.
    expect(parseWsMessage(JSON.stringify({ e: 'depthUpdate' })).kind).toBe('unknown')
    expect(parseWsMessage(JSON.stringify({ result: null, id: 1 })).kind).toBe('unknown')
  })

  it('깨진 JSON 에도 죽지 않는다', () => {
    expect(parseWsMessage('{').kind).toBe('unknown')
    expect(parseWsMessage('').kind).toBe('unknown')
  })
})

describe('buildStreamUrl', () => {
  it('심볼마다 kline 과 aggTrade 스트림을 만든다', () => {
    const url = buildStreamUrl('wss://stream.example.com:9443', ['BTCUSDT', 'ETHUSDT'], '1m')

    expect(url).toContain('btcusdt@kline_1m')
    expect(url).toContain('btcusdt@aggTrade')
    expect(url).toContain('ethusdt@kline_1m')
    expect(url).toContain('ethusdt@aggTrade')
  })

  it('심볼을 소문자로 낮춘다 — Binance 가 대문자를 받지 않는다', () => {
    const url = buildStreamUrl('wss://stream.example.com:9443', ['BTCUSDT'], '1m')
    expect(url).not.toContain('BTCUSDT')
  })

  it('인터벌 설정을 따른다 — 1m 을 박아 두지 않는다', () => {
    const url = buildStreamUrl('wss://stream.example.com:9443', ['BTCUSDT'], '5m')
    expect(url).toContain('btcusdt@kline_5m')
  })
})
