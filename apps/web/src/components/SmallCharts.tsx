'use client'

import type { RelativeStrengthPoint } from '@app/shared'
import { useState } from 'react'
import { fmtSigned, hhmm, shortSymbol, symbolColor } from '@/lib/format'
import { useTooltip } from './Tooltip'
import { niceTicks, useSize } from './useSize'

/* ============================================================
   상대 강도 — 지수화 라인
   ============================================================ */

/**
 * 두 심볼을 한 축에서 비교한다.
 *
 * BTC 약 $64,000, ETH 약 $1,890 — 스케일이 30배 차이난다. 이중 축을 쓰면
 * 두 선의 교차점이 아무 의미도 없으면서 의미처럼 보이고, 눈금을 어떻게 잡느냐로
 * 착시를 임의로 만들 수 있다. 구간 시작을 100 으로 지수화해 축을 하나로 만든다.
 * (docs/DESIGN.md §3 — `dataviz` 가 "차트 실수 1위"로 지목한 항목)
 *
 * 여기서는 **색이 전부 정체성**이다. 등락색을 섞지 않는다.
 */
export function IndexedChart({
  points,
  symbols,
}: {
  points: RelativeStrengthPoint[]
  symbols: string[]
}) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const tooltip = useTooltip()

  const PAD_RIGHT = 52
  const PAD_TOP = 8
  const PAD_BOTTOM = 16
  const plotWidth = width - PAD_RIGHT
  const plotHeight = height - PAD_TOP - PAD_BOTTOM
  const count = points.length

  const ready = count > 1 && plotWidth > 20 && plotHeight > 24

  let lo = Infinity
  let hi = -Infinity
  if (ready) {
    for (const point of points) {
      for (const symbol of symbols) {
        const v = point.values[symbol]
        if (v === undefined) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    const pad = (hi - lo) * 0.14 || 0.5
    lo -= pad
    hi += pad
  }

  const x = (i: number): number => (i / (count - 1)) * plotWidth
  const y = (v: number): number => PAD_TOP + plotHeight - ((v - lo) / (hi - lo)) * plotHeight
  const xLabelStep = Math.max(1, Math.round(count / 5))

  /**
   * 끝점 라벨의 세로 위치.
   *
   * 각 계열이 자기 끝점 기준으로만 라벨을 놓으면, 마지막 값이 가까울 때 두 라벨이
   * 같은 자리에 겹쳐 글자가 뭉갠다. 이 차트는 **구간 시작을 100 으로 지수화**하므로
   * 값이 서로 가까운 것이 예외가 아니라 기본에 가깝다 — 특히 구간이 짧을 때 그렇다.
   *
   * 위에서부터 순서대로 놓되, 앞 라벨과 최소 간격 안으로 들어오면 아래로 민다.
   * 점(마커)은 실제 위치에 그대로 둔다 — 정확한 위치는 점이, 값은 라벨이 담당한다.
   */
  const LABEL_GAP = 12
  const labelY: Record<string, number> = {}
  if (ready) {
    let prev = -Infinity
    for (const { symbol, value } of symbols
      .map((symbol) => ({ symbol, value: points[count - 1]?.values[symbol] }))
      .filter((entry): entry is { symbol: string; value: number } => entry.value !== undefined)
      .sort((a, b) => b.value - a.value)) {
      const wanted = y(value) - 8
      const placed = wanted - prev < LABEL_GAP ? prev + LABEL_GAP : wanted
      labelY[symbol] = Math.min(placed, PAD_TOP + plotHeight - 2)
      prev = placed
    }
  }

  return (
    <div ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      {ready ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="구간 시작을 100으로 지수화한 심볼별 상대 강도"
          style={{ display: 'block' }}
        >
          {niceTicks(lo, hi, 3).map((tick) => {
            const ty = y(tick)
            if (ty < PAD_TOP || ty > PAD_TOP + plotHeight) return null
            return (
              <g key={tick}>
                <line x1={0} x2={plotWidth} y1={ty} y2={ty} stroke="var(--grid)" strokeWidth={1} />
                <text
                  x={plotWidth + 6}
                  y={ty + 3.5}
                  fill="var(--ink-muted)"
                  fontSize={10}
                  fontFamily="var(--mono)"
                >
                  {tick.toFixed(1)}
                </text>
              </g>
            )
          })}

          {/* 기준선 100 — 이 차트의 의미가 걸린 선이라 그리드보다 진하게 */}
          {lo < 100 && hi > 100 ? (
            <g>
              <line x1={0} x2={plotWidth} y1={y(100)} y2={y(100)} stroke="var(--axis)" strokeWidth={1} />
              {/* 표면색 테두리를 깔아 라인·눈금과 겹쳐도 읽히게 한다 */}
              <text
                x={2}
                y={y(100) - 5}
                fill="var(--ink-muted)"
                fontSize={9.5}
                letterSpacing=".06em"
                stroke="var(--surface)"
                strokeWidth={3}
                paintOrder="stroke"
              >
                기준 100
              </text>
            </g>
          ) : null}

          {symbols.map((symbol) => {
            const color = symbolColor(symbol, symbols)
            const path = points
              .map((p, i) => {
                const v = p.values[symbol]
                return v === undefined ? '' : `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
              })
              .filter(Boolean)
              .join(' ')

            const lastValue = points[count - 1]?.values[symbol]

            return (
              <g key={symbol}>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {lastValue === undefined ? null : (
                  <>
                    {/* 끝점 마커 — 표면색 2px 링으로 겹침에서도 읽히게 */}
                    <circle
                      cx={x(count - 1)}
                      cy={y(lastValue)}
                      r={4}
                      fill={color}
                      stroke="var(--surface)"
                      strokeWidth={2}
                    />
                    {/* 직접 라벨. 텍스트는 시리즈 색을 입지 않는다 — 정체성은 옆의 점이 담당 */}
                    <text
                      x={x(count - 1) - 8}
                      y={labelY[symbol] ?? y(lastValue) - 8}
                      textAnchor="end"
                      fill="var(--ink)"
                      fontSize={10.5}
                      fontWeight={600}
                      fontFamily="var(--mono)"
                      stroke="var(--surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {`${shortSymbol(symbol)} ${lastValue.toFixed(2)}`}
                    </text>
                  </>
                )}
              </g>
            )
          })}

          {points.map((point, i) =>
            (i + 1) % xLabelStep === 0 ? (
              <text
                key={point.openTime}
                x={x(i)}
                y={height - 3}
                fill="var(--ink-muted)"
                fontSize={10}
                fontFamily="var(--mono)"
                textAnchor="middle"
              >
                {hhmm(point.openTime)}
              </text>
            ) : null,
          )}

          {hover !== null ? (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD_TOP}
                y2={PAD_TOP + plotHeight}
                stroke="var(--ink-muted)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {symbols.map((symbol) => {
                const v = points[hover]?.values[symbol]
                return v === undefined ? null : (
                  <circle
                    key={symbol}
                    cx={x(hover)}
                    cy={y(v)}
                    r={4.5}
                    fill={symbolColor(symbol, symbols)}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                )
              })}
            </g>
          ) : null}

          <rect
            x={0}
            y={0}
            width={plotWidth}
            height={height}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              const i = Math.max(
                0,
                Math.min(count - 1, Math.round(((event.clientX - box.left) / plotWidth) * (count - 1))),
              )
              const point = points[i]
              if (!point) return
              setHover(i)
              tooltip.show({
                title: `${hhmm(point.openTime)} UTC`,
                x: event.clientX,
                y: box.top + PAD_TOP,
                rows: symbols.flatMap((symbol) => {
                  const v = point.values[symbol]
                  return v === undefined
                    ? []
                    : [
                        {
                          label: shortSymbol(symbol),
                          value: `${v.toFixed(2)} (${fmtSigned(v - 100)}%)`,
                          swatch: symbolColor(symbol, symbols),
                        },
                      ]
                }),
              })
            }}
            onPointerLeave={() => {
              setHover(null)
              tooltip.hide()
            }}
          />
        </svg>
      ) : null}
    </div>
  )
}

/* ============================================================
   Taker 매수 비율 — diverging bar
   ============================================================ */

/**
 * 축 반폭 = ±15%p (즉 35%~65%).
 *
 * ±100%p 로 잡으면 실제 값(대체로 44~52%)이 전부 중앙 1px 에 뭉개져 **아무것도
 * 안 보인다.** 목업을 눈으로 보고서야 잡힌 문제다. 축을 좁히는 대신 양 끝에
 * 범위를 적어 눈금을 속이지 않는다.
 */
const TAKER_DOMAIN = 0.15

export function TakerBar({ ratio, symbol }: { ratio: number; symbol: string }) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>()
  const tooltip = useTooltip()

  const BAR_H = 20
  const LABEL_H = 15
  const CAP_H = 12
  const showCap = height >= BAR_H + LABEL_H + CAP_H
  const top = showCap
    ? CAP_H + Math.max(0, (height - BAR_H - LABEL_H - CAP_H) / 2)
    : Math.max(0, (height - BAR_H - LABEL_H) / 2)

  const cx = width / 2
  const deviation = ratio - 0.5
  const offset = Math.max(-1, Math.min(1, deviation / TAKER_DOMAIN))
  const length = Math.abs(offset) * (width / 2)
  const isBuy = deviation >= 0
  const r = 4
  const edge = Math.round(50 - TAKER_DOMAIN * 100)

  const valueX = isBuy ? Math.min(width - 4, cx + length + 6) : Math.max(4, cx - length - 6)

  return (
    <div ref={hostRef} style={{ flex: 1, minHeight: 44, minWidth: 0 }}>
      {width > 40 && height > 24 ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${symbol} Taker 매수 비율 ${(ratio * 100).toFixed(1)}퍼센트`}
          style={{ display: 'block' }}
        >
          <rect x={0} y={top} width={width} height={BAR_H} rx={3} fill="var(--surface-2)" />

          {length > 1 ? (
            <path
              // 기준선 쪽은 각지고 데이터 끝만 라운드
              d={
                isBuy
                  ? `M${cx} ${top} H${cx + length - r} a${r} ${r} 0 0 1 ${r} ${r} V${top + BAR_H - r} a${r} ${r} 0 0 1 -${r} ${r} H${cx} Z`
                  : `M${cx} ${top} H${cx - length + r} a${r} ${r} 0 0 0 -${r} ${r} V${top + BAR_H - r} a${r} ${r} 0 0 0 ${r} ${r} H${cx} Z`
              }
              // 관례가 없는 자리이므로 검증 통과 팔레트(파랑↔빨강)를 쓴다
              fill={isBuy ? 'var(--btc)' : 'var(--critical)'}
            />
          ) : null}

          <line
            x1={cx}
            x2={cx}
            y1={top - 3}
            y2={top + BAR_H + 3}
            stroke="var(--ink-muted)"
            strokeWidth={1}
          />

          <text
            x={valueX}
            y={top + BAR_H / 2 + 3.5}
            textAnchor={isBuy ? 'start' : 'end'}
            fill="var(--ink)"
            fontSize={11.5}
            fontWeight={600}
            fontFamily="var(--mono)"
            stroke="var(--surface)"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {`${(ratio * 100).toFixed(1)}%`}
          </text>

          <text x={0} y={top + BAR_H + LABEL_H - 4} fill="var(--ink-muted)" fontSize={9.5}>
            {`◀ 매도 ${edge}%`}
          </text>
          <text
            x={width}
            y={top + BAR_H + LABEL_H - 4}
            textAnchor="end"
            fill="var(--ink-muted)"
            fontSize={9.5}
          >
            {`${100 - edge}% 매수 ▶`}
          </text>
          {showCap ? (
            <text x={cx} y={top - 4} textAnchor="middle" fill="var(--ink-muted)" fontSize={9.5}>
              50% 균형
            </text>
          ) : null}

          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="transparent"
            onPointerMove={(event) =>
              tooltip.show({
                title: `${symbol} · 최근 24h`,
                x: event.clientX,
                y: event.clientY,
                rows: [
                  { label: 'Taker 매수', value: `${(ratio * 100).toFixed(2)}%` },
                  { label: 'Taker 매도', value: `${((1 - ratio) * 100).toFixed(2)}%` },
                  {
                    label: '편향',
                    value: `${isBuy ? '매수' : '매도'} ${(Math.abs(deviation) * 100).toFixed(2)}%p`,
                  },
                  { label: '축 범위', value: `±${TAKER_DOMAIN * 100}%p` },
                ],
              })
            }
            onPointerLeave={() => tooltip.hide()}
          />
        </svg>
      ) : null}
    </div>
  )
}

/* ============================================================
   스파크라인 · 미터
   ============================================================ */

export function Sparkline({ values, color = 'var(--ink-muted)' }: { values: number[]; color?: string }) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>()
  const count = values.length

  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi === lo) {
    hi += 1
    lo -= 1
  }

  const PAD = 3
  const x = (i: number): number => (i / (count - 1)) * width
  const y = (v: number): number => PAD + (height - 2 * PAD) - ((v - lo) / (hi - lo)) * (height - 2 * PAD)

  const path =
    count > 1 ? values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ') : ''

  const lastValue = values[count - 1]

  return (
    <div ref={hostRef} style={{ height: '100%', width: '100%' }}>
      {count > 1 && width > 8 && height > 4 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block' }}>
          <path d={`${path} L${width} ${height} L0 ${height} Z`} fill={color} opacity={0.1} />
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {lastValue === undefined ? null : (
            <circle cx={x(count - 1)} cy={y(lastValue)} r={3} fill={color} stroke="var(--surface)" strokeWidth={2} />
          )}
        </svg>
      ) : null}
    </div>
  )
}

/** 한계선 대비 비율 — 2조각 파이를 쓰지 않는 자리다. 트랙은 같은 램프의 옅은 단계. */
export function Meter({ pct, color = 'var(--good)' }: { pct: number; color?: string }) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>()
  const H = Math.min(height, 8)
  const top = (height - H) / 2
  const filled = Math.max(H, (Math.min(100, pct) / 100) * width)

  return (
    <div ref={hostRef} style={{ height: 8, width: '100%' }}>
      {width > 4 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block' }}>
          <rect x={0} y={top} width={width} height={H} rx={H / 2} fill={color} opacity={0.18} />
          <rect x={0} y={top} width={filled} height={H} rx={H / 2} fill={color} />
        </svg>
      ) : null}
    </div>
  )
}
