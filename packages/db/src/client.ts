import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

const { Pool, types } = pg

/**
 * NUMERIC(OID 1700)을 JS number 로 자동 변환하지 않도록 파서를 문자열로 고정한다.
 *
 * pg 는 기본적으로 numeric 을 문자열로 주지만, 이 동작에 의존하지 않고 명시한다.
 * 여기서 number 로 바뀌면 시세에 부동소수 오차가 생기고, 그 오차는 조용해서
 * 한참 뒤에야 발견된다. (docs/DECISIONS.md 코드 컨벤션)
 */
types.setTypeParser(1700, (value) => value)

export type Database = NodePgDatabase<typeof schema>

export interface DbHandle {
  db: Database
  pool: pg.Pool
  close(): Promise<void>
}

export function createDb(connectionString: string, maxConnections = 10): DbHandle {
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    // 수집기는 장기 실행 프로세스다. 유휴 커넥션이 방화벽에 끊기는 것을 막는다.
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
  })

  const db = drizzle(pool, { schema })

  return {
    db,
    pool,
    close: async () => {
      await pool.end()
    },
  }
}

export { schema }
