import { z } from 'zod'

/**
 * 환경변수 스키마.
 *
 * 설계 의도: 잘못된 설정은 "런타임에 이상하게 동작"하는 게 아니라
 * "부팅 시점에 명확한 메시지와 함께 죽는" 것이 낫다.
 * 수집기는 무인으로 24시간 도는 프로세스라, 조용히 틀린 값으로 도는 것이 가장 나쁘다.
 */

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0)

const envSchema = z.object({
  DATABASE_URL: z.string().url(),

  // 수집 대상 — 심볼을 늘려도 코드 변경이 필요 없다 (확장성)
  SYMBOLS: z.string().default('BTCUSDT,ETHUSDT').transform(csv),

  // 1분봉만 수집하고 상위 인터벌은 SQL 집계로 만든다 (D-05)
  KLINE_INTERVAL: z.enum(['1m', '3m', '5m', '15m', '1h']).default('1m'),

  // DB가 비어 있을 때만 사용되는 최초 백필 기간
  BACKFILL_DAYS: z.coerce.number().int().positive().max(90).default(7),

  // 좀비 연결 감지 임계 (D-04)
  STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(10_000),

  // 재연결 지수 백오프
  RECONNECT_BASE_MS: z.coerce.number().int().positive().default(1_000),
  RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),

  // 무결성 스캐너 주기
  INTEGRITY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  BINANCE_REST_BASE: z.string().url().default('https://api.binance.com'),
  BINANCE_WS_BASE: z.string().url().default('wss://stream.binance.com:9443'),

  // Rate limit 가드 (D-06)
  RATE_LIMIT_WEIGHT_PER_MIN: z.coerce.number().int().positive().default(6_000),
  RATE_LIMIT_SOFT_THRESHOLD: z.coerce.number().min(0.1).max(1).default(0.8),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type AppConfig = z.infer<typeof envSchema>

let cached: AppConfig | null = null

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached

  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')

    throw new Error(
      `환경변수 설정이 올바르지 않습니다. .env.example 을 참고하세요.\n${details}`,
    )
  }

  if (parsed.data.SYMBOLS.length === 0) {
    throw new Error('SYMBOLS 가 비어 있습니다. 최소 한 개의 심볼이 필요합니다.')
  }

  if (parsed.data.RECONNECT_BASE_MS > parsed.data.RECONNECT_MAX_MS) {
    throw new Error('RECONNECT_BASE_MS 는 RECONNECT_MAX_MS 보다 클 수 없습니다.')
  }

  cached = parsed.data
  return cached
}

/** 테스트에서 캐시를 초기화하기 위한 헬퍼 */
export function resetConfigCache(): void {
  cached = null
}
