import {
  BinanceRestClient,
  WeightLimiter,
  createLogger,
  loadConfig,
  type Logger,
} from '@app/shared'
import { KlineRepository, PgNotifyBus, createDb, runMigrations } from '@app/db'
import { BackfillService } from './backfill-service.js'
import { IntegrityScanner } from './integrity-scanner.js'
import { WsCollector } from './ws-collector.js'

/**
 * 수집기 부팅 시퀀스.
 *
 * 순서가 중요하다.
 *   1. 마이그레이션      — 스키마가 없으면 아무것도 못 한다
 *   2. 백필              — 과거 구간을 채운 뒤에
 *   3. WebSocket 연결    — 실시간 수집을 시작한다
 *   4. 무결성 스캐너     — 그 뒤로는 주기적으로 훑는다
 *
 * 2번을 3번보다 먼저 하는 이유: 백필 중에 WS 가 붙어도 UPSERT 덕에 안전하지만,
 * 순서를 정해두면 "언제 데이터가 완전해지는가"를 명확히 말할 수 있다.
 */

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config.LOG_LEVEL, { service: 'collector' })

  logger.info('수집기 시작', {
    symbols: config.SYMBOLS,
    interval: config.KLINE_INTERVAL,
    backfillDays: config.BACKFILL_DAYS,
  })

  // 1. 마이그레이션 — 사람이 잊을 수 있는 단계를 부팅에 넣어둔다.
  //    `docker compose up` 한 줄로 재현된다는 약속이 이걸로 지켜진다.
  logger.info('마이그레이션 확인')
  await runMigrations(config.DATABASE_URL)

  const dbHandle = createDb(config.DATABASE_URL)
  const repo = new KlineRepository(dbHandle.db)
  const bus = new PgNotifyBus(config.DATABASE_URL, logger)

  const limiter = new WeightLimiter(
    config.RATE_LIMIT_WEIGHT_PER_MIN,
    config.RATE_LIMIT_SOFT_THRESHOLD,
    logger,
    (detail) => void repo.recordEvent('rate_limit_throttled', null, detail),
  )

  const rest = new BinanceRestClient({
    baseUrl: config.BINANCE_REST_BASE,
    limiter,
    logger,
  })

  const backfill = new BackfillService(rest, repo, bus, logger)
  const collector = new WsCollector(config, repo, bus, backfill, logger)
  const scanner = new IntegrityScanner(config, repo, backfill, logger)

  registerShutdownHandlers(logger, async () => {
    scanner.stop()
    await collector.stop()
    await bus.close()
    await dbHandle.close()
  })

  // 2. 백필 — 이 한 줄이 "최초 실행"과 "재시작 갭"을 동시에 처리한다. (D-02)
  for (const symbol of config.SYMBOLS) {
    try {
      await backfill.backfillFromLastKnown(symbol, config.KLINE_INTERVAL, config.BACKFILL_DAYS)
    } catch (error) {
      // 한 심볼의 백필 실패가 전체 기동을 막아서는 안 된다.
      // 스캐너가 이후에 같은 구간을 다시 시도한다.
      logger.error('부팅 백필 실패 — 스캐너가 재시도합니다', {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      })
      await repo.recordEvent('error', symbol, {
        phase: 'boot_backfill',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 3. 실시간 수집 시작
  collector.start()

  // 4. 무결성 스캐너 — 그 뒤로는 주기적으로 훑으며 구멍을 메운다
  scanner.start()

  logger.info('수집기 기동 완료 — 실시간 수집 중')
}

/**
 * 종료 신호 처리.
 *
 * Docker 는 SIGTERM 을 보내고 기본 10초 뒤 SIGKILL 한다.
 * 정리하지 않고 죽어도 데이터가 깨지지는 않지만(UPSERT 멱등성),
 * DB 커넥션을 정리해두면 재시작이 깔끔하다.
 */
function registerShutdownHandlers(logger: Logger, cleanup: () => Promise<void>): void {
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    logger.info('종료 신호 수신 — 정리 중', { signal })

    const timeout = setTimeout(() => {
      logger.warn('정리가 지연되어 강제 종료합니다')
      process.exit(1)
    }, 8_000)

    try {
      await cleanup()
      clearTimeout(timeout)
      logger.info('정리 완료')
      process.exit(0)
    } catch (error) {
      clearTimeout(timeout)
      logger.error('정리 중 오류', {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // 처리되지 않은 예외로 조용히 죽는 것보다, 로그를 남기고 죽어서
  // Docker 가 재시작하고 백필이 갭을 메우게 하는 편이 낫다.
  process.on('uncaughtException', (error) => {
    logger.error('처리되지 않은 예외 — 프로세스를 종료합니다', {
      error: error.message,
      stack: error.stack,
    })
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('처리되지 않은 Promise 거부', { reason: String(reason) })
  })
}

main().catch((error) => {
  process.stderr.write(
    `수집기 기동 실패: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}\n`,
  )
  process.exit(1)
})
