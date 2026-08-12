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
  lastOps: OpsSnapshot | null
}

const globalForHub = globalThis as typeof globalThis & { __binanceOpsHub?: Hub }

function hub(): Hub {
  globalForHub.__binanceOpsHub ??= {
    bus: null,
    subscribers: new Set(),
    timer: null,
    starting: null,
    lastOps: null,
  }
  return globalForHub.__binanceOpsHub
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
  if (h.bus) return
  if (h.starting) return h.starting

  h.starting = (async () => {
    const bus = new PgNotifyBus(getConfig().DATABASE_URL, log())
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

async function stopIfIdle(): Promise<void> {
  const h = hub()
  if (h.subscribers.size > 0) return

  if (h.timer) {
    clearInterval(h.timer)
    h.timer = null
  }
  if (h.bus) {
    await h.bus.close().catch(() => undefined)
    h.bus = null
  }
  log().info('SSE 허브 정지 — 구독자 없음')
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
    void stopIfIdle()
  }
}
