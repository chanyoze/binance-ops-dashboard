// @vitest-environment jsdom
import type { DashboardPayload } from '@/server/dashboard'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashboard } from '../useDashboard.js'

/**
 * 대시보드 훅 — **배선**을 본다.
 *
 * 판정 로직은 이미 순수 함수로 빼서 테스트했다(`stream-health`, `merge-kline`).
 * 남은 것은 그 판정을 실제 `EventSource` 에 잇는 부분이고, 여기가 조용히 틀린다.
 *
 * 예를 들어 어느 한 핸들러에서 `signal()` 호출을 빠뜨리면, 그 종류의 이벤트만 오는
 * 동안 스트림이 멎은 것으로 오판해 **무거운 집계 폴링이 상시로 돈다.** 화면은
 * 멀쩡히 갱신되므로 아무도 눈치채지 못한다. 그런 것을 잡으려고 쓴다.
 */

const T0 = 1_700_000_000_000
const MINUTE = 60_000

/** jsdom 에는 EventSource 가 없다. 테스트가 직접 이벤트를 밀어 넣을 수 있게 만든다. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    const found = FakeEventSource.instances.at(-1)
    if (!found) throw new Error('EventSource 가 만들어지지 않았습니다')
    return found
  }

  closed = false
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  /* --- 테스트가 부르는 부분 --- */

  private fire(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  open(): void {
    this.fire('open', {})
  }

  fail(): void {
    this.fire('error', {})
  }

  send(type: string, data: unknown): void {
    this.fire(type, { data: JSON.stringify(data) })
  }
}

const ops = (over: Record<string, unknown> = {}) => ({
  at: T0,
  connected: true,
  lagSeconds: 0.5,
  uptimeMs: 1_000,
  reconnectCount: 0,
  lastError: null,
  symbols: [],
  recoveredCandles: 0,
  recoveryRuns: 0,
  tradeRate: 0,
  ...over,
})

const candle = (openTime: number) => ({
  openTime,
  open: '100',
  high: '101',
  low: '99',
  close: '100',
  volume: '10',
  quoteVolume: '1000',
  tradeCount: 5,
  takerBuyQuote: '500',
  ma: '100',
  hasBackfill: false,
  isClosed: true,
})

const initial = (): DashboardPayload =>
  ({
    at: T0,
    symbols: ['BTCUSDT'],
    interval: '1m',
    baseInterval: '1m',
    ops: ops(),
    stats: [],
    coverage: [],
    candles: { BTCUSDT: [candle(T0), candle(T0 + MINUTE)] },
    relativeStrength: [],
    events: [],
  }) as unknown as DashboardPayload

const kline = (openTime: number, close: string) => ({
  symbol: 'BTCUSDT',
  interval: '1m',
  openTime,
  closeTime: openTime + MINUTE - 1,
  open: '100',
  high: '101',
  low: '99',
  close,
  volume: '10',
  quoteVolume: '1000',
  tradeCount: 5,
  takerBuyBase: '5',
  takerBuyQuote: '500',
  isClosed: true,
  source: 'ws',
})

let fetchMock: ReturnType<typeof vi.fn>

/** 폴링/재동기화가 몇 번 일어났는지 센다. */
const dashboardCalls = (): string[] =>
  fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/api/dashboard'))

describe('useDashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...initial(), at: T0 + 999 }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('스트림 배선', () => {
    it('ops 이벤트가 운영 지표를 갱신한다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
        FakeEventSource.last.send('ops', ops({ at: T0 + 5, lagSeconds: 2.5 }))
      })

      expect(result.current.data.ops.lagSeconds).toBe(2.5)
      // 서버 시각을 함께 갱신해야 화면의 경과 계산이 밀리지 않는다.
      expect(result.current.data.at).toBe(T0 + 5)
    })

    it('ticker 이벤트가 틱 가격을 갱신한다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
        FakeEventSource.last.send('ticker', { symbol: 'BTCUSDT', price: '101.5', at: T0 })
      })

      expect(result.current.prices.BTCUSDT?.price).toBe('101.5')
    })

    it('pipeline 이벤트를 앞에 붙이고 30건으로 자른다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
        for (let i = 0; i < 35; i += 1) {
          FakeEventSource.last.send('pipeline', { id: i, type: 'connected' })
        }
      })

      const events = result.current.data.events as unknown as Array<{ id: number }>
      expect(events).toHaveLength(30)
      // 최신이 앞이다. 뒤에 붙이면 표가 오래된 것부터 보인다.
      expect(events[0]?.id).toBe(34)
    })

    it('1분봉 화면에서만 실시간 봉을 병합한다', async () => {
      // 5m/1h 는 서버가 접어 주는 값이라 여기서 흉내내면 화면과 API 의 계산이 갈린다.
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
        FakeEventSource.last.send('kline', kline(T0 + MINUTE, '999'))
      })

      expect(result.current.data.candles.BTCUSDT?.at(-1)?.close).toBe('999')
    })
  })

  describe('스트림 감시 — 멎으면 폴링으로 갱신한다', () => {
    it('이벤트가 계속 오면 live 를 유지하고 폴링하지 않는다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
      })

      // 임계(8초)보다 짧은 간격으로 계속 소식이 온다.
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000)
          FakeEventSource.last.send('ops', ops({ at: T0 + i }))
        })
      }

      expect(result.current.connection).toBe('live')
      // 정상 환경에서 폴링이 돌면 무거운 집계가 상시로 도는 셈이다.
      expect(dashboardCalls()).toHaveLength(0)
    })

    it('임계를 넘도록 조용하면 stalled 로 바뀌고 폴링을 시작한다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
        // 상태 표시는 감시 틱에서 갱신된다. 열린 직후에는 아직 'connecting' 이다.
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(result.current.connection).toBe('live')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000)
      })

      expect(result.current.connection).toBe('stalled')
      expect(dashboardCalls().length).toBeGreaterThan(0)
    })

    it('폴링 주기를 지킨다 — 매 초 두들기지 않는다', async () => {
      renderHook(() => useDashboard(initial()))
      await act(async () => {
        FakeEventSource.last.open()
      })

      // 임계가 8초라 첫 폴링은 t=8s 에 일어난다.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_500)
      })
      expect(dashboardCalls()).toHaveLength(1)

      // 폴링 주기는 5초다. t=12s 까지는 아직 한 번이어야 한다.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500)
      })
      expect(dashboardCalls()).toHaveLength(1)

      // t=13s 에 두 번째가 나간다.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      expect(dashboardCalls()).toHaveLength(2)
    })

    it('이벤트가 다시 오면 곧바로 live 로 돌아오고 폴링을 멈춘다', async () => {
      // 여기가 안 되면 SSE 가 살아난 뒤에도 폴링과 스트림이 함께 상태를 쓴다.
      const { result } = renderHook(() => useDashboard(initial()))
      await act(async () => {
        FakeEventSource.last.open()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000)
      })
      expect(result.current.connection).toBe('stalled')

      // 소식이 도착하면 다음 감시 틱에서 곧바로 회복된다.
      await act(async () => {
        FakeEventSource.last.send('ops', ops())
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(result.current.connection).toBe('live')

      // 임계 안에서 소식이 계속 오는 동안에는 폴링이 한 번도 늘지 않아야 한다.
      const settled = dashboardCalls().length
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000)
          FakeEventSource.last.send('ops', ops())
        })
      }

      expect(dashboardCalls()).toHaveLength(settled)
      expect(result.current.connection).toBe('live')
    })

    it('연결이 끊기면 reconnecting 이고 폴링하지 않는다', async () => {
      // 연결이 없으면 폴링도 실패한다. 부하만 늘고 얻는 것이 없다.
      const { result } = renderHook(() => useDashboard(initial()))
      await act(async () => {
        FakeEventSource.last.open()
        FakeEventSource.last.fail()
        await vi.advanceTimersByTimeAsync(20_000)
      })

      expect(result.current.connection).toBe('reconnecting')
      expect(dashboardCalls()).toHaveLength(0)
    })
  })

  describe('재연결', () => {
    it('다시 붙으면 놓친 구간을 받아온다 — 첫 연결에서는 받지 않는다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        FakeEventSource.last.open()
      })
      // 첫 연결에서 받아오면 초기 페이로드를 두 번 받는 셈이다.
      expect(dashboardCalls()).toHaveLength(0)

      await act(async () => {
        FakeEventSource.last.fail()
        FakeEventSource.last.open()
        // 상태 표시는 감시 틱에서 갱신된다.
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(dashboardCalls()).toHaveLength(1)
      expect(result.current.connection).toBe('live')
    })

    it('받아올 때 틱 가격을 버린다 — 멎은 시점의 값을 현재가로 두지 않는다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))
      await act(async () => {
        FakeEventSource.last.open()
        FakeEventSource.last.send('ticker', { symbol: 'BTCUSDT', price: '101.5', at: T0 })
      })
      expect(result.current.prices.BTCUSDT).toBeDefined()

      await act(async () => {
        FakeEventSource.last.fail()
        FakeEventSource.last.open()
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(result.current.prices.BTCUSDT).toBeUndefined()
    })
  })

  describe('정리', () => {
    it('언마운트하면 스트림을 닫고 감시도 멈춘다', async () => {
      // 타이머가 남으면 화면을 떠난 뒤에도 무거운 집계를 계속 두들긴다.
      const { unmount } = renderHook(() => useDashboard(initial()))
      await act(async () => {
        FakeEventSource.last.open()
      })

      const source = FakeEventSource.last
      unmount()

      expect(source.closed).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(dashboardCalls()).toHaveLength(0)
    })
  })

  describe('인터벌 전환', () => {
    it('바꾸면 그 해상도로 다시 받아온다', async () => {
      const { result } = renderHook(() => useDashboard(initial()))

      await act(async () => {
        result.current.setInterval('15m')
      })

      expect(result.current.interval).toBe('15m')
      expect(dashboardCalls().some((url) => url.includes('interval=15m'))).toBe(true)
      expect(result.current.loadingCandles).toBe(false)
    })

    it('전환한 뒤에는 1분봉 실시간 병합을 하지 않는다', async () => {
      // ref 로 최신 인터벌을 읽지 않으면 5m 화면에 1m 봉이 섞여 들어간다.
      const { result } = renderHook(() => useDashboard(initial()))
      await act(async () => {
        FakeEventSource.last.open()
        result.current.setInterval('5m')
      })

      const before = result.current.data.candles.BTCUSDT?.at(-1)?.close

      await act(async () => {
        FakeEventSource.last.send('kline', kline(T0 + MINUTE, '999'))
      })

      expect(result.current.data.candles.BTCUSDT?.at(-1)?.close).toBe(before)
    })
  })
})
