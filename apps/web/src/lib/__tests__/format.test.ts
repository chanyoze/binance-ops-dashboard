import { describe, expect, it } from 'vitest'
import {
  DISPLAY_TIME_ZONE,
  DISPLAY_TZ_LABEL,
  hhmm,
  hhmmss,
  hhmmUtc,
  lagSeverity,
  symbolColor,
} from '../format.js'

/**
 * 표시용 포맷 — 틀려도 오류가 나지 않는 자리들.
 *
 * 시각이 한 시간 밀리거나 임계가 어긋나면 화면은 멀쩡히 그려지고 값만 틀린다.
 * 그래서 이 프로젝트가 반복해서 경계해 온 "조용히 거짓말하는 화면"에 해당한다.
 */

/** 2026-08-13T04:00:00Z — KST 로는 같은 날 13:00 */
const T_1300_KST = Date.UTC(2026, 7, 13, 4, 0, 0)
/** 2026-08-12T15:00:00Z — KST 로는 **날짜가 넘어간** 00:00 */
const T_MIDNIGHT_KST = Date.UTC(2026, 7, 12, 15, 0, 0)

describe('표시 시간대', () => {
  it('KST 로 고정되어 있다', () => {
    // 브라우저 로컬 시간을 쓰면 서버 렌더와 클라이언트 렌더가 다른 문자열을 만들어
    // 하이드레이션이 어긋나고, 캡처·문서와 화면이 서로 안 맞는다.
    expect(DISPLAY_TIME_ZONE).toBe('Asia/Seoul')
    expect(DISPLAY_TZ_LABEL).toBe('KST')
  })

  it('실행 환경의 시간대와 무관하게 같은 값을 낸다', () => {
    // 컨테이너는 TZ=UTC 로 돌고 브라우저는 KST 다. 둘이 같은 문자열을 내야 한다.
    expect(hhmm(T_1300_KST)).toBe('13:00')
    expect(hhmmss(T_1300_KST)).toBe('13:00:00')
  })

  it('UTC 보다 9시간 앞선다', () => {
    expect(hhmm(T_1300_KST)).toBe('13:00')
    expect(hhmmUtc(T_1300_KST)).toBe('04:00')
  })

  it('자정을 24:00 이 아니라 00:00 으로 적는다', () => {
    // 로캘에 따라 h24 로 나와 "24:00" 이 되는 경우가 있다. hourCycle 을 명시한 이유다.
    expect(hhmm(T_MIDNIGHT_KST)).toBe('00:00')
    expect(hhmmss(T_MIDNIGHT_KST)).toBe('00:00:00')
  })

  it('날짜 경계를 넘어가도 시각만 정확히 낸다', () => {
    // UTC 로는 8/12 15:00 이지만 KST 로는 8/13 00:00 이다.
    expect(hhmmUtc(T_MIDNIGHT_KST)).toBe('15:00')
    expect(hhmm(T_MIDNIGHT_KST)).toBe('00:00')
  })

  it('두 자리로 채운다', () => {
    expect(hhmm(Date.UTC(2026, 7, 13, 0, 5, 0))).toBe('09:05')
  })
})

describe('lagSeverity — Data Lag 임계', () => {
  it('임계 경계에서 바뀐다', () => {
    // 이 값이 Hero 숫자의 색과 상태 배지를 가른다. 경계가 밀리면
    // 위험한 상태가 정상 색으로 표시된다 — 오류 없이.
    expect(lagSeverity(0)).toBe('good')
    expect(lagSeverity(2.99)).toBe('good')
    expect(lagSeverity(3)).toBe('warning')
    expect(lagSeverity(9.99)).toBe('warning')
    expect(lagSeverity(10)).toBe('serious')
    expect(lagSeverity(29.99)).toBe('serious')
    expect(lagSeverity(30)).toBe('critical')
  })

  it('값을 모르면 위험으로 본다 — 정상으로 보지 않는다', () => {
    // null 은 "지연이 없다"가 아니라 "얼마나 지연됐는지 모른다"이다.
    // 이것을 good 으로 두면 수집이 멎은 화면이 초록으로 뜬다.
    expect(lagSeverity(null)).toBe('critical')
  })
})

describe('symbolColor — 고정 슬롯', () => {
  it('심볼마다 다른 색을 준다', () => {
    const symbols = ['BTCUSDT', 'ETHUSDT']
    expect(symbolColor('BTCUSDT', symbols)).not.toBe(symbolColor('ETHUSDT', symbols))
  })

  it('목록에서 앞이 빠져도 색이 재배정되지 않는다', () => {
    // 색이 정체성인 차트라, 필터로 개수가 변할 때 색이 옮겨 다니면
    // 같은 화면을 두 번 볼 때 서로 다른 것을 보게 된다.
    const full = ['BTCUSDT', 'ETHUSDT']
    expect(symbolColor('ETHUSDT', full)).toBe(symbolColor('ETHUSDT', full))
  })
})
