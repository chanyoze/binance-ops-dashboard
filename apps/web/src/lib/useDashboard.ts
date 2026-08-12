'use client'

import type { Candle, Interval, Kline, OpsSnapshot, PipelineEvent } from '@app/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DashboardPayload } from '@/server/dashboard'

/**
 * 대시보드 상태.
 *
 * 서버가 채워 준 초기 페이로드에서 출발해 SSE 로 갱신한다. 화면이 빈 채로 뜬 뒤
 * 클라이언트가 다시 받아오는 구조가 아니다 — 운영 대시보드가 열릴 때마다
 * "데이터 없음"을 잠깐 보여주면 그 자체로 신뢰를 깎는다.
 *
 * SSE 는 재연결이 브라우저에 내장돼 있어 우리가 백오프를 만들 필요가 없다.
 * 다만 **끊겼다가 붙는 동안 놓친 캔들이 있으므로**, 재연결 시 초기 페이로드를
 * 한 번 다시 받아 상태를 맞춘다. 수집기가 갭을 백필하는 것과 같은 발상이다.
 */

export type ConnectionState = 'connecting' | 'live' | 'reconnecting'

interface TickerMessage {
  symbol: string
  price: string
  at: number
}

export interface DashboardState {
  data: DashboardPayload
  /** aggTrade 틱 가격. 봉 종가보다 최대 60초 신선하다. */
  prices: Record<string, { price: string; at: number }>
  connection: ConnectionState
  interval: Interval
  setInterval: (interval: Interval) => void
  loadingCandles: boolean
}

export function useDashboard(initial: DashboardPayload): DashboardState {
  const [data, setData] = useState(initial)
  const [prices, setPrices] = useState<Record<string, { price: string; at: number }>>({})
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [interval, setIntervalState] = useState<Interval>(initial.interval)
  const [loadingCandles, setLoadingCandles] = useState(false)

  // 이벤트 핸들러가 최신 인터벌을 봐야 하는데, 의존성에 넣으면 인터벌을 바꿀 때마다
  // SSE 가 끊겼다 붙는다. ref 로 읽는다.
  const intervalRef = useRef(interval)
  intervalRef.current = interval

  /** 끊겼다 붙었을 때 놓친 구간을 메운다. */
  const resync = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard?interval=${intervalRef.current}`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      setData(await res.json())
    } catch {
      // 실패해도 SSE 가 계속 갱신한다. 다음 재연결에서 다시 시도된다.
    }
  }, [])

  useEffect(() => {
    const source = new EventSource('/api/stream')
    let everOpened = false

    source.addEventListener('open', () => {
      // 첫 연결이 아니면 끊겼다 붙은 것이다 — 놓친 구간을 메운다.
      if (everOpened) void resync()
      everOpened = true
      setConnection('live')
    })

    source.addEventListener('error', () => {
      // EventSource 가 알아서 재연결한다. 상태만 표시한다.
      setConnection('reconnecting')
    })

    source.addEventListener('ops', (event) => {
      const ops = JSON.parse((event as MessageEvent<string>).data) as OpsSnapshot
      setData((prev) => ({ ...prev, ops, at: ops.at }))
    })

    source.addEventListener('ticker', (event) => {
      const tick = JSON.parse((event as MessageEvent<string>).data) as TickerMessage
      setPrices((prev) => ({ ...prev, [tick.symbol]: { price: tick.price, at: tick.at } }))
    })

    source.addEventListener('kline', (event) => {
      const kline = JSON.parse((event as MessageEvent<string>).data) as Kline
      // 1분봉 화면에서만 즉시 반영한다. 5m/1h 는 서버가 접어 주는 값이라
      // 여기서 흉내내면 화면과 API 의 계산이 갈린다.
      if (intervalRef.current !== '1m') return
      setData((prev) => mergeKline(prev, kline))
    })

    source.addEventListener('pipeline', (event) => {
      const pipelineEvent = JSON.parse((event as MessageEvent<string>).data) as PipelineEvent
      setData((prev) => ({ ...prev, events: [pipelineEvent, ...prev.events].slice(0, 30) }))
    })

    return () => source.close()
  }, [resync])

  const setInterval = useCallback((next: Interval) => {
    setIntervalState(next)
    setLoadingCandles(true)
    void (async () => {
      try {
        const res = await fetch(`/api/dashboard?interval=${next}`, { cache: 'no-store' })
        if (res.ok) setData(await res.json())
      } finally {
        setLoadingCandles(false)
      }
    })()
  }, [])

  return { data, prices, connection, interval, setInterval, loadingCandles }
}

/**
 * 실시간으로 도착한 봉을 배열에 반영한다.
 * 같은 봉이면 덮고(진행 중 봉은 매초 갱신된다), 새 봉이면 밀어 넣으면서 앞을 자른다.
 */
function mergeKline(prev: DashboardPayload, kline: Kline): DashboardPayload {
  const list = prev.candles[kline.symbol]
  if (!list) return prev

  const incoming: Candle = {
    openTime: kline.openTime,
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close,
    volume: kline.volume,
    quoteVolume: kline.quoteVolume,
    tradeCount: kline.tradeCount,
    takerBuyQuote: kline.takerBuyQuote,
    // MA 는 서버가 윈도우 함수로 계산한다. 여기서 흉내내면 정의가 갈리므로
    // 다음 전체 갱신 때까지 이 봉만 선이 비어 있게 둔다.
    ma: null,
    hasBackfill: kline.source === 'rest',
    isClosed: kline.isClosed,
  }

  const last = list[list.length - 1]
  const next =
    last && last.openTime === kline.openTime
      ? [...list.slice(0, -1), { ...incoming, ma: last.ma }]
      : [...list, incoming].slice(-list.length)

  return { ...prev, candles: { ...prev.candles, [kline.symbol]: next } }
}
