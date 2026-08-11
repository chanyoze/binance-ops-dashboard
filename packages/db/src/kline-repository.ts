import type { Interval, Kline, PipelineEventType } from '@app/shared'
import { and, asc, between, eq, max, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { collectorState, klines, pipelineEvents } from './schema.js'

/**
 * 캔들 저장소.
 *
 * 도메인은 시각을 epoch ms(number)로 다루고 DB 는 timestamptz 로 저장한다.
 * **그 변환은 오직 이 파일에서만 일어난다.** 경계를 한 곳으로 모아두면
 * "어디선가 시간대가 틀어졌다" 류의 버그가 생길 곳이 하나로 줄어든다.
 */

/**
 * Postgres 의 파라미터 상한(65535)에 걸리지 않도록 나눠 넣는다.
 * 컬럼이 15개이므로 500행이면 7,500개 — 충분히 여유가 있다.
 */
const UPSERT_CHUNK_SIZE = 500

export class KlineRepository {
  constructor(private readonly db: Database) {}

  /**
   * 캔들을 UPSERT 한다. **이 시스템 전체가 이 메서드의 멱등성 위에 서 있다.**
   *
   * 같은 구간을 몇 번 다시 긁어도 안전하기 때문에
   *  - 백필 구간을 여유 있게 겹쳐 잡을 수 있고
   *  - 백필 도중 WS 가 붙어 같은 봉이 양쪽에서 들어와도 되고
   *  - WS 의 미완성 봉이 확정 봉으로 자연히 덮인다
   * (docs/DECISIONS.md D-03)
   *
   * @returns 처리한 행 수
   */
  async upsertKlines(rows: readonly Kline[]): Promise<number> {
    if (rows.length === 0) return 0

    let written = 0

    for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + UPSERT_CHUNK_SIZE)

      await this.db
        .insert(klines)
        .values(chunk.map(toRow))
        .onConflictDoUpdate({
          target: [klines.symbol, klines.interval, klines.openTime],
          set: {
            high: sql`excluded.high`,
            low: sql`excluded.low`,
            close: sql`excluded.close`,
            volume: sql`excluded.volume`,
            quoteVolume: sql`excluded.quote_volume`,
            tradeCount: sql`excluded.trade_count`,
            takerBuyBase: sql`excluded.taker_buy_base`,
            takerBuyQuote: sql`excluded.taker_buy_quote`,
            closeTime: sql`excluded.close_time`,
            isClosed: sql`excluded.is_closed`,
            source: sql`excluded.source`,
            updatedAt: sql`now()`,
          },
        })

      written += chunk.length
    }

    return written
  }

  /**
   * 가장 최근 봉의 시작 시각. **부팅 시퀀스가 던지는 질문이 바로 이것이다.**
   *
   * null 이면 최초 실행(DB 가 비어 있음), 값이 있으면 재시작이다.
   * 이 한 번의 조회가 "최초 백필"과 "갭 백필"을 가른다. (D-02)
   */
  async getLastOpenTime(symbol: string, interval: Interval): Promise<number | null> {
    // drizzle 의 max() 를 쓴다. 컬럼 타입을 알고 있어 값을 Date 로 매핑해 준다.
    //
    // 처음에는 sql<Date | null>`max(...)` 로 작성했다가 통합 테스트에서 잡혔다.
    // sql<T> 는 **TypeScript 단언일 뿐 런타임 변환이 아니다** — 타입은 Date 라고
    // 주장하지만 실제로는 문자열이 돌아와 .getTime() 이 터진다. 타입체크는 통과한다.
    const [row] = await this.db
      .select({ value: max(klines.openTime) })
      .from(klines)
      .where(and(eq(klines.symbol, symbol), eq(klines.interval, interval)))

    return toEpochMs(row?.value ?? null)
  }

  /**
   * 구간 안에 실제로 존재하는 봉의 시작 시각 목록 (오름차순).
   * 무결성 스캐너가 이 목록을 findGaps 에 넘겨 구멍을 찾는다.
   */
  async getOpenTimes(
    symbol: string,
    interval: Interval,
    fromMs: number,
    toMs: number,
  ): Promise<number[]> {
    const rows = await this.db
      .select({ openTime: klines.openTime })
      .from(klines)
      .where(
        and(
          eq(klines.symbol, symbol),
          eq(klines.interval, interval),
          between(klines.openTime, new Date(fromMs), new Date(toMs)),
        ),
      )
      .orderBy(asc(klines.openTime))

    return rows.flatMap((row) => {
      const ms = toEpochMs(row.openTime)
      return ms === null ? [] : [ms]
    })
  }

  /** 구간 내 적재된 봉 개수 — 커버리지 계산의 분자 */
  async countInRange(
    symbol: string,
    interval: Interval,
    fromMs: number,
    toMs: number,
  ): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(klines)
      .where(
        and(
          eq(klines.symbol, symbol),
          eq(klines.interval, interval),
          between(klines.openTime, new Date(fromMs), new Date(toMs)),
        ),
      )

    return row?.count ?? 0
  }

  /**
   * 파이프라인 이벤트 기록.
   * 로그가 아니라 **대시보드가 읽는 운영 지표**다. 자가 치유가 동작했다는 증거가 여기 쌓인다.
   */
  async recordEvent(
    type: PipelineEventType,
    symbol: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.insert(pipelineEvents).values({ type, symbol, detail })
  }

  /** 수집기 상태 갱신 (심볼당 한 행). Data Lag 지표의 원천이다. */
  async updateState(
    symbol: string,
    interval: Interval,
    patch: {
      lastOpenTimeMs?: number | null
      lastPrice?: string | null
      lastPriceAtMs?: number | null
      lastMessageAtMs?: number | null
      wsConnectedSinceMs?: number | null
      incrementReconnect?: boolean
      lastError?: string | null
    },
  ): Promise<void> {
    const values = {
      symbol,
      interval,
      lastOpenTime: toDate(patch.lastOpenTimeMs),
      lastPrice: patch.lastPrice ?? null,
      lastPriceAt: toDate(patch.lastPriceAtMs),
      lastMessageAt: toDate(patch.lastMessageAtMs),
      wsConnectedSince: toDate(patch.wsConnectedSinceMs),
      reconnectCount: patch.incrementReconnect ? 1 : 0,
      lastError: patch.lastError ?? null,
    }

    // 부분 갱신: 이번에 주지 않은 필드는 기존 값을 유지한다.
    // COALESCE(excluded.x, state.x) 로 "null 은 무시"를 표현한다.
    await this.db
      .insert(collectorState)
      .values(values)
      .onConflictDoUpdate({
        target: collectorState.symbol,
        set: {
          interval: sql`excluded.interval`,
          lastOpenTime: sql`coalesce(excluded.last_open_time, ${collectorState.lastOpenTime})`,
          lastPrice: sql`coalesce(excluded.last_price, ${collectorState.lastPrice})`,
          lastPriceAt: sql`coalesce(excluded.last_price_at, ${collectorState.lastPriceAt})`,
          lastMessageAt: sql`coalesce(excluded.last_message_at, ${collectorState.lastMessageAt})`,
          wsConnectedSince: sql`excluded.ws_connected_since`,
          reconnectCount: sql`${collectorState.reconnectCount} + excluded.reconnect_count`,
          lastError: sql`excluded.last_error`,
          updatedAt: sql`now()`,
        },
      })
  }
}

function toRow(kline: Kline) {
  return {
    symbol: kline.symbol,
    interval: kline.interval,
    openTime: new Date(kline.openTime),
    closeTime: new Date(kline.closeTime),
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close,
    volume: kline.volume,
    quoteVolume: kline.quoteVolume,
    tradeCount: kline.tradeCount,
    takerBuyBase: kline.takerBuyBase,
    takerBuyQuote: kline.takerBuyQuote,
    isClosed: kline.isClosed,
    source: kline.source,
  }
}

function toDate(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms)
}

/**
 * DB 에서 온 시각을 epoch ms 로 정규화한다.
 *
 * Date 로 오는 게 정상이지만 드라이버·집계 함수·ORM 조합에 따라 문자열이 오기도 한다.
 * 이 경계에서 한 번 방어해두면 도메인 코드는 number 만 다루면 된다.
 */
function toEpochMs(value: Date | string | null): number | null {
  if (value === null) return null

  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}
