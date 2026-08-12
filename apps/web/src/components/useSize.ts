'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 호스트 요소의 픽셀 크기를 관찰한다.
 *
 * 차트를 CSS 로 늘리지 않고 **측정한 크기로 SVG 를 다시 그리는** 이유는,
 * viewBox 로 늘리면 선 굵기와 글자까지 함께 늘어나기 때문이다. 2px 선과
 * 10px 축 라벨은 어느 크기에서도 2px·10px 여야 한다.
 */
export function useSize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const observer = new ResizeObserver(() => {
      const width = Math.floor(node.clientWidth)
      const height = Math.floor(node.clientHeight)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

/** 축 눈금을 사람이 읽기 좋은 수(1 / 2 / 2.5 / 5 배수)로 끊는다. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return []
  const raw = (hi - lo) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10

  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t)
  return ticks
}
