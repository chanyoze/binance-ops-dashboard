import { Dashboard } from '@/components/Dashboard'
import { buildDashboardPayload } from '@/server/dashboard'

/**
 * 대시보드 페이지.
 *
 * 초기 데이터를 **서버에서** 채워 넣는다. 빈 화면을 먼저 그리고 클라이언트가
 * 다시 받아오면, 운영 대시보드가 열릴 때마다 잠깐 "데이터 없음"을 보여주게 된다.
 * 이후 갱신은 SSE 가 맡는다.
 */
export const dynamic = 'force-dynamic'

export default async function Page() {
  const initial = await buildDashboardPayload()
  return <Dashboard initial={initial} />
}
