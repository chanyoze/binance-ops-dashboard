import { AnalyticsRepository, createDb, type DbHandle } from '@app/db'
import { loadConfig, type AppConfig } from '@app/shared'

/**
 * 웹 서버가 쓰는 DB 커넥션 풀 — 프로세스당 하나.
 *
 * 개발 모드에서 Next 는 파일을 고칠 때마다 모듈을 다시 평가한다. 모듈 최상단에
 * 풀을 만들면 **저장할 때마다 새 풀이 생겨** 커넥션이 계속 쌓이고, 결국
 * Postgres 의 max_connections 에 걸린다. globalThis 에 캐시해서 리로드를 건너뛴다.
 *
 * 수집기와 웹은 별도 프로세스이므로 풀도 별개다. 웹은 짧은 조회만 하므로
 * 수집기보다 작은 풀로 충분하다.
 */

const WEB_POOL_SIZE = 5

interface WebRuntime {
  handle: DbHandle
  analytics: AnalyticsRepository
  config: AppConfig
}

const globalForDb = globalThis as typeof globalThis & {
  __binanceOpsRuntime?: WebRuntime
}

export function getRuntime(): WebRuntime {
  if (globalForDb.__binanceOpsRuntime) return globalForDb.__binanceOpsRuntime

  const config = loadConfig()
  const handle = createDb(config.DATABASE_URL, WEB_POOL_SIZE)

  const runtime: WebRuntime = {
    handle,
    // 수집기가 저장하는 해상도를 그대로 원본으로 삼는다. 이 값이 어긋나면
    // 조회가 오류 없이 빈 결과를 돌려줘서 "데이터가 없다"로만 보인다.
    analytics: new AnalyticsRepository(handle.db, config.KLINE_INTERVAL),
    config,
  }

  globalForDb.__binanceOpsRuntime = runtime
  return runtime
}

export function getAnalytics(): AnalyticsRepository {
  return getRuntime().analytics
}

export function getConfig(): AppConfig {
  return getRuntime().config
}
