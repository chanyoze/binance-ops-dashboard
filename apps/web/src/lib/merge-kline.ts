import type { Candle, Kline } from '@app/shared'
import type { DashboardPayload } from '@/server/dashboard'

/**
 * 실시간으로 도착한 봉을 화면의 캔들 배열에 반영한다.
 *
 * 훅 안에 두었다가 꺼냈다. 순수 함수이고, **여기가 틀리면 화면이 조용히 거짓말한다** —
 * 봉이 중복으로 쌓이거나, 진행 중 봉이 확정 봉을 밀어내거나, 배열 길이가 자라
 * 차트의 시간 축이 어긋나도 오류는 나지 않는다. 그래서 테스트가 닿는 자리에 둔다.
 * (AGENTS.md — 순수 함수와 I/O 를 분리한다)
 */
export function mergeKline(prev: DashboardPayload, kline: Kline): DashboardPayload {
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
