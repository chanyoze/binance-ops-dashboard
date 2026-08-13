import type { KlineRepository, RealtimeBus } from '@app/db'
import type { AppConfig, BinanceRestClient } from '@app/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackfillService } from '../backfill-service.js'
import { WsCollector, type SocketLike } from '../ws-collector.js'
import { FakeBus, FakeRepo, FakeRestClient, fakeLogger, makeKline } from './fakes.js'

/**
 * WS 수집기 — "받아 적지 못하게 된 상황"을 감지하고 복구하는 장치들.
 *
 * 평상시 동작(받아서 저장)은 실행해 보면 바로 보이지만, **재연결과 watchdog 은
 * 장애가 나야 동작**한다. 진짜 소켓으로는 "응답하지 않는 연결"을 만들기 어려워서
 * 지금까지 실동작 검증(`npm run demo:chaos`)에만 의존하고 있었다.
 *
 * 소켓을 주입 가능하게 만들고 가짜 타이머를 쓰면 그 상황을 정확히 재현할 수 있다.
 * 여기서 검증하는 것이 곧 이 프로젝트가 "안정적으로 수집한다"고 주장하는 근거다.
 */

const MINUTE = 60_000

/** 테스트가 지시하는 대로 이벤트를 발사하는 가짜 소켓 */
class FakeSocket implements SocketLike {
  /**
   * CONNECTING(0) 에서 시작한다 — 실제 `ws` 가 그렇다.
   *
   * 처음부터 OPEN 으로 두면 아직 붙지도 않은 소켓을 watchdog 이 "조용하다"고
   * 판단해 끊어 버린다. 재연결 대기 중인 소켓이 매번 좀비로 오인되는 셈이라,
   * 백오프를 재는 테스트에 있지도 않은 stale 이벤트가 섞인다.
   */
  readyState = 0
  terminated = false
  listenersRemoved = false

  private handlers = new Map<string, Array<(...args: never[]) => void>>()

  on(event: string, handler: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  /**
   * 실제 `ws` 는 `terminate()` 뒤에 **반드시 `close` 를 발생시킨다.**
   *
   * 이 이벤트를 빼먹으면 watchdog 테스트가 "끊었다"까지만 확인하고 끝난다.
   * 수집기는 `onClose` 를 통해서만 재연결을 예약하므로, 좀비를 끊고 나서
   * 다시 붙지 않는 회귀가 생겨도 전혀 잡히지 않는다.
   */
  terminate(): void {
    this.terminated = true
    if (this.readyState === 3) return
    this.readyState = 3 // CLOSED
    this.emit('close', 1006, Buffer.from('terminated'))
  }

  removeAllListeners(): void {
    this.listenersRemoved = true
    this.handlers.clear()
  }

  /* --- 테스트가 부르는 부분 --- */

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      ;(handler as (...a: unknown[]) => void)(...args)
    }
  }

  open(): void {
    this.readyState = 1 // OPEN
    this.emit('open')
  }

  /** 서버가 연결을 닫은 상황 */
  closeFromServer(code = 1006, reason = 'abnormal'): void {
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  sendKline(symbol: string, openTime: number, isClosed = true): void {
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          stream: `${symbol.toLowerCase()}@kline_1m`,
          data: {
            e: 'kline',
            s: symbol,
            k: {
              t: openTime,
              T: openTime + MINUTE - 1,
              s: symbol,
              i: '1m',
              o: '100.00',
              c: '100.50',
              h: '101.00',
              l: '99.00',
              v: '1.0',
              n: 10,
              x: isClosed,
              q: '100.5',
              V: '0.6',
              Q: '60.3',
            },
          },
        }),
      ),
    )
  }

  sendTrade(symbol: string, price: string, tradeTime: number): void {
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          stream: `${symbol.toLowerCase()}@aggTrade`,
          data: { e: 'aggTrade', s: symbol, p: price, q: '0.5', T: tradeTime, m: false, a: 1 },
        }),
      ),
    )
  }
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SYMBOLS: ['BTCUSDT'],
    KLINE_INTERVAL: '1m',
    STALE_THRESHOLD_MS: 10_000,
    RECONNECT_BASE_MS: 1_000,
    RECONNECT_MAX_MS: 30_000,
    BINANCE_WS_BASE: 'wss://stream.example.com:9443',
    ...overrides,
  } as AppConfig
}

interface Harness {
  collector: WsCollector
  repo: FakeRepo
  bus: FakeBus
  rest: FakeRestClient
  sockets: FakeSocket[]
  /** 가장 최근에 만들어진 소켓 */
  socket: () => FakeSocket
}

function setup(config = makeConfig()): Harness {
  const repo = new FakeRepo()
  const bus = new FakeBus()
  const rest = new FakeRestClient(MINUTE)
  const backfill = new BackfillService(
    rest as unknown as BinanceRestClient,
    repo as unknown as KlineRepository,
    bus as unknown as RealtimeBus,
    fakeLogger(),
  )

  const sockets: FakeSocket[] = []
  const collector = new WsCollector(
    config,
    repo as unknown as KlineRepository,
    bus as unknown as RealtimeBus,
    backfill,
    fakeLogger(),
    () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  )

  return {
    collector,
    repo,
    bus,
    rest,
    sockets,
    socket: () => sockets[sockets.length - 1]!,
  }
}

/** 타이머를 앞으로 감으면서 그 사이 예약된 비동기 작업도 흘려보낸다 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('WsCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('수신', () => {
    it('확정된 봉을 저장하고 대시보드에 알린다', async () => {
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)

      h.socket().sendKline('BTCUSDT', 1_700_000_000_000)
      await advance(0)

      expect(h.repo.candles.size).toBe(1)
      expect(h.bus.published.some((p) => p.channel === 'kline_update')).toBe(true)

      await h.collector.stop()
    })

    it('aggTrade 는 저장하지 않고 최신가만 반영한다', async () => {
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)

      h.socket().sendTrade('BTCUSDT', '64123.45', Date.now())
      await advance(1_100) // 상태 플러시 주기

      // 봉으로 저장되지 않는다
      expect(h.repo.candles.size).toBe(0)
      // 최신가는 상태로 반영된다
      const priced = h.repo.stateUpdates.filter((u) => u.patch.lastPrice === '64123.45')
      expect(priced.length).toBeGreaterThan(0)

      await h.collector.stop()
    })

    it('kline 만 오는 심볼도 수신 시각이 갱신된다', async () => {
      // 체결이 뜸한 심볼이 stale 로 보이던 버그의 회귀 테스트.
      // aggTrade 없이 kline 만 와도 그 심볼의 "마지막 수신"이 움직여야 한다.
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)
      h.repo.stateUpdates.length = 0

      h.socket().sendKline('BTCUSDT', 1_700_000_000_000)
      await advance(1_100)

      const touched = h.repo.stateUpdates.filter(
        (u) => u.symbol === 'BTCUSDT' && u.patch.lastMessageAtMs != null,
      )
      expect(touched.length).toBeGreaterThan(0)

      await h.collector.stop()
    })
  })

  describe('watchdog — 좀비 연결', () => {
    it('임계 시간 무소식이면 연결을 강제로 끊는다', async () => {
      const h = setup(makeConfig({ STALE_THRESHOLD_MS: 10_000 }))
      h.collector.start()
      h.socket().open()
      await advance(0)

      const zombie = h.socket()
      expect(zombie.terminated).toBe(false)

      // 소켓은 OPEN 인데 메시지만 안 온다 — onclose 가 영영 안 오는 상황
      await advance(11_000)

      expect(zombie.terminated).toBe(true)
      expect(h.repo.eventsOfType('stale_detected')).toHaveLength(1)

      // 끊는 것으로 끝나면 수집은 멈춘 채다. 끊은 뒤 **다시 붙는 것**까지가 복구다.
      expect(h.repo.eventsOfType('reconnecting')).toHaveLength(1)
      await advance(3_000)
      expect(h.sockets.length).toBeGreaterThanOrEqual(2)
      expect(h.socket()).not.toBe(zombie)

      await h.collector.stop()
    })

    it('메시지가 계속 오면 끊지 않는다', async () => {
      const h = setup(makeConfig({ STALE_THRESHOLD_MS: 10_000 }))
      h.collector.start()
      h.socket().open()
      await advance(0)

      // 5초마다 소식이 오는 정상 상태를 30초간 유지
      for (let i = 0; i < 6; i += 1) {
        await advance(5_000)
        h.socket().sendTrade('BTCUSDT', '100.00', Date.now())
      }

      expect(h.socket().terminated).toBe(false)
      expect(h.repo.eventsOfType('stale_detected')).toHaveLength(0)

      await h.collector.stop()
    })

    it('close() 가 아니라 terminate() 를 쓴다', async () => {
      // 응답하지 않는 소켓은 close 핸드셰이크도 끝내지 못한다.
      // close() 를 부르면 그 자리에서 다시 멈춘다.
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)

      // 끊긴 뒤에는 재연결로 새 소켓이 생기므로, 검사 대상을 미리 붙잡아 둔다.
      const zombie = h.socket()
      await advance(11_000)

      expect(zombie.terminated).toBe(true)
      await h.collector.stop()
    })
  })

  describe('재연결', () => {
    it('연결이 끊기면 백오프 뒤에 다시 붙는다', async () => {
      const h = setup(makeConfig({ RECONNECT_BASE_MS: 1_000 }))
      h.collector.start()
      h.socket().open()
      await advance(0)

      expect(h.sockets).toHaveLength(1)
      h.socket().closeFromServer()
      await advance(0)

      expect(h.repo.eventsOfType('disconnected')).toHaveLength(1)
      expect(h.repo.eventsOfType('reconnecting')).toHaveLength(1)

      // 백오프에 jitter 가 있으므로 넉넉히 감는다
      await advance(3_000)
      expect(h.sockets.length).toBeGreaterThanOrEqual(2)

      await h.collector.stop()
    })

    it('재연결 시도마다 대기 시간이 늘어난다', async () => {
      const h = setup(makeConfig({ RECONNECT_BASE_MS: 1_000, RECONNECT_MAX_MS: 30_000 }))
      h.collector.start()
      h.socket().open()
      await advance(0)

      for (let i = 0; i < 3; i += 1) {
        h.socket().closeFromServer()
        await advance(40_000)
      }

      const delays = h.repo
        .eventsOfType('reconnecting')
        .map((e) => Number(e.detail.delayMs))

      expect(delays).toHaveLength(3)
      // jitter 때문에 값이 흔들리므로 상한선의 증가만 본다 (1s → 2s → 4s 기준)
      expect(delays[0]).toBeLessThanOrEqual(1_000)
      expect(delays[2]).toBeGreaterThan(delays[0]!)
      expect(Math.max(...delays)).toBeLessThanOrEqual(30_000)

      await h.collector.stop()
    })

    it('error 이벤트로는 재연결을 예약하지 않는다', async () => {
      // 'error' 뒤에는 'close' 가 따라온다. 여기서도 예약하면 연결이 두 개 열린다.
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)

      h.socket().emit('error', new Error('ECONNRESET'))
      await advance(5_000)

      expect(h.repo.eventsOfType('error')).toHaveLength(1)
      expect(h.repo.eventsOfType('reconnecting')).toHaveLength(0)
      expect(h.sockets).toHaveLength(1)

      await h.collector.stop()
    })

    it('재연결에 성공하면 끊긴 동안의 구멍을 스스로 메운다', async () => {
      const h = setup()
      // 끊기기 전에 봉이 하나 있었다고 두면, 재연결 복구가 거기서부터 채운다.
      h.repo.seed([makeKline('BTCUSDT', '1m', Date.now() - 5 * MINUTE)])

      h.collector.start()
      h.socket().open()
      await advance(0)

      h.socket().closeFromServer()
      await advance(3_000)
      h.socket().open()
      await advance(0)

      const completed = h.repo.eventsOfType('backfill_completed')
      expect(completed.length).toBeGreaterThan(0)
      expect(completed[0]?.detail.reason).toBe('reconnect')

      await h.collector.stop()
    })

    it('갭 복구가 실패해도 수집은 계속된다', async () => {
      // 복구 실패가 수집기를 죽이면 안 된다. 스캐너가 다시 시도한다.
      const h = setup()
      h.repo.seed([makeKline('BTCUSDT', '1m', Date.now() - 5 * MINUTE)])
      h.collector.start()
      h.socket().open()
      await advance(0)

      h.repo.failNextUpsert = true
      h.socket().closeFromServer()
      await advance(3_000)
      h.socket().open()
      await advance(0)

      // 복구는 실패했지만 소켓은 살아 있고 새 봉을 받는다
      h.socket().sendKline('BTCUSDT', Date.now())
      await advance(0)

      expect(h.repo.candles.size).toBeGreaterThan(1)

      await h.collector.stop()
    })

    it('재연결 중에는 uptime 을 비우고 재연결 횟수를 올린다', async () => {
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)
      h.repo.stateUpdates.length = 0

      h.socket().closeFromServer()
      await advance(0)

      const patch = h.repo.stateUpdates.find((u) => u.patch.incrementReconnect === true)
      expect(patch).toBeDefined()
      expect(patch?.patch.wsConnectedSinceMs).toBeNull()

      await h.collector.stop()
    })
  })

  describe('stop', () => {
    it('정지하면 타이머가 멈추고 더 이상 재연결하지 않는다', async () => {
      const h = setup()
      h.collector.start()
      h.socket().open()
      await advance(0)

      await h.collector.stop()
      const socketCount = h.sockets.length

      await advance(60_000)

      expect(h.sockets).toHaveLength(socketCount)
    })
  })
})
