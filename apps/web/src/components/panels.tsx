'use client'

import type { CoverageStat, MarketStats, OpsSnapshot, PipelineEvent } from '@app/shared'
import type { ReactNode } from 'react'
import {
  fmtCompact,
  fmtDuration,
  fmtPrice,
  fmtSigned,
  hhmmss,
  lagSeverity,
  SEVERITY_LABEL,
} from '@/lib/format'
import { Meter, Sparkline } from './SmallCharts'

/* ---------------------------------------------------------------- 껍데기 */

export function Panel({
  title,
  aside,
  children,
  style,
}: {
  title?: string
  aside?: ReactNode
  children: ReactNode
  style?: React.CSSProperties
}) {
  return (
    <section
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--axis)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        // 패널이 자기 그리드 칸 밖으로 자라지 않게 가둔다
        overflow: 'hidden',
        ...style,
      }}
    >
      {title || aside ? (
        <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          {title ? <h2 style={PANEL_TITLE}>{title}</h2> : null}
          {aside ? <div style={{ marginLeft: 'auto' }}>{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

const PANEL_TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 10.5,
  fontWeight: 650,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--ink-muted)',
}

const LABEL: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-muted)',
}

const NOTE: React.CSSProperties = { fontSize: 11, color: 'var(--ink-muted)' }

/* ---------------------------------------------------------------- Hero */

/**
 * Hero figure — 뷰당 정확히 하나, 48px 이상.
 *
 * Data Lag 를 올린 이유: 이 값이 틀어지면 **화면의 나머지 지표가 전부 거짓말**이
 * 된다. 그래서 대시보드가 "이 데이터를 믿어도 되는가"로 시작하는 것이 맞고,
 * 그것이 Part 1(안정적 수집)과 Part 2(대시보드)를 하나의 서사로 잇는다.
 * (docs/DESIGN.md §7 Q2)
 */
export function HeroLag({ ops, lagHistory }: { ops: OpsSnapshot; lagHistory: number[] }) {
  const severity = lagSeverity(ops.lagSeconds)
  const color = `var(--${severity})`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 168 }}>
      <div style={LABEL}>Data lag</div>
      <div
        style={{
          // 큰 단독 숫자는 비례 숫자를 쓴다. tabular-nums 는 열 정렬용이고,
          // 표시 크기에서는 모든 글자가 0 폭이라 헐거워 보인다.
          fontSize: 'clamp(40px, 4.4vw, 58px)',
          fontWeight: 640,
          lineHeight: 1,
          letterSpacing: '-.02em',
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          color,
        }}
      >
        {ops.lagSeconds === null ? '—' : ops.lagSeconds.toFixed(2)}
        <span style={{ fontSize: '.34em', fontWeight: 500, color: 'var(--ink-2)', letterSpacing: 0 }}>
          s
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
        가장 뒤처진 심볼 기준 · 임계 3s
      </div>
      {lagHistory.length > 1 ? (
        <>
          <div style={{ height: 24, marginTop: 2 }}>
            <Sparkline values={lagHistory} color={color} />
          </div>
          <div style={{ ...NOTE, fontSize: 10.5 }}>최근 {lagHistory.length}회 관측</div>
        </>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- Stat tile */

export function StatTile({
  label,
  value,
  unit,
  sub,
  color,
  meterPct,
  spark,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  color?: string
  meterPct?: number
  spark?: number[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <div style={{ ...LABEL, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </div>
      <div style={{ fontSize: 21, fontWeight: 620, lineHeight: 1.15, letterSpacing: '-.01em', color }}>
        {value}
        {unit ? (
          <span style={{ fontSize: '.55em', fontWeight: 500, color: 'var(--ink-2)', marginLeft: 2 }}>
            {unit}
          </span>
        ) : null}
      </div>
      {meterPct !== undefined ? (
        <div style={{ marginTop: 3 }}>
          <Meter pct={meterPct} color={color ?? 'var(--good)'} />
        </div>
      ) : null}
      {spark && spark.length > 1 ? (
        <div style={{ height: 18, marginTop: 2 }}>
          <Sparkline values={spark} color={color ?? 'var(--ink-muted)'} />
        </div>
      ) : null}
      {sub ? <div style={NOTE}>{sub}</div> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- 상태 배지 */

/** status 는 절대 색만으로 말하지 않는다 — 아이콘 + 라벨을 항상 함께 낸다. (§5) */
export function StatusChip({ ops, connection }: { ops: OpsSnapshot; connection: string }) {
  const severity = ops.connected ? lagSeverity(ops.lagSeconds) : 'critical'
  const color = `var(--${severity})`
  /**
   * `stalled` 를 따로 말하는 것이 이 배지의 핵심이다.
   *
   * 연결은 살아 있는데 데이터만 오지 않는 상태를 `live` 로 두면,
   * 화면이 멎은 채로 "연결됨"이라고 말하게 된다. 오류도 없이 틀린 값을
   * 맞다고 보여주는 것이라, 아무 표시도 없는 것보다 나쁘다.
   */
  const streamLabel =
    connection === 'live'
      ? null
      : connection === 'connecting'
        ? '스트림 연결 중'
        : connection === 'stalled'
          ? '스트림 지연 — 폴링으로 갱신 중'
          : '스트림 재연결 중'

  return (
    <span
      title={ops.lastError ?? undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px 3px 7px',
        borderRadius: 999,
        background: 'var(--surface-2)',
        border: '1px solid var(--axis)',
        fontSize: 11.5,
        color: 'var(--ink-2)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }} />
      <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden>
        {ops.connected ? (
          <path
            d="M2 6.2a9 9 0 0 1 12 0M4.4 8.9a5.6 5.6 0 0 1 7.2 0M8 12.2h.01"
            stroke={color}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M3 3l10 10M2 6.2a9 9 0 0 1 12 0M8 12.2h.01"
            stroke="var(--critical)"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        )}
      </svg>
      <b style={{ color: 'var(--ink)', fontWeight: 600 }}>
        {ops.connected ? 'connected' : 'disconnected'}
      </b>
      <span>
        · {SEVERITY_LABEL[severity]}
        {ops.uptimeMs === null ? '' : ` · ${fmtDuration(ops.uptimeMs)}`}
        {streamLabel ? ` · ${streamLabel}` : ''}
      </span>
    </span>
  )
}

/* ---------------------------------------------------------------- 운영 타일 */

export function OpsTiles({ ops, coverage }: { ops: OpsSnapshot; coverage: CoverageStat[] }) {
  const cov = coverage[0]
  const covPct = cov?.pct ?? 0
  const wsTotal = coverage.reduce((sum, c) => sum + c.wsCount, 0)
  const restTotal = coverage.reduce((sum, c) => sum + c.restCount, 0)

  return (
    <>
      <StatTile
        label="데이터 커버리지"
        value={covPct.toFixed(2)}
        unit="%"
        color={covPct >= 99.9 ? 'var(--good)' : 'var(--warning)'}
        meterPct={covPct}
        sub={
          cov
            ? `${cov.actual.toLocaleString('en-US')} / ${cov.expected.toLocaleString('en-US')}봉`
            : undefined
        }
      />
      <StatTile
        label="갭 복구"
        value={String(ops.recoveredCandles)}
        unit="봉"
        color={ops.recoveredCandles > 0 ? 'var(--good)' : undefined}
        sub={`복구 백필 ${ops.recoveryRuns}회 · 재연결 ${ops.reconnectCount}회`}
      />
      <StatTile
        label="수신 체결"
        value={fmtCompact(ops.tradeRate)}
        unit="/s"
        sub={`전 심볼 합 · WS ${wsTotal.toLocaleString('en-US')} / REST ${restTotal.toLocaleString('en-US')}봉`}
      />
    </>
  )
}

/* ---------------------------------------------------------------- 이벤트 로그 */

const EVENT_COLOR: Record<string, string> = {
  connected: 'var(--good)',
  disconnected: 'var(--critical)',
  backfill_started: 'var(--serious)',
  backfill_completed: 'var(--good)',
  gap_detected: 'var(--warning)',
  stale_detected: 'var(--warning)',
  reconnecting: 'var(--serious)',
  rate_limit_throttled: 'var(--warning)',
  error: 'var(--critical)',
}

const EVENT_LABEL: Record<string, string> = {
  connected: '연결됨',
  disconnected: '연결 끊김',
  backfill_started: '백필 시작',
  backfill_completed: '백필 완료',
  gap_detected: '갭 감지',
  stale_detected: '좀비 연결 감지',
  reconnecting: '재연결 중',
  rate_limit_throttled: '요청 속도 조절',
  error: '오류',
}

function describe(event: PipelineEvent): string {
  const d = event.detail as Record<string, unknown>
  if (event.type === 'backfill_completed') return `${d.reason} · ${d.written}봉 · ${d.durationMs}ms`
  if (event.type === 'backfill_started') return `${d.reason} · 예상 ${d.expectedCandles}봉 · ${d.pages}p`
  if (event.type === 'connected') {
    return d.reconnect ? `재연결 · 중단 ${Math.round(Number(d.downtimeMs ?? 0) / 1000)}s` : '최초 연결'
  }
  return JSON.stringify(d).slice(0, 60)
}

export function EventLog({ events }: { events: PipelineEvent[] }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', margin: '0 -4px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr>
            {['시각 (UTC)', '이벤트', '심볼', '내용'].map((head) => (
              <th
                key={head}
                style={{
                  position: 'sticky',
                  top: 0,
                  background: 'var(--surface)',
                  textAlign: 'left',
                  fontSize: 10,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-muted)',
                  fontWeight: 600,
                  padding: '0 4px 4px',
                  whiteSpace: 'nowrap',
                }}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={`${event.ts}-${event.type}-${event.symbol ?? ''}`}>
              <td style={CELL_MONO}>{hhmmss(new Date(event.ts).getTime())}</td>
              <td style={CELL}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      flex: 'none',
                      background: EVENT_COLOR[event.type] ?? 'var(--ink-muted)',
                    }}
                  />
                  {EVENT_LABEL[event.type] ?? event.type}
                </span>
              </td>
              <td style={CELL_MONO}>{event.symbol ?? '—'}</td>
              <td style={{ ...CELL_MONO, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
                {describe(event)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CELL: React.CSSProperties = {
  padding: '3px 4px',
  borderTop: '1px solid var(--grid)',
  verticalAlign: 'top',
}

const CELL_MONO: React.CSSProperties = {
  ...CELL,
  fontFamily: 'var(--mono)',
  color: 'var(--ink-muted)',
  whiteSpace: 'nowrap',
}

/* ---------------------------------------------------------------- 심볼 헤더 */

export function SymbolHeading({
  symbol,
  stats,
  livePrice,
  color,
  children,
}: {
  symbol: string
  stats: MarketStats | undefined
  livePrice: string | undefined
  color: string
  /** 필터는 차트 위 **한 줄**에 정렬한다. 별도 줄로 빼면 좌우 패널의 차트 시작
   *  높이가 어긋나 두 심볼을 눈으로 비교할 수 없게 된다. */
  children?: ReactNode
}) {
  if (!stats) return null

  // 큰 숫자는 틱 가격을 쓴다 — 봉 종가보다 최대 60초 신선하다.
  // 24h 변동률은 봉 기준이라 둘의 출처가 다르다는 점을 알고 섞는다.
  const price = livePrice ?? stats.last
  const up = stats.changePct >= 0

  return (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 3, height: 13, background: color, borderRadius: 2 }} />
        <h2 style={PANEL_TITLE}>{symbol}</h2>
      </span>
      {children}
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 12.5,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          color: up ? 'var(--up)' : 'var(--down)',
        }}
      >
        {fmtPrice(price)} {up ? '▲' : '▼'} {fmtSigned(stats.changePct)}%
      </span>
    </>
  )
}
