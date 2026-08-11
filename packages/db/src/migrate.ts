import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDb } from './client.js'

/**
 * 마이그레이션 실행기.
 *
 * 수집기 컨테이너가 뜰 때 자동으로 실행된다. 사람이 잊어버릴 수 있는 단계를
 * 부팅 시퀀스에 넣어두면 `docker compose up` 한 줄로 재현된다는 약속이 지켜진다.
 *
 * DB 가 아직 준비되지 않았을 수 있으므로 재시도한다 — compose 의 healthcheck 가
 * 먼저 걸리지만, 로컬에서 수동 실행할 때를 대비한 이중 안전장치다.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MAX_ATTEMPTS = 10

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, 1)

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR })
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt === MAX_ATTEMPTS) throw error

        process.stderr.write(
          `마이그레이션 재시도 ${attempt}/${MAX_ATTEMPTS} — DB 준비 대기 중 (${message})\n`,
        )
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
  } finally {
    await handle.close()
  }
}

// 직접 실행된 경우 (npm run db:migrate)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const url = process.env.DATABASE_URL

  if (!url) {
    process.stderr.write('DATABASE_URL 이 설정되지 않았습니다. .env.example 을 참고하세요.\n')
    process.exit(1)
  }

  runMigrations(url)
    .then(() => {
      process.stdout.write('마이그레이션 완료\n')
      process.exit(0)
    })
    .catch((error) => {
      process.stderr.write(`마이그레이션 실패: ${error instanceof Error ? error.message : error}\n`)
      process.exit(1)
    })
}
