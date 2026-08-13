import { describe, expect, it, vi } from 'vitest'

/**
 * API 라우트 — 검증된 파라미터가 리포지토리까지 **제대로 이어지는가.**
 *
 * 파싱 자체는 `server/request.ts` 가 24건으로 덮고 있고, 집계는 SQL 에서 끝나 있다.
 * 그 사이의 배선이 비어 있었다 — 기본값이 실제로 전달되는지, 심볼 화이트리스트가
 * 라우트에서도 걸리는지, 오류가 밖으로 새지 않는지.
 *
 * 특히 **오류 응답**이 중요하다. 내부 오류 메시지가 그대로 나가면 DB 구조나
 * 쿼리가 노출된다. 400 은 이유를 말하고 500 은 뭉뚱그린다는 규칙이 지켜져야 한다.
 */

const analytics = {
  getCandles: vi.fn(),
  getOpsSnapshot: vi.fn(),
  getMarketStats: vi.fn(),
  getCoverage: vi.fn(),
  getRelativeStrength: vi.fn(),
  getRecentEvents: vi.fn(),
}

const config = {
  SYMBOLS: ['BTCUSDT', 'ETHUSDT'],
  KLINE_INTERVAL: '1m',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'postgresql://test',
}

const execute = vi.fn()

vi.mock('@/server/db', () => ({
  getAnalytics: () => analytics,
  getConfig: () => config,
  getRuntime: () => ({ handle: { db: { execute } } }),
}))

const { GET: getCandles } = await import('../candles/route.js')
const { GET: getHealth } = await import('../health/route.js')

const request = (url: string): Request => new Request(`http://localhost${url}`)

describe('GET /api/candles', () => {
  it('기본값으로 조회한다 — 심볼은 첫 번째, 인터벌은 수집 해상도', async () => {
    analytics.getCandles.mockResolvedValue([])

    await getCandles(request('/api/candles'))

    expect(analytics.getCandles).toHaveBeenCalledWith('BTCUSDT', '1m', 120, 20)
  })

  it('수집 해상도가 1m 이 아니어도 설정을 따른다', async () => {
    // 위 테스트만으로는 부족하다. 설정값이 마침 '1m' 이라, 라우트에 '1m' 을 박아도
    // **우연히 통과한다.** 설정을 다른 값으로 바꿔 봐야 실제로 읽는지 알 수 있다.
    //
    // 하드코딩하면 수집기 해상도를 바꿨을 때 조회가 오류 없이 빈 결과를 돌려주고,
    // 화면은 "데이터가 없다"로만 보인다. 이 프로젝트가 이미 겪은 종류의 사고다.
    analytics.getCandles.mockResolvedValue([])
    config.KLINE_INTERVAL = '5m'

    try {
      await getCandles(request('/api/candles'))
      expect(analytics.getCandles).toHaveBeenCalledWith('BTCUSDT', '5m', 120, 20)
    } finally {
      config.KLINE_INTERVAL = '1m'
    }
  })

  it('넘긴 값을 그대로 전달한다', async () => {
    analytics.getCandles.mockResolvedValue([])

    await getCandles(request('/api/candles?symbol=ETHUSDT&interval=5m&limit=50&ma=7'))

    expect(analytics.getCandles).toHaveBeenCalledWith('ETHUSDT', '5m', 50, 7)
  })

  it('소문자 심볼도 받아 대문자로 넘긴다', async () => {
    analytics.getCandles.mockResolvedValue([])

    await getCandles(request('/api/candles?symbol=btcusdt'))

    expect(analytics.getCandles).toHaveBeenCalledWith('BTCUSDT', '1m', 120, 20)
  })

  it('수집하지 않는 심볼은 400 으로 거절하고 조회하지 않는다', async () => {
    // 화이트리스트가 곧 유효성 검사다. 여기가 뚫리면 임의 문자열이 SQL 까지 간다.
    analytics.getCandles.mockClear()

    const res = await getCandles(request('/api/candles?symbol=DOGEUSDT'))

    expect(res.status).toBe(400)
    expect(analytics.getCandles).not.toHaveBeenCalled()
  })

  it('범위를 벗어난 limit 은 400 이다 — 조용히 기본값으로 바꾸지 않는다', async () => {
    // 조용히 바꾸면 요청자는 자기가 받은 게 무엇인지 모른 채 화면을 그린다.
    const res = await getCandles(request('/api/candles?limit=99999'))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('limit') })
  })

  it('정수가 아닌 값도 400 이다', async () => {
    expect((await getCandles(request('/api/candles?limit=abc'))).status).toBe(400)
    expect((await getCandles(request('/api/candles?ma=1.5'))).status).toBe(400)
  })

  it('모르는 인터벌은 400 이면서 가능한 값을 알려준다', async () => {
    const res = await getCandles(request('/api/candles?interval=3s'))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('1m') })
  })

  it('내부 오류는 500 으로 뭉뚱그린다 — 메시지를 흘리지 않는다', async () => {
    // 오류 문구에 테이블명·쿼리가 섞여 나가면 그것만으로 정보가 샌다.
    analytics.getCandles.mockRejectedValue(new Error('relation "klines" does not exist'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await getCandles(request('/api/candles'))

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).not.toContain('klines')
    // 원인은 서버 로그에 남아야 한다. 조용히 삼키면 디버깅이 불가능하다.
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('성공하면 요청 조건을 함께 돌려준다', async () => {
    // 화면이 "지금 무엇을 보고 있는지"를 응답만으로 알 수 있어야 한다.
    analytics.getCandles.mockResolvedValue([{ openTime: 1 }])

    const res = await getCandles(request('/api/candles?interval=15m&ma=9'))

    expect(await res.json()).toMatchObject({ symbol: 'BTCUSDT', interval: '15m', maPeriod: 9 })
  })
})

describe('GET /api/health', () => {
  it('DB 에 말을 걸 수 있으면 ok 다', async () => {
    execute.mockResolvedValue(undefined)

    const res = await getHealth()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('DB 가 죽으면 503 으로 알린다 — 200 을 주면 안 된다', async () => {
    // 컨테이너 헬스체크가 이 값을 본다. 여기서 200 을 주면 죽은 웹이 계속 살아 있는
    // 것으로 취급된다.
    execute.mockRejectedValue(new Error('connection refused'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await getHealth()

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'degraded', reason: 'database' })
    spy.mockRestore()
  })

  it('무거운 집계를 돌리지 않는다 — 헬스체크가 부하의 원인이 되면 안 된다', async () => {
    // 처음에는 /api/dashboard?limit=1 을 찔렀는데, limit 은 캔들 수만 줄일 뿐
    // 커버리지·상대강도·24h 집계는 그대로 돈다.
    execute.mockResolvedValue(undefined)
    analytics.getOpsSnapshot.mockClear()
    analytics.getCoverage.mockClear()

    await getHealth()

    expect(analytics.getOpsSnapshot).not.toHaveBeenCalled()
    expect(analytics.getCoverage).not.toHaveBeenCalled()
  })
})
