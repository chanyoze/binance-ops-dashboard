import { alignToInterval, type Kline } from '@app/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AnalyticsRepository } from '../analytics-repository.js'
import { createDb, type DbHandle } from '../client.js'
import { KlineRepository } from '../kline-repository.js'
import { klines } from '../schema.js'

/**
 * 집계 쿼리 통합 테스트 — 실제 Postgres 가 필요하다. 없으면 조용히 건너뛴다.
 *
 * 여기서 검증하는 것은 **지표의 정의**다. 화면이 예쁘게 나오는지가 아니라
 * "5분봉의 시가가 정말 첫 1분봉의 시가인가", "지수화 기준점이 정말 100인가" 같은,
 * 틀려도 그럴듯해 보여서 눈으로는 못 잡는 것들이다.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://binance:binance@localhost:5432/binance_ops'

const MINUTE = 60_000
const BASE = alignToInterval(Date.UTC(2026, 0, 2, 0, 0, 0), MINUTE)
const A = 'ANALYTICSAUSD'
const B = 'ANALYTICSBUSD'

async function isDatabaseReachable(): Promise<boolean> {
  let handle: DbHandle | null = null
  try {
    handle = createDb(DATABASE_URL, 1)
    await handle.db.execute(sql`select 1`)
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

const dbAvailable = await isDatabaseReachable()

/** 분 오프셋과 종가만 주면 나머지는 기본값으로 채운다. */
function kline(
  symbol: string,
  offsetMinutes: number,
  values: {
    open?: number
    high?: number
    low?: number
    close: number
    volume?: number
    quoteVolume?: number
    takerBuyQuote?: number
    tradeCount?: number
    source?: 'ws' | 'rest'
    isClosed?: boolean
  },
): Kline {
  const openTime = BASE + offsetMinutes * MINUTE
  const close = values.close
  const d = (n: number) => n.toFixed(8)
  return {
    symbol,
    interval: '1m',
    openTime,
    closeTime: openTime + MINUTE - 1,
    open: d(values.open ?? close),
    high: d(values.high ?? Math.max(values.open ?? close, close)),
    low: d(values.low ?? Math.min(values.open ?? close, close)),
    close: d(close),
    volume: d(values.volume ?? 1),
    quoteVolume: d(values.quoteVolume ?? close),
    tradeCount: values.tradeCount ?? 10,
    takerBuyBase: d(0),
    takerBuyQuote: d(values.takerBuyQuote ?? close / 2),
    isClosed: values.isClosed ?? true,
    source: values.source ?? 'ws',
  }
}

/**
 * 인덱스 접근을 확정으로 좁힌다.
 * `noUncheckedIndexedAccess` 아래서 배열 원소는 undefined 일 수 있는데,
 * 테스트에서 매번 옵셔널 체이닝을 붙이면 "값이 없어도 통과"하는 단언이 되기 쉽다.
 */
function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index]
  if (row === undefined) throw new Error(`행 ${index} 이(가) 없습니다 (길이 ${rows.length})`)
  return row
}

describe.skipIf(!dbAvailable)('AnalyticsRepository (통합)', () => {
  const handle = createDb(DATABASE_URL, 3)
  const writer = new KlineRepository(handle.db)
  const repo = new AnalyticsRepository(handle.db)

  const wipe = async () => {
    await handle.db.execute(sql`delete from ${klines} where symbol in (${A}, ${B})`)
  }

  beforeEach(wipe)
  afterAll(async () => {
    await wipe()
    await handle.close()
  })

  describe('getCandles — 1분봉 접기', () => {
    it('5분봉의 OHLCV 가 구성 1분봉에서 규칙대로 나온다', async () => {
      // 00:00~00:04 를 한 봉으로 접는다. 각 필드가 서로 다른 규칙을 따른다.
      await writer.upsertKlines([
        kline(A, 0, { open: 100, high: 101, low: 99, close: 100.5, volume: 1, tradeCount: 5 }),
        kline(A, 1, { open: 100.5, high: 108, low: 100, close: 107, volume: 2, tradeCount: 7 }),
        kline(A, 2, { open: 107, high: 107.5, low: 95, close: 96, volume: 3, tradeCount: 11 }),
        kline(A, 3, { open: 96, high: 99, low: 95.5, close: 98, volume: 4, tradeCount: 13 }),
        kline(A, 4, { open: 98, high: 103, low: 97, close: 102, volume: 5, tradeCount: 17 }),
      ])

      const candle = at(await repo.getCandles(A, '5m', 1, 1), 0)

      expect(candle.openTime).toBe(BASE)
      expect(Number(candle.open)).toBe(100) // 첫 1분봉의 시가
      expect(Number(candle.close)).toBe(102) // 마지막 1분봉의 종가
      expect(Number(candle.high)).toBe(108) // 구간 최고
      expect(Number(candle.low)).toBe(95) // 구간 최저
      expect(Number(candle.volume)).toBe(15) // 합
      expect(candle.tradeCount).toBe(53) // 합
    })

    it('봉 경계가 epoch 기준으로 정렬된다 (Binance 와 어긋나지 않아야 한다)', async () => {
      // 00:03 부터 넣어도 그 봉은 00:00 버킷에 속해야 한다. 데이터 첫 시각을
      // 기준으로 잡으면 봉 경계가 수집 시작 시각에 따라 달라져 버린다.
      await writer.upsertKlines([
        kline(A, 3, { close: 100 }),
        kline(A, 4, { close: 101 }),
        kline(A, 5, { close: 102 }),
      ])

      const candles = await repo.getCandles(A, '5m', 5, 1)

      expect(candles.map((c) => c.openTime)).toEqual([BASE, BASE + 5 * MINUTE])
    })

    it('진행 중 봉이 섞이면 그 봉만 미확정으로 표시된다', async () => {
      await writer.upsertKlines([
        kline(A, 0, { close: 100 }),
        kline(A, 1, { close: 101, isClosed: false }),
      ])

      const candles = await repo.getCandles(A, '1m', 2, 1)

      expect(candles.map((c) => c.isClosed)).toEqual([true, false])
    })

    it('REST 백필분이 섞인 봉에 표시가 남는다 (자가 치유의 흔적)', async () => {
      await writer.upsertKlines([
        kline(A, 0, { close: 100, source: 'ws' }),
        kline(A, 1, { close: 101, source: 'rest' }),
        kline(A, 5, { close: 102, source: 'ws' }),
      ])

      const candles = await repo.getCandles(A, '5m', 2, 1)

      expect(candles.map((c) => c.hasBackfill)).toEqual([true, false])
    })
  })

  describe('getCandles — 이동평균', () => {
    it('구간이 안 찬 앞부분은 null 이라 선이 끊긴다', async () => {
      await writer.upsertKlines([0, 1, 2, 3, 4].map((i) => kline(A, i, { close: 100 + i })))

      const candles = await repo.getCandles(A, '1m', 5, 3)

      // MA3 은 세 번째 봉부터 값이 생긴다.
      expect(candles.map((c) => c.ma === null)).toEqual([true, true, false, false, false])
      expect(Number(at(candles, 2).ma)).toBeCloseTo((100 + 101 + 102) / 3, 6)
      expect(Number(at(candles, 4).ma)).toBeCloseTo((102 + 103 + 104) / 3, 6)
    })

    it('MA 는 접은 뒤에 계산된다 — 5분봉의 MA2 는 최근 10분 평균이다', async () => {
      // 1분봉에서 MA 를 먼저 구해 5분봉에 붙이면 "최근 2분"이 되어 값이 달라진다.
      await writer.upsertKlines([
        ...[0, 1, 2, 3, 4].map((i) => kline(A, i, { close: 100 })), // 5m 봉① 종가 100
        ...[5, 6, 7, 8, 9].map((i) => kline(A, i, { close: 200 })), // 5m 봉② 종가 200
      ])

      const candles = await repo.getCandles(A, '5m', 2, 2)

      expect(candles).toHaveLength(2)
      expect(Number(at(candles, 1).ma)).toBe(150) // (100 + 200) / 2
    })
  })

  describe('getCoverage', () => {
    it('구멍이 없으면 100%, WS·REST 를 구분해 센다', async () => {
      await writer.upsertKlines([
        kline(A, 0, { close: 100, source: 'ws' }),
        kline(A, 1, { close: 101, source: 'rest' }),
        kline(A, 2, { close: 102, source: 'rest' }),
      ])

      const cov = at(await repo.getCoverage([A], '1m'), 0)

      expect(cov).toMatchObject({ actual: 3, expected: 3, pct: 100, wsCount: 1, restCount: 2 })
    })

    it('구멍이 뚫리면 100% 아래로 떨어진다', async () => {
      // 0,1,2 · (3,4 없음) · 5 -> 기대 6봉 중 4봉
      await writer.upsertKlines([0, 1, 2, 5].map((i) => kline(A, i, { close: 100 })))

      const cov = at(await repo.getCoverage([A], '1m'), 0)

      expect(cov.actual).toBe(4)
      expect(cov.expected).toBe(6)
      expect(cov.pct).toBeCloseTo((4 / 6) * 100, 6)
    })

    it('수집 시작 전 구간은 결손으로 세지 않는다', async () => {
      // 분모를 "첫 봉 ~ 마지막 봉" 으로 잡으므로, 늦게 켠 것이 품질 문제로 보이지 않는다.
      await writer.upsertKlines([500, 501, 502].map((i) => kline(A, i, { close: 100 })))

      const cov = at(await repo.getCoverage([A], '1m'), 0)

      expect(cov.expected).toBe(3)
      expect(cov.pct).toBe(100)
    })
  })

  describe('getMarketStats', () => {
    it('VWAP·Taker 비율·변동률이 금액 기준으로 계산된다', async () => {
      await writer.upsertKlines([
        kline(A, 0, { open: 100, close: 100, volume: 1, quoteVolume: 100, takerBuyQuote: 30 }),
        kline(A, 1, { open: 100, close: 200, volume: 1, quoteVolume: 300, takerBuyQuote: 90 }),
      ])

      const stats = at(await repo.getMarketStats([A]), 0)

      expect(Number(stats.open24h)).toBe(100)
      expect(Number(stats.last)).toBe(200)
      expect(stats.changePct).toBeCloseTo(100, 6)
      // VWAP = 총 거래대금 / 총 거래량 = 400 / 2. 단순 종가 평균(150)이 아니다.
      expect(Number(stats.vwap)).toBeCloseTo(200, 6)
      // 금액 기준 = 120 / 400. 봉별 비율의 평균(0.3, 0.3 -> 0.3)과 같아 보이지만
      // 거래대금이 다른 봉이 섞이면 달라진다.
      expect(stats.takerBuyRatio).toBeCloseTo(0.3, 6)
    })

    it('거래량이 0인 봉만 있어도 나눗셈에서 터지지 않는다', async () => {
      await writer.upsertKlines([
        kline(A, 0, { close: 100, volume: 0, quoteVolume: 0, takerBuyQuote: 0 }),
      ])

      const stats = at(await repo.getMarketStats([A]), 0)

      expect(stats.takerBuyRatio).toBe(0)
      expect(Number(stats.vwap)).toBe(100) // 계산 불가 시 마지막 가격으로 대체
    })
  })

  describe('getRelativeStrength — 지수화', () => {
    it('두 심볼 모두 첫 점이 정확히 100 이다', async () => {
      await writer.upsertKlines([
        ...[0, 1, 2].map((i) => kline(A, i, { close: 60000 + i * 600 })),
        ...[0, 1, 2].map((i) => kline(B, i, { close: 2000 + i * 10 })),
      ])

      const points = await repo.getRelativeStrength([A, B], 1, 60)

      expect(at(points, 0).values[A]).toBeCloseTo(100, 9)
      expect(at(points, 0).values[B]).toBeCloseTo(100, 9)
      // 스케일이 30배 차이나도 같은 축에서 비교된다 — 이중 축을 안 쓰는 이유.
      expect(at(points, 2).values[A]).toBeCloseTo(102, 6) // 60000 -> 61200
      expect(at(points, 2).values[B]).toBeCloseTo(101, 6) // 2000 -> 2020
    })

    it('한쪽 심볼만 있는 구간은 제외한다 (출발점이 어긋나면 비교가 거짓이 된다)', async () => {
      await writer.upsertKlines([
        // A 는 0분부터, B 는 2분부터 — 0~1분은 A 만 있다.
        ...[0, 1, 2, 3].map((i) => kline(A, i, { close: 100 + i })),
        ...[2, 3].map((i) => kline(B, i, { close: 50 + i })),
      ])

      const points = await repo.getRelativeStrength([A, B], 1, 60)

      expect(points).toHaveLength(2)
      expect(at(points, 0).openTime).toBe(BASE + 2 * MINUTE)
      // 기준점은 A 의 첫 봉이 아니라 "둘 다 있는 첫 봉"이다.
      expect(at(points, 0).values[A]).toBeCloseTo(100, 9)
      expect(at(points, 0).values[B]).toBeCloseTo(100, 9)
    })
  })

  describe('심볼 이름 검사', () => {
    it('SQL 에 넣기 부적합한 심볼은 조회 전에 거부한다', async () => {
      await expect(repo.getCoverage([`X'; drop table klines; --`], '1m')).rejects.toThrow(
        /심볼 형식/,
      )
      await expect(repo.getMarketStats(['BTC-USDT'])).rejects.toThrow(/심볼 형식/)
    })

    it('심볼 목록이 비면 쿼리를 보내지 않고 빈 배열을 준다', async () => {
      expect(await repo.getMarketStats([])).toEqual([])
      expect(await repo.getCoverage([], '1m')).toEqual([])
      expect(await repo.getRelativeStrength([], 1)).toEqual([])
    })
  })
})
