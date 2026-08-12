import { NextResponse } from 'next/server'
import { getAnalytics, getConfig } from '@/server/db'
import { parseInt10, parseInterval, parseSymbol, toErrorResponse } from '@/server/request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 인터벌·심볼 전환 전용.
 *
 * 대시보드 전체를 다시 받지 않는 이유는, 1m -> 1h 를 눌렀을 때 바뀌어야 하는 것이
 * 캔들뿐이기 때문이다. 운영 지표까지 함께 갱신하면 화면이 통째로 깜빡인다.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const params = new URL(request.url).searchParams
    const { SYMBOLS } = getConfig()

    const symbol = parseSymbol(params.get('symbol'), SYMBOLS)
    const interval = parseInterval(params.get('interval'))
    const limit = parseInt10(params.get('limit'), 'limit', { min: 1, max: 1000, fallback: 120 })
    const ma = parseInt10(params.get('ma'), 'ma', { min: 2, max: 200, fallback: 20 })

    const candles = await getAnalytics().getCandles(symbol, interval, limit, ma)

    return NextResponse.json({ symbol, interval, maPeriod: ma, candles })
  } catch (error) {
    return toErrorResponse(error)
  }
}
