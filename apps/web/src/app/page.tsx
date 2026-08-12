import { buildDashboardPayload } from '@/server/dashboard'

/**
 * 대시보드 페이지.
 *
 * 초기 데이터를 **서버에서** 채워 넣는다. 빈 화면을 먼저 그리고 클라이언트가
 * 다시 받아오면, 운영 대시보드가 열릴 때마다 잠깐 "데이터 없음"을 보여주게 된다.
 * 이후 갱신은 SSE 가 맡는다.
 *
 * TODO(D2): 확정 레이아웃(docs/DESIGN.md §7, docs/mockup/template.html 의 layoutH)을
 *           컴포넌트로 이식한다. 지금은 배선이 끝났는지 확인하는 최소 화면이다.
 */
export const dynamic = 'force-dynamic'

export default async function Page() {
  const data = await buildDashboardPayload()
  const lag = data.ops.lagSeconds

  return (
    <main style={{ padding: 24, display: 'grid', gap: 16 }}>
      <h1 style={{ fontSize: 14, letterSpacing: '.1em', textTransform: 'uppercase', margin: 0 }}>
        Pipeline health
      </h1>

      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-end' }}>
        <Figure
          label="Data lag"
          value={lag === null ? '—' : lag.toFixed(2)}
          unit="s"
          color={lag !== null && lag < 3 ? 'var(--good)' : 'var(--warning)'}
        />
        <Figure
          label="데이터 커버리지"
          value={(data.coverage[0]?.pct ?? 0).toFixed(2)}
          unit="%"
          color="var(--good)"
        />
        <Figure label="갭 복구" value={String(data.ops.recoveredCandles)} unit="봉" />
        <Figure label="수신 체결" value={data.ops.tradeRate.toFixed(0)} unit="/s" />
      </div>

      <div style={{ color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>
        {data.stats.map((s) => (
          <div key={s.symbol}>
            {s.symbol} {s.last} ({s.changePct >= 0 ? '+' : ''}
            {s.changePct.toFixed(2)}%) · 캔들 {data.candles[s.symbol]?.length ?? 0}개 · VWAP {s.vwap}
          </div>
        ))}
        <div style={{ marginTop: 8, color: 'var(--ink-muted)' }}>
          이벤트 {data.events.length}건 · 상대강도 {data.relativeStrength.length}점 · 서버 시각{' '}
          {new Date(data.at).toISOString()}
        </div>
      </div>
    </main>
  )
}

function Figure({
  label,
  value,
  unit,
  color,
}: {
  label: string
  value: string
  unit: string
  color?: string
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 44, fontWeight: 640, lineHeight: 1, color }}>
        {value}
        <span style={{ fontSize: '0.34em', color: 'var(--ink-2)', marginLeft: 4 }}>{unit}</span>
      </div>
    </div>
  )
}
