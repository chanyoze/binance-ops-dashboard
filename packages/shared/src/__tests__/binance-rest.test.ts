import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceRestClient } from '../binance/rest.js'
import type { WeightLimiter } from '../binance/weight-limiter.js'
import type { Logger } from '../logger.js'

/**
 * REST 클라이언트 — **백필이 실제로 데이터를 가져오는 경로.**
 *
 * 여기가 조용히 실패하면 그 구간이 그대로 구멍으로 남는다. 무결성 스캐너가 나중에
 * 줍긴 하지만, 스캐너도 같은 클라이언트를 쓰므로 원인이 여기면 영영 못 메운다.
 *
 * 특히 **4xx 를 재시도하지 않는 것**이 중요하다. 우리 요청이 잘못된 것이라
 * 몇 번을 다시 보내도 결과가 같은데, 재시도하면 rate limit 만 태우고 그 여파로
 * 정상 요청까지 막힌다. 그 판단이 오류 메시지 문자열 비교에 걸려 있어 깨지기 쉽다.
 */

const noop = (): void => undefined
const silentLogger = (): Logger => {
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger
}

/** limiter 가 무엇을 언제 받았는지만 기록한다. 대기는 하지 않는다. */
class FakeLimiter {
  readonly acquired: number[] = []
  readonly headers: (number | null)[] = []
  readonly penalties: (number | null)[] = []

  async acquire(weight: number): Promise<void> {
    this.acquired.push(weight)
  }

  observeHeader(used: number | null): void {
    this.headers.push(used)
  }

  applyPenalty(retryAfterSeconds: number | null): void {
    this.penalties.push(retryAfterSeconds)
  }
}

interface FakeResponseInit {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

const response = ({ status = 200, body = [], headers = {} }: FakeResponseInit = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

const OPEN_TIME = 1_700_000_000_000
/** Binance `/api/v3/klines` 응답 한 행. */
const ROW = [
  OPEN_TIME,
  '100.10',
  '100.90',
  '99.50',
  '100.40',
  '11.0',
  OPEN_TIME + 59_999,
  '22.0',
  33,
  '44.0',
  '55.0',
  '0',
]

let limiter: FakeLimiter
let fetchMock: ReturnType<typeof vi.fn>

const makeClient = (maxRetries?: number): BinanceRestClient =>
  new BinanceRestClient({
    baseUrl: 'https://api.example.com',
    limiter: limiter as unknown as WeightLimiter,
    logger: silentLogger(),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  })

describe('BinanceRestClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    limiter = new FakeLimiter()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('fetchKlines', () => {
    it('구간과 심볼을 쿼리로 정확히 넘긴다', async () => {
      fetchMock.mockResolvedValue(response({ body: [ROW] }))

      await makeClient().fetchKlines('BTCUSDT', '1m', 1_000, 2_000)

      const url = fetchMock.mock.calls[0]?.[0] as URL
      expect(url.pathname).toBe('/api/v3/klines')
      expect(url.searchParams.get('symbol')).toBe('BTCUSDT')
      expect(url.searchParams.get('interval')).toBe('1m')
      expect(url.searchParams.get('startTime')).toBe('1000')
      expect(url.searchParams.get('endTime')).toBe('2000')
    })

    it('limit 을 1000 으로 자른다 — Binance 상한이다', async () => {
      // 넘겨 보내면 400 이 온다. 그러면 그 구간은 재시도도 안 되고 구멍으로 남는다.
      fetchMock.mockResolvedValue(response({ body: [] }))

      await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1, 5_000)

      const url = fetchMock.mock.calls[0]?.[0] as URL
      expect(url.searchParams.get('limit')).toBe('1000')
    })

    it('응답을 Kline 으로 바꾸고 출처를 rest 로 찍는다', async () => {
      // source 가 복구의 증거다. 여기가 ws 로 찍히면 "백필이 메웠다"를 못 보여준다.
      fetchMock.mockResolvedValue(response({ body: [ROW] }))

      const klines = await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)

      expect(klines).toHaveLength(1)
      expect(klines[0]).toMatchObject({ symbol: 'BTCUSDT', interval: '1m', source: 'rest' })
    })
  })

  describe('weight 관리와의 연결', () => {
    it('요청 전에 weight 를 확보한다', async () => {
      fetchMock.mockResolvedValue(response({ body: [] }))

      await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)

      expect(limiter.acquired).toEqual([2])
    })

    it('응답 헤더의 실제 사용량을 limiter 에 되먹인다', async () => {
      // 우리 카운터만 믿으면 다른 프로세스가 쓴 weight 를 모른다.
      fetchMock.mockResolvedValue(
        response({ body: [], headers: { 'x-mbx-used-weight-1m': '1234' } }),
      )

      await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)

      expect(limiter.headers).toEqual([1234])
    })

    it('헤더가 없으면 null 로 넘겨 무시하게 한다', async () => {
      fetchMock.mockResolvedValue(response({ body: [] }))

      await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)

      expect(limiter.headers).toEqual([null])
    })
  })

  describe('429 / 418', () => {
    it('Retry-After 를 limiter 에 넘기고 재시도한다', async () => {
      fetchMock
        .mockResolvedValueOnce(response({ status: 429, headers: { 'retry-after': '30' } }))
        .mockResolvedValueOnce(response({ body: [ROW] }))

      const klines = await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)

      expect(limiter.penalties).toEqual([30])
      expect(klines).toHaveLength(1)
      // 재시도할 때 weight 를 다시 확보해야 한다. 안 그러면 카운터가 실제보다 작아진다.
      expect(limiter.acquired).toEqual([2, 2])
    })

    it('418(밴)도 같은 경로로 다룬다', async () => {
      fetchMock
        .mockResolvedValueOnce(response({ status: 418 }))
        .mockResolvedValueOnce(response({ body: [] }))

      await makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)

      expect(limiter.penalties).toEqual([null])
    })
  })

  describe('5xx', () => {
    it('백오프를 두고 재시도한다', async () => {
      fetchMock
        .mockResolvedValueOnce(response({ status: 503 }))
        .mockResolvedValueOnce(response({ body: [ROW] }))

      const pending = makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(await pending).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('재시도를 다 쓰면 마지막 오류를 알린다', async () => {
      fetchMock.mockResolvedValue(response({ status: 500 }))

      const pending = makeClient(3).fetchKlines('BTCUSDT', '1m', 0, 1)
      const caught = pending.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await caught).toMatch(/3회 모두 실패/)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('4xx — 재시도하지 않는다', () => {
    it('잘못된 요청은 즉시 던진다', async () => {
      // **이 테스트가 이 파일에서 가장 중요하다.**
      // 우리 요청이 잘못된 것이라 다시 보내도 결과가 같다. 재시도하면 rate limit 만
      // 태우고, 그 여파로 정상 요청까지 막혀 구멍이 넓어진다.
      fetchMock.mockResolvedValue(response({ status: 400, body: 'Invalid symbol' }))

      await expect(makeClient().fetchKlines('NOPE', '1m', 0, 1)).rejects.toThrow(/HTTP 400/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('응답 본문을 오류에 실어 원인을 남긴다', async () => {
      fetchMock.mockResolvedValue(response({ status: 400, body: 'Invalid symbol' }))

      await expect(makeClient().fetchKlines('NOPE', '1m', 0, 1)).rejects.toThrow(/Invalid symbol/)
    })
  })

  describe('네트워크 오류', () => {
    it('던져진 예외는 재시도한다 — 일시적일 수 있다', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(response({ body: [ROW] }))

      const pending = makeClient().fetchKlines('BTCUSDT', '1m', 0, 1)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(await pending).toHaveLength(1)
    })
  })

  describe('fetchServerTime', () => {
    it('서버 시각을 숫자로 돌려준다', async () => {
      fetchMock.mockResolvedValue(response({ body: { serverTime: OPEN_TIME } }))

      expect(await makeClient().fetchServerTime()).toBe(OPEN_TIME)
      expect(limiter.acquired).toEqual([1])
    })
  })
})
