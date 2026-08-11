import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * 스키마 설계 원칙
 *
 * 1. 가격·수량은 전부 NUMERIC 이다. double precision 을 쓰면 시세에 오차가 생긴다.
 *    Drizzle 은 numeric 을 string 으로 다루므로 애플리케이션까지 정밀도가 보존된다.
 *
 * 2. 시각은 전부 timestamptz(UTC) 다. 지표 집계를 SQL 에서 하기로 했으므로(D-07)
 *    date_trunc / 윈도우 함수를 그대로 쓸 수 있는 타입이어야 한다.
 *    Binance 는 epoch ms 를 주므로 변환은 리포지토리 경계 한 곳에서만 일어난다.
 *
 * 3. klines 의 기본키가 (symbol, interval, open_time) 인 것이 이 시스템의 전제다.
 *    이 제약이 UPSERT 멱등성을 만들고, 멱등성이 ensureRange 통합을 가능하게 한다.
 *    (docs/DECISIONS.md D-02, D-03)
 */

/** 수집한 캔들. 이 테이블 하나가 모든 시장 지표의 원천이다. */
export const klines = pgTable(
  'klines',
  {
    symbol: varchar('symbol', { length: 20 }).notNull(),
    interval: varchar('interval', { length: 8 }).notNull(),

    /** 봉 시작 시각 (UTC). 기본키의 일부 — 같은 봉은 한 행뿐이다. */
    openTime: timestamp('open_time', { withTimezone: true, mode: 'date' }).notNull(),
    closeTime: timestamp('close_time', { withTimezone: true, mode: 'date' }).notNull(),

    open: numeric('open', { precision: 24, scale: 8 }).notNull(),
    high: numeric('high', { precision: 24, scale: 8 }).notNull(),
    low: numeric('low', { precision: 24, scale: 8 }).notNull(),
    close: numeric('close', { precision: 24, scale: 8 }).notNull(),

    /** 기초자산 거래량 (BTC 수량) */
    volume: numeric('volume', { precision: 32, scale: 8 }).notNull(),
    /** 견적자산 거래대금 (USDT 금액) */
    quoteVolume: numeric('quote_volume', { precision: 32, scale: 8 }).notNull(),
    tradeCount: integer('trade_count').notNull(),

    /**
     * Taker 매수 거래량 — 시장가로 밀어붙인 매수 물량.
     * Binance 가 집계해 주므로 개별 체결(aggTrade)을 저장할 필요가 없다. (D-08)
     */
    takerBuyBase: numeric('taker_buy_base', { precision: 32, scale: 8 }).notNull(),
    takerBuyQuote: numeric('taker_buy_quote', { precision: 32, scale: 8 }).notNull(),

    /** 봉이 확정되었는가. WS 로 받는 진행 중 봉은 false 로 들어왔다가 true 로 덮인다. */
    isClosed: boolean('is_closed').notNull().default(false),

    /**
     * 이 행이 어디서 왔는가 ('ws' | 'rest').
     * 백필로 채워진 행과 실시간 수집 행을 구분해, 백필이 실제로 동작했음을
     * 데이터로 증명할 수 있게 한다. 대시보드에서도 시각화한다.
     */
    source: varchar('source', { length: 8 }).notNull(),

    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.interval, table.openTime] }),
    // 최신 봉 조회(MAX(open_time))와 차트 구간 조회에 쓰인다.
    index('klines_symbol_interval_time_idx').on(
      table.symbol,
      table.interval,
      table.openTime.desc(),
    ),
  ],
)

/**
 * 파이프라인 운영 이벤트.
 *
 * 재연결·갭 감지·백필 완료 같은 사건을 기록한다. 로그와 역할이 다르다 —
 * 로그는 사람이 터미널에서 보는 것이고, 이 테이블은 **대시보드가 읽는 운영 지표**다.
 * Part 1 의 자가 치유 장치가 실제로 동작했음이 여기 남는다.
 */
export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** 심볼과 무관한 이벤트(전역 재연결 등)는 null */
    symbol: varchar('symbol', { length: 20 }),
    type: varchar('type', { length: 32 }).notNull(),
    /** 이벤트별 상세 — 갭 길이, 복구한 봉 개수, 오류 메시지 등 */
    detail: jsonb('detail').notNull().default({}),
  },
  (table) => [
    index('pipeline_events_ts_idx').on(table.ts.desc()),
    index('pipeline_events_type_ts_idx').on(table.type, table.ts.desc()),
  ],
)

/**
 * 심볼별 수집기 상태.
 *
 * 재시작 시 백필 시작점을 결정하는 근거이자, 대시보드의 Data Lag 지표 원천이다.
 * aggTrade 는 저장하지 않고 여기 last_price 만 갱신한다. (D-08)
 */
export const collectorState = pgTable('collector_state', {
  symbol: varchar('symbol', { length: 20 }).primaryKey(),
  interval: varchar('interval', { length: 8 }).notNull(),

  /** 마지막으로 적재한 봉의 시작 시각 */
  lastOpenTime: timestamp('last_open_time', { withTimezone: true, mode: 'date' }),

  /** aggTrade 로 갱신되는 틱 최신가 — 1분봉보다 최대 60초 앞선다 */
  lastPrice: numeric('last_price', { precision: 24, scale: 8 }),
  lastPriceAt: timestamp('last_price_at', { withTimezone: true, mode: 'date' }),

  /** 마지막 WS 메시지 수신 시각 — Data Lag = now() - this */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),

  wsConnectedSince: timestamp('ws_connected_since', { withTimezone: true, mode: 'date' }),
  reconnectCount: integer('reconnect_count').notNull().default(0),

  /** 마지막 오류 메시지 — 대시보드에 노출 */
  lastError: text('last_error'),

  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

export type KlineRow = typeof klines.$inferSelect
export type KlineInsert = typeof klines.$inferInsert
export type PipelineEventRow = typeof pipelineEvents.$inferSelect
export type CollectorStateRow = typeof collectorState.$inferSelect
