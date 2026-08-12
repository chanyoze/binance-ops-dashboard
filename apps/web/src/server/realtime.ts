import { CHANNELS, PgNotifyBus, type RealtimeBus } from '@app/db'
import { createLogger, type Logger, type OpsSnapshot } from '@app/shared'
import { getAnalytics, getConfig } from './db.js'

/**
 * SSE 허브 — 프로세스당 하나.
 *
 * ## 왜 클라이언트마다 구독하지 않는가
 *
 * `PgNotifyBus` 는 LISTEN 전용 커넥션을 하나 붙들고 산다. 브라우저 탭마다
 * 버스를 만들면 탭 수만큼 커넥션이 열리고, 대시보드를 몇 개 띄우는 것만으로
 * Postgres 의 max_connections 에 닿는다. **구독은 한 번, 팬아웃은 메모리에서** 한다.
 *
 * ## 참조 카운트로 켜고 끈다
 *
 * 보는 사람이 없을 때도 1초마다 운영 지표를 조회할 이유가 없다. 첫 구독자가
 * 붙을 때 시작하고 마지막 구독자가 떠날 때 멈춘다. 대시보드를 아무도 안 보면
 * DB 부하는 0 이다.
 */

/** 운영 지표 재계산 주기. Data Lag 를 초 단위로 읽으려면 이 정도면 충분하다. */
const OPS_INTERVAL_MS = 2_000

/**
 * 마지막 구독자가 떠난 뒤 실제로 정지하기까지의 유예.
 *
 * SSE 는 끊기면 브라우저가 3초 뒤 다시 붙는다(스트림이 `retry: 3000` 을 보낸다).
 * 유예가 없으면 탭을 새로고침할 때마다 LISTEN 커넥션을 닫았다 여는 일이 반복된다.
 * 재연결 간격보다 넉넉히 잡아 그 왕복을 건너뛴다.
 */
const LINGER_MS = 10_000

export type StreamEvent =
  | { type: 'ops'; data: OpsSnapshot }
  | { type: 'ticker'; data: unknown }
  | { type: 'kline'; data: unknown }
  | { type: 'pipeline'; data: unknown }

type Subscriber = (event: StreamEvent) => void

interface Hub {
  bus: RealtimeBus | null
  subscribers: Set<Subscriber>
  timer: NodeJS.Timeout | null
  starting: Promise<void> | null
  /** 정지가 진행 중이면 그 약속. 내려가는 중에 올리려는 시도를 막는다. */
  stopping: Promise<void> | null
  lingerTimer: NodeJS.Timeout | null
  lastOps: OpsSnapshot | null
}

const globalForHub = globalThis as typeof globalThis & { __binanceOpsHub?: Hub }

function hub(): Hub {
  globalForHub.__binanceOpsHub ??= {
    bus: null,
    subscribers: new Set(),
    timer: null,
    starting: null,
    stopping: null,
    lingerTimer: null,
    lastOps: null,
  }
  return globalForHub.__binanceOpsHub
}

/** 테스트에서 버스를 갈아끼우기 위한 자리. 기본값은 실제 LISTEN/NOTIFY 버스다. */
type BusFactory = () => RealtimeBus
let createBus: BusFactory = () => new PgNotifyBus(getConfig().DATABASE_URL, log())

/** @internal 테스트 전용 — 허브를 초기 상태로 되돌린다. */
export function __setBusFactoryForTest(factory: BusFactory | null): void {
  createBus = factory ?? (() => new PgNotifyBus(getConfig().DATABASE_URL, log()))
  const h = hub()
  if (h.timer) clearInterval(h.timer)
  if (h.lingerTimer) clearTimeout(h.lingerTimer)
  h.bus = null
  h.timer = null
  h.lingerTimer = null
  h.starting = null
  h.stopping = null
  h.lastOps = null
  h.subscribers.clear()
}

// 모듈 최상단에서 만들지 않는다. createLogger 가 설정을 읽는데, 설정 로딩은
// 환경변수가 갖춰진 뒤여야 한다. import 시점에 터지면 원인이 안 보인다.
let cachedLogger: Logger | null = null
function log(): Logger {
  cachedLogger ??= createLogger(getConfig().LOG_LEVEL, { component: 'web:realtime' })
  return cachedLogger
}

function broadcast(event: StreamEvent): void {
  for (const send of hub().subscribers) {
    try {
      send(event)
    } catch (error) {
      // 구독자 하나가 터져도 나머지 전송은 계속되어야 한다.
      log().warn('구독자 전송 실패', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function pushOps(): Promise<void> {
  try {
    const snapshot = await getAnalytics().getOpsSnapshot()
    hub().lastOps = snapshot
    broadcast({ type: 'ops', data: snapshot })
  } catch (error) {
    // 조회가 실패해도 스트림을 끊지 않는다. 다음 주기에 회복되면 그만이다.
    log().error('운영 지표 조회 실패', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function start(): Promise<void> {
  const h = hub()

  // 정지 예약이 걸려 있으면 취소한다 — 마침 새 구독자가 돌아왔다.
  if (h.lingerTimer) {
    clearTimeout(h.lingerTimer)
    h.lingerTimer = null
  }

  // 이미 내려가는 중이면 끝나기를 기다린 뒤 다시 올린다.
  // 기다리지 않고 h.bus 만 보면, 닫히는 중인 버스를 살아 있는 것으로 착각한다.
  if (h.stopping) await h.stopping

  if (h.bus) return
  if (h.starting) return h.starting

  h.starting = (async () => {
    const bus = createBus()
    await bus.subscribe(CHANNELS.ticker, (data) => broadcast({ type: 'ticker', data }))
    await bus.subscribe(CHANNELS.kline, (data) => broadcast({ type: 'kline', data }))
    await bus.subscribe(CHANNELS.pipeline, (data) => broadcast({ type: 'pipeline', data }))
    h.bus = bus

    h.timer = setInterval(() => void pushOps(), OPS_INTERVAL_MS)
    log().info('SSE 허브 시작')
  })()

  try {
    await h.starting
  } finally {
    h.starting = null
  }
}

/**
 * 구독자가 0 이면 유예 뒤에 정지한다.
 *
 * 즉시 닫지 않는 이유는 두 가지다. 하나는 SSE 재연결과의 왕복을 피하려는 것이고,
 * 다른 하나는 **경합**이다. `close()` 는 비동기라, 그것을 기다리는 동안 새 구독자가
 * 붙으면 `start()` 가 "버스가 아직 있다"고 판단해 그냥 돌아간다. 곧이어 close 가
 * 끝나면서 버스를 비우면, **구독자는 붙어 있는데 허브는 죽은** 상태가 된다.
 * 그러면 대시보드가 조용히 갱신을 멈춘다 — 오류도 없이.
 */
function scheduleStop(): void {
  const h = hub()
  if (h.lingerTimer) return

  h.lingerTimer = setTimeout(() => {
    h.lingerTimer = null
    void stopIfIdle()
  }, LINGER_MS)
}

async function stopIfIdle(): Promise<void> {
  const h = hub()
  if (h.subscribers.size > 0) return
  if (h.stopping) return h.stopping

  h.stopping = (async () => {
    if (h.timer) {
      clearInterval(h.timer)
      h.timer = null
    }

    // **닫기를 기다리기 전에 먼저 비운다.** 이 순서가 위 주석의 경합을 막는다.
    const bus = h.bus
    h.bus = null
    await bus?.close().catch(() => undefined)

    log().info('SSE 허브 정지 — 구독자 없음')
  })()

  try {
    await h.stopping
  } finally {
    h.stopping = null
  }
}

/**
 * 구독을 등록하고 해지 함수를 돌려준다.
 * 붙자마자 최신 운영 지표를 한 번 보내 화면이 빈 채로 시작하지 않게 한다.
 */
export async function subscribe(send: Subscriber): Promise<() => void> {
  const h = hub()
  h.subscribers.add(send)

  await start()

  if (h.lastOps) send({ type: 'ops', data: h.lastOps })
  else void pushOps()

  return () => {
    h.subscribers.delete(send)
    if (h.subscribers.size === 0) scheduleStop()
  }
}

/** @internal 테스트 전용 — 허브가 살아 있는지 확인한다. */
export function __hubStateForTest(): { running: boolean; subscribers: number } {
  const h = hub()
  return { running: h.bus !== null && h.timer !== null, subscribers: h.subscribers.size }
}
