import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getRuntime } from '@/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 컨테이너 헬스체크 전용.
 *
 * 처음에는 `/api/dashboard?limit=1` 을 찔렀는데, limit 은 캔들 개수만 줄일 뿐
 * 커버리지·상대강도·24h 집계는 그대로 돈다. 30초마다 아무도 안 보는 화면의
 * 무거운 집계를 돌려 수집기의 쓰기와 경합하게 된다.
 *
 * 헬스체크가 답해야 하는 질문은 "이 프로세스가 DB 에 말을 걸 수 있는가" 하나다.
 * 그 이상을 확인하면 헬스체크가 부하의 원인이 된다.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { handle } = getRuntime()
    await handle.db.execute(sql`select 1`)

    return NextResponse.json({ status: 'ok' })
  } catch (error) {
    console.error('[api/health] DB 연결 실패', error)
    return NextResponse.json({ status: 'degraded', reason: 'database' }, { status: 503 })
  }
}
