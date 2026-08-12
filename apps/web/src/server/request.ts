import { INTERVAL_MS, type Interval } from '@app/shared'
import { NextResponse } from 'next/server'

/**
 * 쿼리 파라미터 파싱.
 *
 * 이 값들은 결국 SQL 의 LIMIT 과 시간 범위로 들어간다. "이상하면 기본값" 이 아니라
 * **이상하면 거절한다** — 조용히 기본값으로 바꾸면 요청자는 자기가 받은 게
 * 무엇인지 모른 채 화면을 그리게 된다.
 */

export class BadRequest extends Error {}

const INTERVALS = Object.keys(INTERVAL_MS) as Interval[]

export function parseInterval(raw: string | null, fallback: Interval = '1m'): Interval {
  if (raw === null) return fallback
  const found = INTERVALS.find((i) => i === raw)
  if (!found) {
    throw new BadRequest(`interval 이 올바르지 않습니다: ${raw} (가능: ${INTERVALS.join(', ')})`)
  }
  return found
}

export function parseInt10(
  raw: string | null,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new BadRequest(`${name} 은 정수여야 합니다: ${raw}`)
  }
  const value = Number(raw)
  if (value < min || value > max) {
    throw new BadRequest(`${name} 은 ${min}~${max} 범위여야 합니다: ${value}`)
  }
  return value
}

/** 설정에 없는 심볼은 조회하지 않는다. 화이트리스트가 곧 유효성 검사다. */
export function parseSymbol(raw: string | null, allowed: readonly string[]): string {
  const first = allowed[0]
  if (first === undefined) throw new BadRequest('수집 중인 심볼이 없습니다')
  if (raw === null) return first
  const upper = raw.toUpperCase()
  if (!allowed.includes(upper)) {
    throw new BadRequest(`수집 중인 심볼이 아닙니다: ${raw} (가능: ${allowed.join(', ')})`)
  }
  return upper
}

/**
 * 라우트 공통 오류 처리.
 * 잘못된 요청은 400 으로 이유를 말하고, 그 외는 500 으로 뭉뚱그린다 —
 * 내부 오류 메시지를 밖으로 흘리지 않는다. 원인은 서버 로그에 남는다.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof BadRequest) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  console.error('[api] 처리 실패', error)
  return NextResponse.json({ error: '요청을 처리하지 못했습니다.' }, { status: 500 })
}
