import type { Candle, Kline } from '@app/shared'
import { describe, expect, it } from 'vitest'
import type { DashboardPayload } from '@/server/dashboard'
import { mergeKline } from '../merge-kline.js'

/**
 * 실시간 봉을 화면 배열에 반영하는 병합.
 *
 * **여기가 틀리면 화면이 조용히 거짓말한다.** 봉이 중복으로 쌓이거나, 배열이 자라
 * 시간 축이 어긋나거나, 진행 중 봉이 확정 봉을 밀어내도 오류는 나지 않는다.
 * 캔들 하나가 어긋난 차트는 "그럴듯해 보이는 틀린 그림"이라 눈으로도 잘 안 잡힌다.
 *
 * 1분봉은 1분에 한 번 오는 게 아니라 **진행 중인 봉이 매초 갱신되며 계속 온다.**
 * 그래서 "같은 봉이면 덮고, 새 봉이면 밀어 넣으며 앞을 자른다"가 이 함수의 전부다.
 */

const MINUTE = 60_000
const T0 = 1_700_000_000_000
const SYMBOL = 'BTCUSDT'

const candle = (openTime: number, close: string, ma: string | null = '100'): Candle => ({
  openTime,
  open: '100',
  high: '101',
  low: '99',
  close,
  volume: '10',
  quoteVolume: '1000',
  tradeCount: 5,
  takerBuyQuote: '500',
  ma,
  hasBackfill: false,
  isClosed: true,
})

const payload = (candles: Candle[]): DashboardPayload =>
  ({ candles: { [SYMBOL]: candles } }) as unknown as DashboardPayload

const incoming = (openTime: number, close: string, over: Partial<Kline> = {}): Kline =>
  ({
    symbol: SYMBOL,
    interval: '1m',
    openTime,
    closeTime: openTime + MINUTE - 1,
    open: '100',
    high: '101',
    low: '99',
    close,
    volume: '10',
    quoteVolume: '1000',
    tradeCount: 5,
    takerBuyBase: '5',
    takerBuyQuote: '500',
    isClosed: true,
    source: 'ws',
    ...over,
  }) as Kline

const closes = (result: DashboardPayload): string[] =>
  (result.candles[SYMBOL] ?? []).map((c) => c.close)

describe('mergeKline', () => {
  it('같은 봉이 다시 오면 덮어쓴다 — 새로 쌓지 않는다', () => {
    // 진행 중인 봉은 매초 갱신돼 온다. 밀어 넣으면 1분에 60개가 쌓인다.
    const before = payload([candle(T0, '100'), candle(T0 + MINUTE, '101')])
    const after = mergeKline(before, incoming(T0 + MINUTE, '102'))

    expect(after.candles[SYMBOL]).toHaveLength(2)
    expect(closes(after)).toEqual(['100', '102'])
  })

  it('새 봉이면 뒤에 붙이고 앞을 자른다 — 길이가 유지된다', () => {
    // 길이가 자라면 차트의 시간 축이 조용히 늘어난다.
    const before = payload([candle(T0, '100'), candle(T0 + MINUTE, '101')])
    const after = mergeKline(before, incoming(T0 + 2 * MINUTE, '102'))

    expect(after.candles[SYMBOL]).toHaveLength(2)
    expect(closes(after)).toEqual(['101', '102'])
  })

  it('덮어쓸 때 기존 MA 를 지키고, 새 봉의 MA 는 비운다', () => {
    // MA 는 서버가 윈도우 함수로 계산한다. 여기서 흉내내면 정의가 갈려
    // 화면의 선과 API 의 값이 서로 다른 계산이 된다.
    const before = payload([candle(T0, '100', '42')])

    const overwritten = mergeKline(before, incoming(T0, '105'))
    expect(overwritten.candles[SYMBOL]?.[0]?.ma).toBe('42')

    const appended = mergeKline(before, incoming(T0 + MINUTE, '105'))
    expect(appended.candles[SYMBOL]?.at(-1)?.ma).toBeNull()
  })

  it('REST 로 온 봉을 백필로 표시한다 — 복구의 증거다', () => {
    const before = payload([candle(T0, '100')])
    const after = mergeKline(before, incoming(T0 + MINUTE, '101', { source: 'rest' }))

    expect(after.candles[SYMBOL]?.at(-1)?.hasBackfill).toBe(true)
  })

  it('진행 중 여부를 그대로 전달한다', () => {
    const before = payload([candle(T0, '100')])
    const after = mergeKline(before, incoming(T0, '100', { isClosed: false }))

    expect(after.candles[SYMBOL]?.[0]?.isClosed).toBe(false)
  })

  it('모르는 심볼이면 아무것도 바꾸지 않는다', () => {
    // 수집 심볼을 늘리면 화면이 아직 모르는 심볼의 봉이 먼저 도착할 수 있다.
    // 여기서 배열을 만들어 버리면 차트가 빈 축을 그린다.
    const before = payload([candle(T0, '100')])
    const after = mergeKline(before, incoming(T0, '999', { symbol: 'ETHUSDT' }))

    expect(after).toBe(before)
  })

  it('원본을 변형하지 않는다', () => {
    // React 상태다. 제자리에서 고치면 리렌더가 걸리지 않아 화면이 멈춘다.
    const list = [candle(T0, '100')]
    const before = payload(list)
    const after = mergeKline(before, incoming(T0, '111'))

    expect(list[0]?.close).toBe('100')
    expect(after.candles[SYMBOL]).not.toBe(list)
  })
})
