'use client'

import type { Candle } from '@app/shared'
import { useState } from 'react'
import { DISPLAY_TZ_LABEL, fmtAxis, fmtCompact, fmtPrice, fmtSigned, hhmm, hhmmUtc, num } from '@/lib/format'
import { useTooltip } from './Tooltip'
import { niceTicks, useSize } from './useSize'

/**
 * 캔들스틱 + 거래량.
 *
 * 한 번에 심볼 하나만 그리므로(제목이 심볼을 말한다) **색은 전부 폴라리티**
 * — 상승/하락 — 에 쓴다. 정체성과 폴라리티를 한 차트에서 동시에 색으로
 * 인코딩하지 않는다는 규칙이 여기서 지켜진다. (docs/DESIGN.md §4)
 *
 * 초록/빨강은 적록색약에서 ΔE 4.1 로 무너지지만, 캔들은 **몸통의 시가·종가
 * 위치라는 기하 인코딩**을 이미 갖고 있어 색이 유일 채널이 아니다. 그래서
 * 관례를 유지하되 색각 토글을 따로 제공한다. (§5)
 */

const PAD_RIGHT = 58
const PAD_TOP = 6
const PAD_BOTTOM = 16
const PANEL_GAP = 8
/** 마크 규격: 막대는 24px 를 넘지 않고 인접 마크 사이에 2px 여백을 둔다. */
const MAX_BODY_WIDTH = 24
const MARK_GAP = 2

export function CandleChart({
  candles,
  symbol,
  interval,
}: {
  candles: Candle[]
  symbol: string
  interval: string
}) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const tooltip = useTooltip()

  const volumeHeight = Math.max(22, Math.min(64, Math.round(height * 0.2)))
  const priceHeight = height - PAD_TOP - PAD_BOTTOM - volumeHeight - PANEL_GAP
  const plotWidth = width - PAD_RIGHT
  const ready = candles.length > 0 && plotWidth > 20 && priceHeight > 30

  return (
    <div
      ref={hostRef}
      // overflow:hidden 이 없으면 리사이즈 도중 SVG 가 잠깐 호스트보다 커져
      // 아래 범례 위에 겹쳐 그려진다. 좁은 화면에서 실제로 그랬다.
      style={{ flex: '1 1 0', minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative' }}
    >
      {ready ? (
        <Plot
          candles={candles}
          symbol={symbol}
          interval={interval}
          width={width}
          height={height}
          plotWidth={plotWidth}
          priceHeight={priceHeight}
          volumeHeight={volumeHeight}
          hover={hover}
          onHover={setHover}
          tooltip={tooltip}
        />
      ) : null}
    </div>
  )
}

function Plot({
  candles,
  symbol,
  interval,
  width,
  height,
  plotWidth,
  priceHeight,
  volumeHeight,
  hover,
  onHover,
  tooltip,
}: {
  candles: Candle[]
  symbol: string
  interval: string
  width: number
  height: number
  plotWidth: number
  priceHeight: number
  volumeHeight: number
  hover: number | null
  onHover: (index: number | null) => void
  tooltip: ReturnType<typeof useTooltip>
}) {
  const count = candles.length
  const slot = plotWidth / count
  const bodyWidth = Math.max(1, Math.min(MAX_BODY_WIDTH, slot - MARK_GAP))

  let low = Infinity
  let high = -Infinity
  let maxVolume = 0
  for (const c of candles) {
    const l = num(c.low)
    const h = num(c.high)
    const v = num(c.volume)
    if (l < low) low = l
    if (h > high) high = h
    if (v > maxVolume) maxVolume = v
  }
  const padding = (high - low) * 0.06 || 1
  low -= padding
  high += padding

  const y = (value: number): number => PAD_TOP + priceHeight - ((value - low) / (high - low)) * priceHeight
  const volumeTop = PAD_TOP + priceHeight + PANEL_GAP
  const vy = (value: number): number => volumeTop + volumeHeight - (value / (maxVolume || 1)) * volumeHeight

  const last = candles[count - 1]
  if (!last) return null
  const lastClose = num(last.close)
  const lastY = y(lastClose)
  const lastUp = lastClose >= num(last.open)

  const xLabelStep = Math.max(1, Math.round(count / 6))

  const maPath = buildMaPath(candles, slot, y)

  const handleMove = (event: React.PointerEvent<SVGRectElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = Math.max(0, Math.min(count - 1, Math.floor((event.clientX - box.left) / slot)))
    const candle = candles[index]
    if (!candle) return

    onHover(index)
    const open = num(candle.open)
    const change = ((num(candle.close) - open) / open) * 100
    tooltip.show({
      // 툴팁에는 원본 UTC 를 함께 적는다 — 수집기 로그·demo:chaos 와 대조하는 값이다.
      title: `${hhmm(candle.openTime)} ${DISPLAY_TZ_LABEL} (${hhmmUtc(candle.openTime)} UTC) · ${interval}`,
      x: event.clientX,
      y: box.top + Math.max(PAD_TOP, y(num(candle.high))),
      rows: [
        { label: '시가', value: fmtPrice(candle.open) },
        { label: '고가', value: fmtPrice(candle.high) },
        { label: '저가', value: fmtPrice(candle.low) },
        { label: '종가', value: `${fmtPrice(candle.close)} (${fmtSigned(change)}%)` },
        { label: '거래량', value: fmtCompact(num(candle.volume)) },
        { label: '체결 수', value: candle.tradeCount.toLocaleString('en-US') },
        { label: '출처', value: candle.hasBackfill ? 'REST (백필)' : 'WS' },
      ],
    })
  }

  const handleLeave = (): void => {
    onHover(null)
    tooltip.hide()
  }

  const hovered = hover === null ? null : candles[hover]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${symbol} ${interval} 캔들 차트, ${count}개 봉`}
      style={{ display: 'block' }}
    >
      {/* 그리드 — 현재가 태그와 겹치는 눈금 라벨은 지운다. 겹치면 둘 다 못 읽는다. */}
      {niceTicks(low, high, 4).map((tick) => {
        const ty = y(tick)
        if (ty < PAD_TOP || ty > PAD_TOP + priceHeight) return null
        return (
          <g key={tick}>
            <line x1={0} x2={plotWidth} y1={ty} y2={ty} stroke="var(--grid)" strokeWidth={1} />
            {Math.abs(ty - lastY) < 11 ? null : (
              <text
                x={plotWidth + 6}
                y={ty + 3.5}
                fill="var(--ink-muted)"
                fontSize={10}
                fontFamily="var(--mono)"
              >
                {fmtAxis(tick)}
              </text>
            )}
          </g>
        )
      })}

      <line
        x1={0}
        x2={plotWidth}
        y1={volumeTop + volumeHeight}
        y2={volumeTop + volumeHeight}
        stroke="var(--axis)"
        strokeWidth={1}
      />

      {/* 거래량 컬럼 — 데이터 끝만 라운드, 기준선 쪽은 각짐 */}
      <g opacity={0.55}>
        {candles.map((candle, i) => {
          const top = vy(num(candle.volume))
          const cx = i * slot + slot / 2
          const radius = Math.min(2, bodyWidth / 2)
          return (
            <rect
              key={candle.openTime}
              x={cx - bodyWidth / 2}
              y={top}
              width={bodyWidth}
              height={Math.max(1, volumeTop + volumeHeight - top)}
              rx={radius}
              ry={radius}
              fill={num(candle.close) >= num(candle.open) ? 'var(--up)' : 'var(--down)'}
            />
          )
        })}
      </g>

      {/* 캔들 */}
      {candles.map((candle, i) => {
        const cx = i * slot + slot / 2
        const open = num(candle.open)
        const close = num(candle.close)
        const color = close >= open ? 'var(--up)' : 'var(--down)'
        const yo = y(open)
        const yc = y(close)
        return (
          <g key={candle.openTime}>
            <line
              x1={cx}
              x2={cx}
              y1={y(num(candle.high))}
              y2={y(num(candle.low))}
              stroke={color}
              strokeWidth={1}
            />
            <rect
              x={cx - bodyWidth / 2}
              y={Math.min(yo, yc)}
              width={bodyWidth}
              height={Math.max(1, Math.abs(yc - yo))}
              fill={color}
            />
          </g>
        )
      })}

      {/* MA — 정체성이 아니라 참조선이므로 시리즈 색을 쓰지 않는다 */}
      {maPath ? (
        <path
          d={maPath}
          fill="none"
          stroke="var(--ink-muted)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.75}
        />
      ) : null}

      {/* x 축 */}
      {candles.map((candle, i) =>
        (i + 1) % xLabelStep === 0 ? (
          <text
            key={candle.openTime}
            x={i * slot + slot / 2}
            y={height - 4}
            fill="var(--ink-muted)"
            fontSize={10}
            fontFamily="var(--mono)"
            textAnchor="middle"
          >
            {hhmm(candle.openTime)}
          </text>
        ) : null,
      )}

      {/* 현재가 기준선 + 태그 */}
      <line
        x1={0}
        x2={plotWidth}
        y1={lastY}
        y2={lastY}
        stroke={lastUp ? 'var(--up)' : 'var(--down)'}
        strokeWidth={1}
        opacity={0.5}
      />
      <rect
        x={plotWidth + 2}
        y={lastY - 8}
        width={PAD_RIGHT - 4}
        height={16}
        rx={3}
        fill={lastUp ? 'var(--up)' : 'var(--down)'}
      />
      <text
        x={plotWidth + 6}
        y={lastY + 3.5}
        fill="#fff"
        fontSize={10}
        fontFamily="var(--mono)"
        fontWeight={600}
      >
        {fmtAxis(lastClose)}
      </text>

      {/* 크로스헤어 */}
      {hovered ? (
        <g>
          <line
            x1={(hover ?? 0) * slot + slot / 2}
            x2={(hover ?? 0) * slot + slot / 2}
            y1={PAD_TOP}
            y2={volumeTop + volumeHeight}
            stroke="var(--ink-muted)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <circle
            cx={(hover ?? 0) * slot + slot / 2}
            cy={y(num(hovered.close))}
            r={4}
            fill="var(--ink)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
        </g>
      ) : null}

      {/* 히트 영역 — 마크보다 크게 잡는다 */}
      <rect
        x={0}
        y={0}
        width={plotWidth}
        height={height}
        fill="transparent"
        style={{ cursor: 'crosshair' }}
        onPointerMove={handleMove}
        onPointerLeave={handleLeave}
      />
    </svg>
  )
}

function buildMaPath(candles: Candle[], slot: number, y: (v: number) => number): string {
  let path = ''
  let penDown = false

  candles.forEach((candle, i) => {
    if (candle.ma === null) {
      penDown = false
      return
    }
    const x = (i * slot + slot / 2).toFixed(1)
    const py = y(num(candle.ma)).toFixed(1)
    path += `${penDown ? 'L' : 'M'}${x} ${py} `
    penDown = true
  })

  return path.trim()
}
