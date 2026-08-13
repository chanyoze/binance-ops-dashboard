'use client'

import { INTERVAL_MS, type Interval } from '@app/shared'
import { useEffect, useRef, useState } from 'react'
import { DISPLAY_TZ_LABEL, symbolColor } from '@/lib/format'
import { useDashboard } from '@/lib/useDashboard'
import type { DashboardPayload } from '@/server/dashboard'
import { CandleChart } from './CandleChart'
import { EventLog, HeroLag, OpsTiles, Panel, StatusChip, SymbolHeading } from './panels'
import { IndexedChart, TakerBar } from './SmallCharts'
import { TooltipProvider } from './Tooltip'

/**
 * 확정 레이아웃 — A(운영 우선)의 헬스 밴드 + C(좌우 분할)의 캔들 배치.
 * 근거는 docs/DESIGN.md §7.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ PIPELINE HEALTH            ● connected 34m   │  Hero 58px + 지표별 근거
 *   ├───────────────────┬──────────────────────────┤
 *   │ BTCUSDT 캔들       │ ETHUSDT 캔들             │  두 심볼 대등
 *   ├──────────┬────────┴──┬───────────────────────┤
 *   │ 상대 강도  │ Taker 비율 │ 파이프라인 이벤트      │
 *   └──────────┴───────────┴───────────────────────┘
 *
 * 이 화면의 1순위 제약은 **스크롤이 없어야 한다**는 것이다. 운영 대시보드는
 * 모니터에 띄워두고 흘끗 보는 화면이고, 스크롤하는 순간 운영 도구가 아니게 된다.
 * 그래서 전체를 100dvh 그리드로 잡고 각 칸이 자기 안에서만 넘치게 한다.
 */

/** 화면에 노출할 인터벌. 전부 내보이면 선택지만 늘고 판단이 느려진다. */
const VISIBLE_INTERVALS: Interval[] = ['1m', '5m', '15m', '1h']

/**
 * 고를 수 있는 인터벌 = 수집 해상도 이상이면서 그것의 정수배인 것.
 *
 * 1분봉을 접어 만드는 구조라 수집 해상도보다 작은 봉은 만들 수 없고,
 * 정수배가 아니면 봉 경계가 원본과 어긋난다. 고를 수 없는 것을 보여주면
 * 눌렀을 때 빈 차트가 나오는데, 그건 고장으로 읽힌다.
 */
function selectableIntervals(base: Interval): Interval[] {
  const baseMs = INTERVAL_MS[base]
  const options = VISIBLE_INTERVALS.filter(
    (i) => INTERVAL_MS[i] >= baseMs && INTERVAL_MS[i] % baseMs === 0,
  )
  return options.length > 0 ? options : [base]
}

/** Hero 스파크라인에 쓸 관측 이력 길이 */
const LAG_HISTORY_SIZE = 40

export function Dashboard({ initial }: { initial: DashboardPayload }) {
  const { data, prices, connection, interval, setInterval, loadingCandles } = useDashboard(initial)
  const symbols = data.symbols

  // Data Lag 는 시계열이 DB 에 없다. 화면이 살아 있는 동안 관측값을 모아 추세를 보여준다.
  const [lagHistory, setLagHistory] = useState<number[]>([])
  const lastAt = useRef(0)
  useEffect(() => {
    if (data.ops.lagSeconds === null || data.at === lastAt.current) return
    lastAt.current = data.at
    setLagHistory((prev) => [...prev, data.ops.lagSeconds as number].slice(-LAG_HISTORY_SIZE))
  }, [data.at, data.ops.lagSeconds])

  return (
    <TooltipProvider>
      <div
        style={{
          height: '100dvh',
          display: 'grid',
          gridTemplateRows: 'auto minmax(0,1fr) minmax(148px,0.52fr)',
          gap: 'var(--gap)',
          padding: 'var(--gap)',
        }}
      >
        <Panel title="Pipeline health" aside={<StatusChip ops={data.ops} connection={connection} />}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(200px,1.1fr) repeat(3, minmax(0,1fr))',
              gap: 20,
              alignItems: 'center',
            }}
          >
            <HeroLag ops={data.ops} lagHistory={lagHistory} />
            <OpsTiles ops={data.ops} coverage={data.coverage} />
          </div>
        </Panel>

        {/* 두 심볼이 대등하다. 인터벌 선택기는 왼쪽에 한 번만 두고 양쪽에 함께 건다. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--gap)', minHeight: 0 }}>
          {symbols.map((symbol, index) => (
            <Panel
              key={symbol}
              style={{ opacity: loadingCandles ? 0.6 : 1, transition: 'opacity .15s' }}
            >
              {/* 헤더는 반드시 한 줄이어야 한다 — 좌우 패널의 차트 시작 높이가 어긋나면
                  두 심볼을 눈으로 비교할 수 없다. 선택기가 없는 쪽도 같은 높이를 차지한다. */}
              <header style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 26 }}>
                <SymbolHeading
                  symbol={symbol}
                  stats={data.stats.find((s) => s.symbol === symbol)}
                  livePrice={prices[symbol]?.price}
                  color={symbolColor(symbol, symbols)}
                >
                  {index === 0 ? (
                    <IntervalPicker value={interval} base={data.baseInterval} onChange={setInterval} busy={loadingCandles} />
                  ) : null}
                </SymbolHeading>
              </header>
              <CandleChart
                candles={data.candles[symbol] ?? []}
                symbol={symbol}
                interval={interval}
              />
              <Legend count={data.candles[symbol]?.length ?? 0} />
            </Panel>
          ))}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1.1fr) 260px minmax(0,1.15fr)',
            gap: 'var(--gap)',
            minHeight: 0,
          }}
        >
          <Panel
            title="상대 강도 — 구간 시작 = 100"
            aside={
              /*
               * 현재 지수를 **범례에서** 읽는다.
               *
               * 처음에는 선 끝에 직접 라벨을 붙였다. 직접 라벨링이 범례보다 낫다는 것이
               * 일반론이지만, 이 차트에서는 성립하지 않았다 — 구간 시작을 100 으로
               * 맞추므로 두 값이 서로 가까운 것이 예외가 아니라 기본이고, 그러면 라벨이
               * 같은 자리에서 겹친다. 밀어내는 규칙을 넣어도 두 줄이 붙어 읽기 어려웠다.
               *
               * 색은 선 끝 점이 그대로 들고 있으므로 정체성은 잃지 않는다.
               * 값은 위치가 고정된 곳에서 읽는 편이 오히려 빠르다.
               */
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--ink-2)' }}>
                {symbols.map((symbol) => {
                  const last = data.relativeStrength[data.relativeStrength.length - 1]?.values[symbol]
                  return (
                    <span key={symbol}>
                      <i
                        style={{
                          display: 'inline-block',
                          width: 14,
                          height: 2,
                          borderRadius: 1,
                          marginRight: 5,
                          verticalAlign: 'middle',
                          background: symbolColor(symbol, symbols),
                        }}
                      />
                      {symbol.replace(/USDT$/, '')}
                      {last === undefined ? null : (
                        <b
                          style={{
                            marginLeft: 5,
                            fontFamily: 'var(--mono)',
                            fontWeight: 600,
                            color: 'var(--ink)',
                          }}
                        >
                          {last.toFixed(2)}
                        </b>
                      )}
                    </span>
                  )
                })}
              </div>
            }
          >
            <IndexedChart points={data.relativeStrength} symbols={symbols} />
            <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
              스케일이 30배 달라 이중 축을 피하고 지수화했다
            </div>
          </Panel>

          <Panel title="Taker 매수 비율 · 24h">
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {symbols.map((symbol) => {
                const stats = data.stats.find((s) => s.symbol === symbol)
                return (
                  <div key={symbol} style={{ display: 'contents' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11,
                        color: 'var(--ink-2)',
                      }}
                    >
                      <span
                        style={{
                          width: 3,
                          height: 11,
                          borderRadius: 2,
                          background: symbolColor(symbol, symbols),
                        }}
                      />
                      {symbol.replace(/USDT$/, '')}
                    </div>
                    <TakerBar ratio={stats?.takerBuyRatio ?? 0.5} symbol={symbol} />
                  </div>
                )
              })}
            </div>
          </Panel>

          <Panel title="파이프라인 이벤트" aside={<span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{data.events.length}건</span>}>
            <EventLog events={data.events} />
          </Panel>
        </div>
      </div>
    </TooltipProvider>
  )
}

function IntervalPicker({
  value,
  base,
  onChange,
  busy,
}: {
  value: Interval
  /** 수집 해상도. 이보다 작은 봉은 만들 수 없다. */
  base: Interval
  onChange: (next: Interval) => void
  busy: boolean
}) {
  const options = selectableIntervals(base)
  return (
    <div
      role="group"
      aria-label="봉 간격"
      style={{
        display: 'flex',
        background: 'var(--plane)',
        border: '1px solid var(--axis)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {options.map((option, index) => {
        const active = option === value
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            disabled={busy}
            onClick={() => onChange(option)}
            style={{
              border: 0,
              borderLeft: index === 0 ? 0 : '1px solid var(--axis)',
              background: active ? 'var(--btc)' : 'transparent',
              color: active ? '#fff' : 'var(--ink-2)',
              fontWeight: active ? 600 : 400,
              padding: '4px 10px',
              fontSize: 12,
              cursor: busy ? 'progress' : 'pointer',
            }}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

/** 시리즈가 2개 이상이면 범례는 항상 존재한다 — 색만으로 정체성을 판단하게 하지 않는다. */
function Legend({ count }: { count: number }) {
  return (
    // flex:none — 좁은 화면에서 범례가 눌리면 글자가 차트 영역으로 넘친다
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 11,
        color: 'var(--ink-2)',
        whiteSpace: 'nowrap',
      }}
    >
      <span>
        <i style={{ ...KEY, background: 'var(--up)' }} />
        상승 (종가 ≥ 시가)
      </span>
      <span>
        <i style={{ ...KEY, background: 'var(--down)' }} />
        하락
      </span>
      <span>
        <i style={{ ...KEY, background: 'var(--ink-muted)' }} />
        MA20
      </span>
      <span style={{ marginLeft: 'auto', color: 'var(--ink-muted)' }}>
        {count}봉 · 거래량 하단 · {DISPLAY_TZ_LABEL}
      </span>
    </div>
  )
}

const KEY: React.CSSProperties = {
  display: 'inline-block',
  width: 14,
  height: 2,
  borderRadius: 1,
  marginRight: 5,
  verticalAlign: 'middle',
}
