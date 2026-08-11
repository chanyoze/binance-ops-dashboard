import type {
  Candle,
  CoverageStat,
  Interval,
  MarketStats,
  OpsSnapshot,
  PipelineEvent,
  PipelineEventType,
  RelativeStrengthPoint,
} from '@app/shared'
import { intervalToMs } from '@app/shared'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * 대시보드 조회 저장소 — **읽기 전용**.
 *
 * KlineRepository 와 파일을 나눈 이유는 두 경로의 성질이 다르기 때문이다.
 * 쓰기 경로는 멱등성과 정확한 한 행이 관심사고, 읽기 경로는 집계와 응답 크기가 관심사다.
 * 한 클래스에 두면 "차트가 필요해서" 수집 경로의 메서드를 고치는 일이 생긴다.
 *
 * ## 집계를 SQL 에서 하는 이유 (D-07)
 *
 * 목업에서는 24시간치 1분봉 2,880행을 브라우저로 보내고 JS 로 접었다. 동작은 했지만
 * 그건 목업이라 가능했던 것이다. 1h 캔들 24개를 보려고 1,440행을 보내는 것은
 * 대역폭도 낭비지만, 더 나쁜 것은 **같은 지표가 화면마다 다르게 계산될 수 있다**는 점이다.
 * VWAP·MA·Taker 비율의 정의를 SQL 한 곳에 두면 정의가 하나로 유지된다.
 *
 * 또 하나 — 이 값들은 `date_bin` 과 윈도우 함수로 Postgres 가 훨씬 잘하는 일이다.
 * 스키마를 timestamptz + NUMERIC 으로 잡아둔 것이 여기서 회수된다.
 */

/** 화면이 한 번에 그리는 봉 개수의 상한. 요청이 더 크게 와도 여기서 자른다. */
const MAX_CANDLES = 1000

/** 기본 이동평균 구간. 인자로 바꿀 수 있게 열어둔다 (MA60 을 쓰려면 여기만 넘기면 된다). */
const DEFAULT_MA_PERIOD = 20

/** 원본 해상도. 수집기는 1분봉만 저장하고, 그보다 큰 봉은 전부 여기서 접는다. */
const BASE_INTERVAL: Interval = '1m'

export class AnalyticsRepository {
  constructor(private readonly db: Database) {}

  /**
   * 차트용 캔들.
   *
   * 1분봉을 `date_bin` 으로 요청 인터벌에 접는다. 기준점을 epoch 로 잡아야
   * Binance 의 봉 경계(:00, :05, …)와 어긋나지 않는다.
   *
   * MA 는 접은 **뒤에** 계산한다. 1분봉에서 MA20 을 구해 5분봉에 붙이면
   * "최근 20분 평균"이 되어 화면의 MA20(=최근 100분) 과 다른 값이 된다.
   * 그래서 요청한 개수보다 MA 구간만큼 더 읽어 와서 앞부분을 버린다.
   */
  async getCandles(
    symbol: string,
    interval: Interval,
    limit = 120,
    maPeriod = DEFAULT_MA_PERIOD,
  ): Promise<Candle[]> {
    const take = Math.max(1, Math.min(limit, MAX_CANDLES))
    const bucketMinutes = intervalToMs(interval) / 60_000
    // MA 가 첫 봉부터 그려지려면 앞쪽에 maPeriod-1 개가 더 있어야 한다.
    const lookbackMinutes = (take + maPeriod) * bucketMinutes

    const { rows } = await this.db.execute(sql`
      with anchor as (
        select max(open_time) as t from klines
        where symbol = ${symbol} and interval = ${BASE_INTERVAL}
      ),
      src as (
        select k.* from klines k, anchor a
        where k.symbol = ${symbol} and k.interval = ${BASE_INTERVAL}
          and k.open_time > a.t - ${`${lookbackMinutes} minutes`}::interval
      ),
      bucketed as (
        select
          date_bin(${`${bucketMinutes} minutes`}::interval, open_time, timestamptz 'epoch') as bucket,
          (array_agg(open  order by open_time asc ))[1] as open,
          (array_agg(close order by open_time desc))[1] as close,
          max(high) as high,
          min(low)  as low,
          sum(volume)          as volume,
          sum(quote_volume)    as quote_volume,
          sum(trade_count)::int as trade_count,
          sum(taker_buy_quote) as taker_buy_quote,
          bool_or(source = 'rest') as has_backfill,
          bool_and(is_closed)      as is_closed
        from src group by 1
      ),
      with_ma as (
        select b.*,
          case
            -- 구간이 안 찬 앞부분은 null 로 남겨 선을 끊는다.
            when row_number() over (order by bucket) >= ${maPeriod}
            then avg(close) over (order by bucket rows between ${maPeriod - 1} preceding and current row)
          end as ma
        from bucketed b
      )
      select * from with_ma order by bucket desc limit ${take}
    `)

    // 최신순으로 잘라 왔으므로 화면이 쓰는 오름차순으로 되돌린다.
    return rows.reverse().map(toCandle)
  }

  /**
   * 심볼별 24시간 요약.
   *
   * 기준 시각을 `now()` 가 아니라 **DB 의 마지막 봉**으로 잡는다. 수집이 잠시 멈춰 있어도
   * "최근 24시간"이 빈 구간을 포함해 통계가 이상해지는 것을 막는다. 수집이 멈춘 사실은
   * Data Lag 가 따로 말해 준다 — 한 지표가 두 가지를 말하게 하지 않는다.
   */
  async getMarketStats(symbols: readonly string[]): Promise<MarketStats[]> {
    if (symbols.length === 0) return []

    const symbolArray = sql.raw(pgTextArray(symbols))
    const { rows } = await this.db.execute(sql`
      with anchor as (
        -- **요청한 심볼들의** 마지막 봉이 기준이다. 필터 없이 max 를 잡으면
        -- 다른 심볼이 살아 있는 동안 이 심볼의 24시간 창이 통째로 비어 버린다.
        select max(open_time) as t from klines
        where interval = ${BASE_INTERVAL} and symbol = any(${symbolArray})
      ),
      win as (
        select k.* from klines k, anchor a
        where k.interval = ${BASE_INTERVAL}
          and k.symbol = any(${symbolArray})
          and k.open_time >= a.t - interval '24 hours'
      )
      select
        symbol,
        (array_agg(close order by open_time desc))[1] as last,
        (array_agg(open  order by open_time asc ))[1] as open24h,
        max(high) as high24h,
        min(low)  as low24h,
        sum(volume)       as volume,
        sum(quote_volume) as quote_volume,
        sum(trade_count)::int as trade_count,
        count(*)::int         as candle_count,
        -- Taker 비율은 금액(quote) 기준이다. 수량 기준으로 하면 가격이 다른 구간의
        -- 체결이 같은 무게로 섞여 "얼마어치가 매수였나"를 답하지 못한다.
        (sum(taker_buy_quote) / nullif(sum(quote_volume), 0))::float8 as taker_buy_ratio,
        (sum(quote_volume) / nullif(sum(volume), 0)) as vwap
      from win group by symbol
    `)

    return rows.map((r) => {
      const last = String(r.last)
      const open24h = String(r.open24h)
      return {
        symbol: String(r.symbol),
        last,
        open24h,
        high24h: String(r.high24h),
        low24h: String(r.low24h),
        volume: String(r.volume),
        quoteVolume: String(r.quote_volume),
        tradeCount: Number(r.trade_count),
        takerBuyRatio: Number(r.taker_buy_ratio ?? 0),
        vwap: String(r.vwap ?? last),
        // 등락률은 표시용이라 number 로 내려도 된다. 가격 자체는 문자열로 유지한다.
        changePct: pctChange(open24h, last),
        candleCount: Number(r.candle_count),
      }
    })
  }

  /**
   * 데이터 커버리지 — 기대 봉 수 대비 실제 적재 수.
   *
   * 분모를 "첫 봉 ~ 마지막 봉" 으로 잡는다. 수집 시작 전 구간까지 결손으로 세면
   * 서비스를 늦게 켠 것이 데이터 품질 문제로 보이게 된다.
   */
  async getCoverage(symbols: readonly string[], interval: Interval): Promise<CoverageStat[]> {
    if (symbols.length === 0) return []
    const stepMinutes = intervalToMs(interval) / 60_000

    const { rows } = await this.db.execute(sql`
      select
        symbol,
        count(*)::int as actual,
        (extract(epoch from (max(open_time) - min(open_time))) / 60 / ${stepMinutes} + 1)::int as expected,
        count(*) filter (where source = 'ws')::int   as ws_count,
        count(*) filter (where source = 'rest')::int as rest_count,
        min(open_time) as first_open_time,
        max(open_time) as last_open_time
      from klines
      where interval = ${interval} and symbol = any(${sql.raw(pgTextArray(symbols))})
      group by symbol
    `)

    return rows.map((r) => {
      const actual = Number(r.actual)
      const expected = Number(r.expected)
      return {
        symbol: String(r.symbol),
        interval,
        actual,
        expected,
        pct: expected > 0 ? (actual / expected) * 100 : 0,
        wsCount: Number(r.ws_count),
        restCount: Number(r.rest_count),
        firstOpenTime: toEpochMs(r.first_open_time),
        lastOpenTime: toEpochMs(r.last_open_time),
      }
    })
  }

  /**
   * BTC/ETH 상대 강도 — 구간 시작을 100 으로 지수화한다.
   *
   * **이 과제가 깔아둔 함정을 피하는 지점이다.** BTC 약 $64,000, ETH 약 $1,890 을
   * 한 차트에 그리려면 축을 두 개 만들고 싶어지는데, 그러면 두 선의 교차점이
   * 아무 의미도 없으면서 의미처럼 보인다. 눈금을 어떻게 잡느냐로 "ETH 가 BTC 를
   * 추월했다"는 착시를 임의로 만들 수 있다. 지수화하면 축이 하나가 되고
   * 교차점이 진짜 의미(구간 수익률 역전)를 갖는다. (docs/DESIGN.md §3)
   *
   * 두 심볼의 시작점이 다르면 비교가 성립하지 않으므로, 둘 다 값이 있는
   * 버킷에서만 기준을 잡는다.
   */
  async getRelativeStrength(
    symbols: readonly string[],
    hours = 6,
    points = 120,
  ): Promise<RelativeStrengthPoint[]> {
    if (symbols.length === 0) return []
    const stepMinutes = Math.max(1, Math.round((hours * 60) / points))

    const symbolArray = sql.raw(pgTextArray(symbols))
    const { rows } = await this.db.execute(sql`
      with anchor as (
        select max(open_time) as t from klines
        where interval = ${BASE_INTERVAL} and symbol = any(${symbolArray})
      ),
      src as (
        select k.symbol, k.open_time, k.close from klines k, anchor a
        where k.interval = ${BASE_INTERVAL}
          and k.symbol = any(${symbolArray})
          and k.open_time > a.t - ${`${hours} hours`}::interval
      ),
      bucketed as (
        select
          symbol,
          date_bin(${`${stepMinutes} minutes`}::interval, open_time, timestamptz 'epoch') as bucket,
          (array_agg(close order by open_time desc))[1] as close
        from src group by 1, 2
      ),
      -- 모든 심볼이 값을 가진 버킷만 남긴다. 한쪽만 있는 구간에서 기준을 잡으면
      -- 두 선의 출발점이 어긋나 비교 자체가 거짓이 된다.
      complete as (
        select bucket from bucketed group by bucket
        having count(distinct symbol) = ${symbols.length}
      ),
      indexed as (
        select b.bucket, b.symbol,
          (100 * b.close / first_value(b.close) over (partition by b.symbol order by b.bucket))::float8 as value
        from bucketed b join complete c on c.bucket = b.bucket
      )
      select bucket, json_object_agg(symbol, value) as values
      from indexed group by bucket order by bucket asc
    `)

    return rows.map((r) => ({
      openTime: toEpochMs(r.bucket) ?? 0,
      values: r.values as Record<string, number>,
    }))
  }

  /**
   * 파이프라인 운영 스냅샷.
   *
   * Data Lag 를 **서버에서** 계산해 내려보낸다. 브라우저에서 `Date.now() - lastMessageAt`
   * 으로 구하면 클라이언트 시계가 틀어진 만큼 그대로 지표가 틀어진다. 운영 지표가
   * 보는 사람 PC 설정에 좌우되면 안 된다.
   */
  async getOpsSnapshot(staleThresholdSeconds = 30): Promise<OpsSnapshot> {
    const [{ rows: stateRows }, { rows: recoveryRows }, { rows: rateRows }] = await Promise.all([
      this.db.execute(sql`
        select
          symbol, last_price, last_price_at, last_open_time,
          ws_connected_since, reconnect_count, last_error,
          extract(epoch from (now() - last_message_at))::float8 as lag_seconds,
          extract(epoch from (now() - ws_connected_since))::float8 as uptime_seconds,
          now() as server_now
        from collector_state
      `),
      // 최초 적재(reason=initial)는 "복구"가 아니다. 섞으면 갱 복구량이 심볼당
      // 1,441봉씩 부풀어 자가 치유가 실제로 몇 봉을 메웠는지가 안 보인다.
      this.db.execute(sql`
        select
          count(*)::int as runs,
          coalesce(sum((detail->>'written')::int), 0)::int as candles
        from pipeline_events
        where type = 'backfill_completed' and detail->>'reason' is distinct from 'initial'
      `),
      this.db.execute(sql`
        with anchor as (
          select max(open_time) as t from klines where interval = ${BASE_INTERVAL}
        )
        select coalesce(sum(k.trade_count) / 60.0 / nullif(count(distinct k.open_time), 0), 0)::float8 as rate
        from klines k, anchor a
        where k.interval = ${BASE_INTERVAL} and k.is_closed
          and k.open_time > a.t - interval '5 minutes'
      `)
    ])

    const at = toEpochMs(stateRows[0]?.server_now) ?? Date.now()
    const symbols = stateRows.map((r) => ({
      symbol: String(r.symbol),
      lastPrice: r.last_price === null ? null : String(r.last_price),
      lastPriceAt: toEpochMs(r.last_price_at),
      lastOpenTime: toEpochMs(r.last_open_time),
      lagSeconds: numOrNull(r.lag_seconds),
    }))

    // 심볼이 여럿이면 가장 뒤처진 쪽이 이 화면의 Lag 다. 평균을 내면 한쪽이
    // 완전히 죽어도 다른 쪽이 가려 준다.
    const lags = symbols.map((s) => s.lagSeconds).filter((v): v is number => v !== null)
    const lagSeconds = lags.length > 0 ? Math.max(...lags) : null

    const uptimes = stateRows
      .map((r) => numOrNull(r.uptime_seconds))
      .filter((v): v is number => v !== null)

    return {
      at,
      connected: lagSeconds !== null && lagSeconds < staleThresholdSeconds,
      lagSeconds,
      uptimeMs: uptimes.length > 0 ? Math.min(...uptimes) * 1000 : null,
      reconnectCount: stateRows.reduce((sum, r) => sum + Number(r.reconnect_count ?? 0), 0),
      lastError: (stateRows.find((r) => r.last_error)?.last_error as string | undefined) ?? null,
      symbols,
      recoveredCandles: Number(recoveryRows[0]?.candles ?? 0),
      recoveryRuns: Number(recoveryRows[0]?.runs ?? 0),
      tradeRate: Number(rateRows[0]?.rate ?? 0),
    }
  }

  /** 최근 파이프라인 이벤트 — 자가 치유가 동작했다는 기록이 그대로 화면의 로그가 된다. */
  async getRecentEvents(limit = 30): Promise<PipelineEvent[]> {
    const { rows } = await this.db.execute(sql`
      select ts, symbol, type, detail from pipeline_events
      order by id desc limit ${Math.max(1, Math.min(limit, 200))}
    `)

    return rows.map((r) => ({
      ts: r.ts as Date,
      symbol: r.symbol === null ? null : String(r.symbol),
      type: String(r.type) as PipelineEventType,
      detail: (r.detail ?? {}) as Record<string, unknown>,
    }))
  }
}

/* ---------- 매핑 헬퍼 ---------- */

function toCandle(r: Record<string, unknown>): Candle {
  return {
    openTime: toEpochMs(r.bucket) ?? 0,
    open: String(r.open),
    high: String(r.high),
    low: String(r.low),
    close: String(r.close),
    volume: String(r.volume),
    quoteVolume: String(r.quote_volume),
    tradeCount: Number(r.trade_count),
    takerBuyQuote: String(r.taker_buy_quote),
    ma: r.ma === null || r.ma === undefined ? null : String(r.ma),
    hasBackfill: Boolean(r.has_backfill),
    isClosed: Boolean(r.is_closed),
  }
}

/**
 * timestamptz -> epoch ms.
 *
 * pg 는 timestamptz 를 Date 로 주지만, 집계 결과에는 null 이 섞인다.
 * `sql<Date>` 로 타입만 단언하면 런타임에 문자열이 와도 타입체크가 통과한다 —
 * 실제로 그렇게 터진 적이 있어(D1) 값을 확인하고 변환한다.
 */
function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 소수점이 섞인 가격 문자열의 변동률. 표시용이라 여기서만 number 로 내린다. */
function pctChange(from: string, to: string): number {
  const a = Number(from)
  const b = Number(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0
  return ((b - a) / a) * 100
}

/**
 * 심볼 목록을 Postgres 텍스트 배열 리터럴로.
 *
 * `= any(...)` 에 배열을 넘기는 방식이 드라이버·드리즐 조합마다 달라, 여기서는
 * 리터럴을 직접 만든다. 대신 **작은따옴표를 이스케이프하고 허용 문자를 검사**한다.
 * 심볼은 환경변수에서 오므로 신뢰할 수 있지만, 신뢰 여부와 무관하게
 * 문자열을 SQL 에 넣는 곳에는 검사를 붙인다.
 */
function pgTextArray(values: readonly string[]): string {
  const safe = values.map((v) => {
    if (!/^[A-Za-z0-9_]{1,20}$/.test(v)) {
      throw new Error(`심볼 형식이 올바르지 않습니다: ${JSON.stringify(v)}`)
    }
    return `'${v}'`
  })
  return `array[${safe.join(', ')}]::text[]`
}
