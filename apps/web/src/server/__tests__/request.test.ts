import { describe, expect, it, vi } from 'vitest'
import { BadRequest, parseInt10, parseInterval, parseSymbol, toErrorResponse } from '../request.js'

/**
 * 쿼리 파라미터 검증.
 *
 * 이 값들은 결국 SQL 의 LIMIT 과 시간 범위로 들어간다. 설계 원칙은
 * **"이상하면 거절한다"** — 조용히 기본값으로 바꾸면 요청자는 자기가 받은 게
 * 무엇인지 모른 채 화면을 그리게 된다.
 *
 * 그리고 오류 응답이 내부 사정을 흘리지 않는지도 여기서 본다.
 */

const SYMBOLS = ['BTCUSDT', 'ETHUSDT']

describe('parseInterval', () => {
  it('값이 없으면 주어진 기본값을 쓴다', () => {
    expect(parseInterval(null, '5m')).toBe('5m')
  })

  it('지원하는 인터벌을 그대로 돌려준다', () => {
    expect(parseInterval('1h', '1m')).toBe('1h')
  })

  it('모르는 인터벌은 조용히 기본값으로 바꾸지 않고 거절한다', () => {
    expect(() => parseInterval('99m', '1m')).toThrow(BadRequest)
    // 가능한 값을 알려줘야 호출자가 고칠 수 있다
    expect(() => parseInterval('99m', '1m')).toThrow(/가능/)
  })

  it('빈 문자열도 거절한다', () => {
    expect(() => parseInterval('', '1m')).toThrow(BadRequest)
  })
})

describe('parseInt10', () => {
  const range = { min: 1, max: 1000, fallback: 120 }

  it('값이 없으면 기본값', () => {
    expect(parseInt10(null, 'limit', range)).toBe(120)
  })

  it('정수를 그대로 돌려준다', () => {
    expect(parseInt10('500', 'limit', range)).toBe(500)
  })

  it('경계값을 포함한다', () => {
    expect(parseInt10('1', 'limit', range)).toBe(1)
    expect(parseInt10('1000', 'limit', range)).toBe(1000)
  })

  it('범위를 벗어나면 거절한다', () => {
    expect(() => parseInt10('0', 'limit', range)).toThrow(/범위/)
    expect(() => parseInt10('1001', 'limit', range)).toThrow(/범위/)
  })

  it.each(['abc', '1.5', '-5', '1e3', ' 12', '12 ', '0x10', ''])(
    '정수가 아닌 %o 은 거절한다',
    (input) => {
      expect(() => parseInt10(input, 'limit', range)).toThrow(BadRequest)
    },
  )

  it('오류 메시지에 파라미터 이름이 들어간다', () => {
    expect(() => parseInt10('abc', 'ma', range)).toThrow(/^ma /)
  })
})

describe('parseSymbol', () => {
  it('값이 없으면 첫 번째 심볼', () => {
    expect(parseSymbol(null, SYMBOLS)).toBe('BTCUSDT')
  })

  it('대소문자를 가리지 않는다', () => {
    expect(parseSymbol('ethusdt', SYMBOLS)).toBe('ETHUSDT')
  })

  it('수집 중이 아닌 심볼은 거절한다 — 화이트리스트가 곧 검증이다', () => {
    expect(() => parseSymbol('DOGEUSDT', SYMBOLS)).toThrow(BadRequest)
  })

  it('SQL 을 넣으려는 시도도 화이트리스트에서 걸린다', () => {
    expect(() => parseSymbol("BTC'; drop table klines; --", SYMBOLS)).toThrow(BadRequest)
  })

  it('수집 중인 심볼이 하나도 없으면 거절한다', () => {
    expect(() => parseSymbol(null, [])).toThrow(BadRequest)
  })
})

describe('toErrorResponse', () => {
  it('잘못된 요청은 400 으로 이유를 말한다', async () => {
    const response = toErrorResponse(new BadRequest('interval 이 올바르지 않습니다: 99m'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'interval 이 올바르지 않습니다: 99m',
    })
  })

  it('그 외 오류는 500 으로 뭉뚱그리고 내부 사정을 흘리지 않는다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = toErrorResponse(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 — password=hunter2'),
    )

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('요청을 처리하지 못했습니다.')
    // DB 주소도 비밀번호도 응답에 없어야 한다
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|hunter2|5432/)
    // 원인은 서버 로그에 남는다
    expect(spy).toHaveBeenCalled()

    spy.mockRestore()
  })
})
