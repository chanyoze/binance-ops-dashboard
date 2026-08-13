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

export function createDb(
  connectionString: string,
  maxConnections = 10,
  onPoolError?: (error: Error) => void,
): DbHandle {
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    // 수집기는 장기 실행 프로세스다. 유휴 커넥션이 방화벽에 끊기는 것을 막는다.
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
  })

  /**
   * **유휴 커넥션의 오류를 반드시 받아야 한다.**
   *
   * `pg` 의 Pool 은 놀고 있는 커넥션이 죽으면 pool 에 'error' 를 emit 하는데,
   * 듣는 사람이 없으면 Node 가 처리되지 않은 예외로 올려 **프로세스를 죽인다.**
   *
   * 실제로 그렇게 죽었다. DB 를 정지시키자 Postgres 가
   * `terminating connection due to administrator command` 를 보냈고, 수집기가
   * 그 자리에서 종료됐다. 문서에는 "DB 장애 시 그 구간은 구멍으로 남고 스캐너가
   * 회수한다"고 적어 두었는데, 정작 회수할 프로세스가 함께 죽고 있었다.
   * (`npm run demo:chaos -- --db` 로 재현·검증한다)
   *
   * 여기서 할 일은 로그를 남기는 것뿐이다. 죽은 커넥션은 pool 이 알아서 버리고
   * 다음 요청에 새로 만든다. 우리가 해야 하는 것은 **프로세스를 지키는 것**이다.
   */
  pool.on('error', (error: Error) => {
    onPoolError?.(error)
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
