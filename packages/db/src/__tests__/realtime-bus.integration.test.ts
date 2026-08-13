import type { Logger } from '@app/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { CHANNELS, PgNotifyBus } from '../realtime-bus.js'

/**
 * LISTEN/NOTIFY 버스 — 수집기와 웹을 잇는 유일한 실시간 경로.
 *
 * 여기가 멎으면 대시보드가 **오류 없이** 갱신을 멈춘다. 지금은 클라이언트 watchdog 이
 * 그것을 잡아 폴링으로 넘어가지만, 그건 마지막 그물이지 정상 동작이 아니다.
 *
 * DB 가 없으면 조용히 건너뛴다. 채널명 검증처럼 DB 가 필요 없는 것은 항상 돈다.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://binance:binance@localhost:5432/binance_ops'

const noop = (): void => undefined
const silent = (): Logger => {
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger
}

/** 알림은 비동기로 온다. 조건이 찰 때까지 짧게 기다린다. */
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('기다리던 알림이 오지 않았습니다')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('채널명 검증 — DB 없이도 돈다', () => {
  it('식별자로 쓸 수 없는 이름은 거절한다', async () => {
    /*
     * 채널명은 `LISTEN "${channel}"` 로 **문자열 연결**되어 들어간다.
     * 파라미터 바인딩이 불가능한 자리라, 여기가 유일한 방어선이다.
     *
     * 페이로드는 일부러 **무해한 문장**으로 둔다. 가드가 보는 것은 문자열의 형태
     * (따옴표·세미콜론)이지 그 안의 명령이 아니므로 검증력은 같고, 대신 가드를
     * 잠시 걷어내고 돌려 보는 순간에도 DB 가 망가지지 않는다.
     * 실제로 파괴적인 문장을 넣어 두었다가 변이 검증 중에 테이블을 날린 적이 있다.
     */
    const bus = new PgNotifyBus(DATABASE_URL, silent())

    await expect(bus.subscribe('bad"; SELECT 1; --', noop)).rejects.toThrow(
      /허용되지 않는 채널명/,
    )
    await expect(bus.subscribe('has space', noop)).rejects.toThrow(/허용되지 않는 채널명/)
    await expect(bus.subscribe('', noop)).rejects.toThrow(/허용되지 않는 채널명/)

    await bus.close()
  })

  it('검증이 커넥션보다 먼저다', async () => {
    // 접속조차 안 되는 주소를 줘도 **채널명 오류가 먼저** 나야 한다.
    //
    // 순서가 뒤집혀 있으면 잘못된 이름이 핸들러 목록에 남는다. 그러면 나중에
    // LISTEN 커넥션이 끊겨 재구독이 돌 때 그 채널에서 던지고, **정상 채널까지
    // 재구독되지 않는다.** 무결성 스캐너에서 겪은 것과 같은 모양의 사고다.
    const bus = new PgNotifyBus('postgresql://nobody@127.0.0.1:1/none', silent())

    await expect(bus.subscribe('bad;name', noop)).rejects.toThrow(/허용되지 않는 채널명/)

    await bus.close()
  })

  it('실제로 쓰는 채널 이름은 전부 통과한다', async () => {
    // 상수를 바꿨을 때 검증에 걸리면 런타임에야 안다.
    for (const channel of Object.values(CHANNELS)) {
      expect(channel).toMatch(/^[a-z_][a-z0-9_]{0,62}$/i)
    }
  })
})

const reachable = await (async (): Promise<boolean> => {
  const bus = new PgNotifyBus(DATABASE_URL, silent())
  try {
    await bus.publish('probe_channel', { ping: true })
    return true
  } catch {
    return false
  } finally {
    await bus.close().catch(() => undefined)
  }
})()

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(`통합 테스트 건너뜀 — Postgres 에 접속할 수 없습니다 (${DATABASE_URL})`)
}

describe.skipIf(!reachable)('PgNotifyBus — 실제 Postgres', () => {
  const buses: PgNotifyBus[] = []
  const make = (): PgNotifyBus => {
    const bus = new PgNotifyBus(DATABASE_URL, silent())
    buses.push(bus)
    return bus
  }

  afterAll(async () => {
    await Promise.all(buses.map((bus) => bus.close().catch(() => undefined)))
  })

  it('발행한 것이 구독자에게 도착한다', async () => {
    const bus = make()
    const received: unknown[] = []
    await bus.subscribe('test_roundtrip', (payload) => received.push(payload))

    await bus.publish('test_roundtrip', { symbol: 'BTCUSDT', n: 1 })

    await waitFor(() => received.length > 0)
    expect(received[0]).toEqual({ symbol: 'BTCUSDT', n: 1 })
  })

  it('같은 채널의 구독자 여럿에게 모두 간다', async () => {
    const bus = make()
    const a: unknown[] = []
    const b: unknown[] = []
    await bus.subscribe('test_fanout', (p) => a.push(p))
    await bus.subscribe('test_fanout', (p) => b.push(p))

    await bus.publish('test_fanout', { v: 1 })

    await waitFor(() => a.length > 0 && b.length > 0)
    expect(a).toEqual(b)
  })

  it('구독자 하나가 터져도 나머지는 받는다', async () => {
    // 팬아웃이 첫 예외에서 멈추면 뒤 구독자는 영영 못 받는다.
    // 터지는 쪽이 **먼저** 등록되어 있어야 의미가 있다.
    const bus = make()
    const survived: unknown[] = []
    await bus.subscribe('test_resilient', () => {
      throw new Error('구독자 폭발')
    })
    await bus.subscribe('test_resilient', (p) => survived.push(p))

    await bus.publish('test_resilient', { v: 2 })

    await waitFor(() => survived.length > 0)
    expect(survived[0]).toEqual({ v: 2 })
  })

  it('구독하지 않은 채널의 알림은 무시한다', async () => {
    const bus = make()
    const received: unknown[] = []
    await bus.subscribe('test_mine', (p) => received.push(p))

    await bus.publish('test_other', { v: 3 })
    await bus.publish('test_mine', { v: 4 })

    await waitFor(() => received.length > 0)
    expect(received).toEqual([{ v: 4 }])
  })

  it('8KB 를 넘는 페이로드는 본문 대신 신호만 보낸다', async () => {
    // Postgres NOTIFY 는 8000바이트 제약이 있다. 그냥 보내면 **발행이 실패하고**
    // 그 갱신이 통째로 사라진다. 대신 "뭔가 바뀌었다"만 알리고 수신 측이 DB 를
    // 다시 읽게 하면 정합성은 유지된다 — 지연만 늘어난다.
    const bus = make()
    const received: unknown[] = []
    await bus.subscribe('test_oversized', (p) => received.push(p))

    await bus.publish('test_oversized', { blob: 'x'.repeat(9_000) })

    await waitFor(() => received.length > 0)
    expect(received[0]).toEqual({ oversized: true })
  })

  it('상한 바로 아래는 본문을 그대로 보낸다', async () => {
    // 경계에서 과하게 잘라내면 정상 갱신이 매번 신호로 바뀌어 지연이 는다.
    const bus = make()
    const received: unknown[] = []
    await bus.subscribe('test_under_limit', (p) => received.push(p))

    const body = { blob: 'y'.repeat(6_000) }
    await bus.publish('test_under_limit', body)

    await waitFor(() => received.length > 0)
    expect(received[0]).toEqual(body)
  })

  it('close 뒤에는 알림을 받지 않는다', async () => {
    const bus = make()
    const received: unknown[] = []
    await bus.subscribe('test_closed', (p) => received.push(p))
    await bus.close()

    const publisher = make()
    await publisher.publish('test_closed', { v: 5 })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(received).toHaveLength(0)
  })
})
