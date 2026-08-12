'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * 차트 호버 툴팁.
 *
 * `dataviz` 는 HTML/SVG 차트에 호버 레이어를 **기본 탑재**하도록 요구한다.
 * 라인·영역에는 크로스헤어, 캔들·막대에는 마크별 툴팁이다.
 * 툴팁 하나를 문서 최상단에 두고 좌표만 옮긴다 — 차트마다 DOM 을 만들면
 * 겹칠 때 z-index 싸움이 시작된다.
 */

export interface TooltipRow {
  label: string
  value: string
  swatch?: string
}

interface TooltipContent {
  title: string
  rows: TooltipRow[]
  x: number
  y: number
}

interface TooltipApi {
  show: (content: TooltipContent) => void
  hide: () => void
}

const Context = createContext<TooltipApi | null>(null)

export function useTooltip(): TooltipApi {
  const api = useContext(Context)
  if (!api) throw new Error('TooltipProvider 안에서만 사용할 수 있습니다')
  return api
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<TooltipContent | null>(null)

  const api = useMemo<TooltipApi>(
    () => ({
      show: (next) => setContent(next),
      hide: () => setContent(null),
    }),
    [],
  )

  return (
    <Context.Provider value={api}>
      {children}
      {content ? <TooltipLayer content={content} /> : null}
    </Context.Provider>
  )
}

function TooltipLayer({ content }: { content: TooltipContent }) {
  // 화면 밖으로 나가지 않게 가둔다. 오른쪽 끝 캔들에 호버하면 그냥 잘린다.
  const clamp = useCallback((x: number, y: number) => {
    const width = 190
    const left = Math.min(Math.max(x, width / 2 + 8), window.innerWidth - width / 2 - 8)
    const top = Math.max(y - 14, 8)
    return { left, top }
  }, [])

  const { left, top } = clamp(content.x, content.y)

  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left,
        top,
        transform: 'translate(-50%, -100%)',
        zIndex: 60,
        pointerEvents: 'none',
        minWidth: 150,
        padding: '7px 9px',
        borderRadius: 6,
        background: 'var(--surface-2)',
        border: '1px solid var(--axis)',
        boxShadow: '0 8px 24px rgba(0,0,0,.5)',
        fontSize: 11.5,
        color: 'var(--ink-2)',
      }}
    >
      <div
        style={{
          color: 'var(--ink)',
          fontWeight: 600,
          fontFamily: 'var(--mono)',
          marginBottom: 4,
        }}
      >
        {content.title}
      </div>
      {content.rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 14,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>
            {row.swatch ? (
              <i
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  marginRight: 5,
                  background: row.swatch,
                }}
              />
            ) : null}
            {row.label}
          </span>
          <span style={{ color: 'var(--ink)', fontFamily: 'var(--mono)' }}>{row.value}</span>
        </div>
      ))}
    </div>
  )
}
