import { NextResponse } from 'next/server'
import { buildDashboardPayload } from '@/server/dashboard'
import { parseInt10, parseInterval, toErrorResponse } from '@/server/request'

/** pg 커넥션을 쓰므로 Node 런타임이어야 한다. Edge 에서는 동작하지 않는다. */
export const runtime = 'nodejs'
/** 운영 지표를 캐시하면 그 자체로 거짓말이 된다. */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const params = new URL(request.url).searchParams

    const payload = await buildDashboardPayload({
      interval: parseInterval(params.get('interval')),
      candleLimit: parseInt10(params.get('limit'), 'limit', { min: 1, max: 1000, fallback: 120 }),
      relativeHours: parseInt10(params.get('hours'), 'hours', { min: 1, max: 168, fallback: 6 }),
      eventLimit: parseInt10(params.get('events'), 'events', { min: 1, max: 200, fallback: 30 }),
    })

    return NextResponse.json(payload)
  } catch (error) {
    return toErrorResponse(error)
  }
}
