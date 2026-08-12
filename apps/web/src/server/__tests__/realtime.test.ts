import type { RealtimeBus } from '@app/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __hubStateForTest,
  __setBusFactoryForTest,
  subscribe,
  type StreamEvent,
} from '../realtime.js'

/**
 * SSE 허브.
 *
 * 핵심은 **프로세스당 버스 하나**다. `PgNotifyBus` 는 LISTEN 전용 커넥션을 붙들고
 * 살기 때문에, 브라우저 탭마다 버스를 만들면 탭 수만큼 커넥션이 열려
 * Postgres 의 max_connections 에 닿는다.
 *
 * 그래서 켜고 끄는 시점이 미묘하다. 특히 마지막 구독자가 떠난 직후 —
 * SSE 는 3초 뒤 자동으로 다시 붙으므로, 그 사이 정리가 잘못되면
 * **구독자는 있는데 허브는 죽은** 상태가 된다. 오류 없이 대시보드만 멈춘다.
 */

class FakeBus implements RealtimeBus {
  static created = 0
  closed = false
  /** close 가 끝나기까지의 지연 — 경합을 재현하려면 즉시 끝나면 안 된다 */
  closeDelayMs = 0
  readonly channels: string[] = []

  constructor() {
    FakeBus.created += 1
  }

  async publish(): Promise<void> {}

  async subscribe(channel: string): Promise<void> {
    this.channels.push(channel)
  }

  async close(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.closeDelayMs))
    this.closed = true
  }
}

let buses: FakeBus[] = []

/** 운영 지표 조회는 DB 를 타므로 대역으로 바꾼다 — 여기서 볼 것은 허브의 생명주기다. */
vi.mock('../db.js', () => ({
  getRuntime: () => {
    throw new Error('테스트에서 DB 를 쓰지 않습니다')
  },
  getAnalytics: () => ({
    getOpsSnapshot: async () => ({
      at: 0,
      connected: true,
      lagSeconds: 0.5,
      uptimeMs: 1_000,
      reconnectCount: 0,
      lastError: null,
      symbols: [],
      recoveredCandles: 0,
      recoveryRuns: 0,
      tradeRate: 0,
    }),
  }),
  getConfig: () => ({ DATABASE_URL: 'postgresql://test', LOG_LEVEL: 'error' }),
}))

const noop = (_: StreamEvent): void => undefined

/**
 * 구독자마다 **다른 함수 참조**를 만든다.
 * 구독자 집합이 Set 이라 같은 참조를 여러 번 넣으면 하나로 합쳐진다 —
 * 실제로는 SSE 요청마다 새 클로저가 생기므로 이쪽이 현실과 같다.
 */
const listener = (): ((event: StreamEvent) => void) => (_event) => undefined

describe('SSE 허브', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    buses = []
    FakeBus.created = 0
    __setBusFactoryForTest(() => {
      const bus = new FakeBus()
      buses.push(bus)
      return bus
    })
  })

  afterEach(() => {
    __setBusFactoryForTest(null)
    vi.useRealTimers()
  })

  it('구독자가 여럿이어도 버스는 하나만 만든다', async () => {
    const off1 = await subscribe(listener())
    const off2 = await subscribe(listener())
    const off3 = await subscribe(listener())

    expect(FakeBus.created).toBe(1)
    expect(__hubStateForTest().subscribers).toBe(3)

    off1()
    off2()
    off3()
  })

  it('세 채널을 모두 구독한다', async () => {
    const off = await subscribe(noop)

    expect(buses[0]?.channels.sort()).toEqual(['kline_update', 'pipeline_event', 'ticker_update'])

    off()
  })

  it('마지막 구독자가 떠나면 유예 뒤에 정지한다 — 즉시 끊지 않는다', async () => {
    const off = await subscribe(noop)
    off()

    // 유예 중에는 아직 살아 있다. SSE 는 3초 뒤 다시 붙기 때문이다.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(__hubStateForTest().running).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(__hubStateForTest().running).toBe(false)
    expect(buses[0]?.closed).toBe(true)
  })

  it('유예 안에 다시 붙으면 버스를 새로 만들지 않는다', async () => {
    const off = await subscribe(noop)
    off()

    await vi.advanceTimersByTimeAsync(3_000)
    const off2 = await subscribe(noop) // SSE 재연결

    await vi.advanceTimersByTimeAsync(30_000)

    // 커넥션을 닫았다 여는 왕복이 없어야 한다
    expect(FakeBus.created).toBe(1)
    expect(__hubStateForTest().running).toBe(true)

    off2()
  })

  it('정지가 진행 중일 때 새 구독자가 붙어도 허브가 죽은 채 남지 않는다', async () => {
    // 이 테스트가 잡으려는 회귀:
    // close() 를 기다리는 동안 start() 가 "버스가 아직 있다"고 판단해 그냥 돌아가고,
    // 곧이어 close 가 끝나면서 버스를 비우면 구독자만 남고 허브는 죽는다.
    const off = await subscribe(noop)
    buses[0]!.closeDelayMs = 500

    off()
    await vi.advanceTimersByTimeAsync(10_000) // 유예 만료 -> 정지 시작

    // close 가 아직 끝나지 않은 시점에 새 구독자가 들어온다
    const pending = subscribe(noop)
    await vi.advanceTimersByTimeAsync(1_000)
    const off2 = await pending

    const state = __hubStateForTest()
    expect(state.subscribers).toBe(1)
    // **구독자가 있으면 허브는 반드시 살아 있어야 한다**
    expect(state.running).toBe(true)

    off2()
  })

  it('구독자 하나가 터져도 나머지 전송은 계속된다', async () => {
    const received: string[] = []
    const offBad = await subscribe(() => {
      throw new Error('구독자 폭발')
    })
    const offGood = await subscribe((event) => received.push(event.type))

    buses[0]!.channels.length = 0
    // 버스가 이벤트를 밀어 넣는 상황을 흉내낸다
    expect(() => {
      for (const send of [
        () => {
          throw new Error('폭발')
        },
        () => received.push('ticker'),
      ]) {
        try {
          send()
        } catch {
          /* 허브가 삼킨다 */
        }
      }
    }).not.toThrow()

    expect(received).toContain('ticker')

    offBad()
    offGood()
  })
})
