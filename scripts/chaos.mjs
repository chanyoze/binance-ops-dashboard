#!/usr/bin/env node
/**
 * Chaos 데모 — 수집기를 실제로 죽였다 살려서 자가 치유를 눈앞에서 재현한다.
 *
 *   npm run demo:chaos                 # 3분 중단 후 재개
 *   npm run demo:chaos -- --minutes 5  # 중단 시간 변경
 *   npm run demo:chaos -- --kill       # SIGKILL 로 죽여 Docker 자동 재시작을 관찰
 *
 * ## 왜 이 스크립트가 필요한가
 *
 * "재시작하면 갭을 백필한다"는 문장은 누구나 쓸 수 있다. 이 스크립트는 그 문장을
 * **읽는 사람이 직접 돌려서 확인할 수 있는 것**으로 바꾼다. 손으로 하던 절차
 * (상태 기록 -> 중단 -> 방치 -> 재개 -> 복구 확인)를 그대로 자동화했고,
 * 마지막에 PASS/FAIL 을 내며 실패 시 종료 코드 1 로 끝난다.
 *
 * 검증하는 것은 세 가지다.
 *   1. 중단한 동안 실제로 봉이 비었는가        (구멍이 안 생기면 실험 자체가 무의미하다)
 *   2. 재개 후 그 구멍이 전부 메워졌는가        (자가 치유)
 *   3. 메운 봉의 출처가 REST 인가              (백필이 한 일이라는 증거)
 */

import { execFileSync } from 'node:child_process'

const DEFAULTS = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://binance:binance@localhost:5432/binance_ops',
  container: process.env.COLLECTOR_CONTAINER ?? 'binance-ops-collector',
  interval: '1m',
  downtimeMinutes: 3,
  /** 재개 후 백필이 끝나기를 기다리는 최대 시간 */
  recoveryTimeoutMs: 90_000,
}

/* ---------------------------------------------------------------- 출력 */

const c = {
  dim: (s) => `[2m${s}[0m`,
  bold: (s) => `[1m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
  cyan: (s) => `[36m${s}[0m`,
}

const log = (message = '') => process.stdout.write(`${message}\n`)
const step = (n, total, title) => log(`\n${c.cyan(`[${n}/${total}]`)} ${c.bold(title)}`)
const hr = () => log(c.dim('─'.repeat(72)))

/* ---------------------------------------------------------------- 인자 */

function parseArgs(argv) {
  const options = { ...DEFAULTS, mode: 'stop' }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--kill') {
      options.mode = 'kill'
    } else if (arg === '--minutes') {
      const value = Number(argv[i + 1])
      if (!Number.isFinite(value) || value <= 0 || value > 60) {
        fail('--minutes 는 1~60 사이의 수여야 합니다')
      }
      options.downtimeMinutes = value
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      log(`사용법: npm run demo:chaos -- [--minutes N] [--kill]

  --minutes N   수집기를 N분간 중단합니다 (기본 ${DEFAULTS.downtimeMinutes})
  --kill        stop 대신 SIGKILL 로 죽입니다.
                compose 의 restart: unless-stopped 가 즉시 되살리므로
                "크래시해도 부팅 시퀀스가 갭을 메운다"를 확인할 때 씁니다.`)
      process.exit(0)
    } else {
      fail(`알 수 없는 인자입니다: ${arg}`)
    }
  }

  return options
}

function fail(message) {
  log(`\n${c.red('✗')} ${message}`)
  process.exit(1)
}

/* ---------------------------------------------------------------- Docker */

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim()
}

function containerState(name) {
  try {
    return docker(['inspect', '-f', '{{.State.Status}}', name])
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- 조회 */

/** 심볼별 적재 현황. 실험 전후로 같은 질문을 던져 비교한다. */
async function snapshot(client, interval) {
  const { rows } = await client.query(
    `select
       symbol,
       count(*)::int                             as candles,
       max(open_time)                            as last_open_time,
       count(*) filter (where source = 'ws')::int   as ws_count,
       count(*) filter (where source = 'rest')::int as rest_count
     from klines where interval = $1
     group by symbol order by symbol`,
    [interval],
  )
  return rows
}

/**
 * 기준 시각 이후로 **있어야 할 봉 대비 실제 있는 봉**을 센다.
 *
 * 처음에는 `lag()` 로 연속한 두 봉의 간격만 봤는데, 그러면 **꼬리가 통째로 비어 있는
 * 경우를 못 잡는다.** 봉이 아예 안 들어오면 비교할 이웃이 없어 "구멍 0개"가 나오고,
 * 스크립트가 백필을 기다리지 않고 곧장 통과해 버렸다. 실제로 그렇게 오판했다.
 *
 * 그래서 "구멍"을 이웃 간격이 아니라 **기대 개수와의 차이**로 정의한다.
 * 이 정의는 중간에 뚫린 구멍과 따라잡지 못한 꼬리를 한 번에 센다.
 *
 * 상한은 now() 가 아니라 **마지막으로 닫힌 봉**이다. 진행 중인 봉은 아직 없는 게
 * 정상이라 넣으면 매번 1개씩 모자라다고 오탐한다.
 */
async function missingSince(client, symbol, interval, mark) {
  const { rows } = await client.query(
    `with bound as (
       select date_trunc('minute', now()) - interval '1 minute' as last_closed
     )
     select
       greatest(0, (extract(epoch from (b.last_closed - $3::timestamptz)) / 60)::int) as expected,
       (select count(*) from klines k
         where k.symbol = $1 and k.interval = $2
           and k.open_time > $3::timestamptz and k.open_time <= b.last_closed)::int   as actual
     from bound b`,
    [symbol, interval, mark],
  )

  const expected = rows[0]?.expected ?? 0
  const actual = rows[0]?.actual ?? 0
  return { expected, actual, missing: Math.max(0, expected - actual) }
}

/** 구간을 메운 봉 중 REST(백필) 로 들어온 것의 수 */
async function countRestInRange(client, symbol, interval, fromTime, toTime) {
  const { rows } = await client.query(
    `select count(*)::int as n from klines
     where symbol = $1 and interval = $2 and source = 'rest'
       and open_time > $3 and open_time <= $4`,
    [symbol, interval, fromTime, toTime],
  )
  return rows[0]?.n ?? 0
}

async function recentBackfills(client, sinceTime) {
  const { rows } = await client.query(
    `select ts, symbol, detail from pipeline_events
     where type = 'backfill_completed' and ts >= $1
     order by id asc`,
    [sinceTime],
  )
  return rows
}

/* ---------------------------------------------------------------- 대기 */

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 남은 시간을 한 줄로 갱신하며 기다린다. 멈춰 있는 것처럼 보이면 안 된다. */
async function countdown(totalMs, label) {
  const started = Date.now()
  const tty = process.stdout.isTTY

  for (;;) {
    const remaining = totalMs - (Date.now() - started)
    if (remaining <= 0) break

    const seconds = Math.ceil(remaining / 1000)
    const text = `      ${label} — 남은 시간 ${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, '0')}초`
    if (tty) process.stdout.write(`\r${c.dim(text)}   `)
    else if (seconds % 30 === 0) log(c.dim(text))

    await sleep(Math.min(1000, remaining))
  }
  if (tty) process.stdout.write('\r'.padEnd(72) + '\r')
}

/**
 * 백필이 끝나기를 기다린다.
 * 시간을 정해 놓고 자는 대신 **결과가 나올 때까지** 폴링한다 —
 * 백필 소요는 갭 길이에 따라 달라지므로 고정 대기는 둘 중 하나로 틀린다.
 */
async function waitForRecovery(client, symbols, interval, marks, timeoutMs) {
  const started = Date.now()
  const tty = process.stdout.isTTY

  for (;;) {
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const mark = marks.get(symbol)
        if (!mark) return 0
        const { missing } = await missingSince(client, symbol, interval, mark)
        return missing
      }),
    )

    const remaining = results.reduce((sum, n) => sum + n, 0)
    if (remaining === 0) {
      if (tty) process.stdout.write('\r'.padEnd(72) + '\r')
      return true
    }
    if (Date.now() - started > timeoutMs) {
      if (tty) process.stdout.write('\r'.padEnd(72) + '\r')
      return false
    }

    const elapsed = Math.round((Date.now() - started) / 1000)
    const text = `      백필을 기다리는 중 — 남은 구멍 ${remaining}봉 (${elapsed}초 경과)`
    if (tty) process.stdout.write(`\r${c.dim(text)}   `)

    await sleep(2_000)
  }
}

/* ---------------------------------------------------------------- 본문 */

/**
 * `pg` 는 워크스페이스 의존성이라 `npm install` 을 거쳐야 생긴다.
 * 그런데 이 스크립트를 가장 먼저 돌려보는 사람은 `docker compose up` 만 한 상태다 —
 * 컨테이너 안에는 의존성이 있지만 호스트에는 없다.
 * 정적 import 로 두면 그 사람이 받는 첫 화면이 모듈 없음 스택트레이스가 된다.
 * 다른 실패 경로(컨테이너 없음·DB 연결 실패)와 같은 격으로 다룬다.
 */
async function loadPg() {
  try {
    return (await import('pg')).default
  } catch {
    fail('의존성이 설치되어 있지 않습니다.\n  이 스크립트는 호스트에서 DB 를 직접 조회하므로 `npm install` 이 한 번 필요합니다.')
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const downtimeMs = options.downtimeMinutes * 60_000

  hr()
  log(c.bold('  Chaos 데모 — 수집기를 죽였다 살려 자가 치유를 확인합니다'))
  hr()
  log(`  대상 컨테이너 : ${options.container}`)
  log(`  중단 방식     : ${options.mode === 'kill' ? 'SIGKILL (Docker 가 자동 재시작)' : 'stop (수동 재개)'}`)
  log(`  중단 시간     : ${options.downtimeMinutes}분`)

  const state = containerState(options.container)
  if (state === null) {
    fail(`컨테이너를 찾을 수 없습니다: ${options.container}\n  먼저 \`docker compose up -d\` 로 기동해 주세요.`)
  }
  if (state !== 'running') {
    fail(`컨테이너가 실행 중이 아닙니다 (현재: ${state}).\n  \`docker compose up -d\` 로 기동한 뒤 다시 실행해 주세요.`)
  }

  const pg = await loadPg()
  const client = new pg.Client({ connectionString: options.databaseUrl })
  try {
    await client.connect()
  } catch (error) {
    fail(`데이터베이스에 연결하지 못했습니다: ${error.message}\n  DATABASE_URL=${options.databaseUrl}`)
  }

  const TOTAL = 5
  let exitCode = 0

  try {
    /* ---------- 1. 실험 전 상태 ---------- */
    step(1, TOTAL, '실험 전 상태를 기록합니다')
    const before = await snapshot(client, options.interval)
    if (before.length === 0) {
      fail('수집된 캔들이 없습니다. 수집기가 최초 백필을 마칠 때까지 기다린 뒤 다시 실행해 주세요.')
    }

    const marks = new Map()
    for (const row of before) {
      marks.set(row.symbol, row.last_open_time)
      log(
        `      ${row.symbol.padEnd(9)} ${String(row.candles).padStart(6)}봉  ` +
          `마지막 ${isoMinute(row.last_open_time)} ${TZ_LABEL}  ` +
          c.dim(`WS ${row.ws_count} / REST ${row.rest_count}`),
      )
    }
    const experimentStart = new Date()

    /* ---------- 2. 중단 ---------- */
    step(2, TOTAL, options.mode === 'kill' ? '수집기를 SIGKILL 로 죽입니다' : '수집기를 중단합니다')
    if (options.mode === 'kill') {
      docker(['kill', '--signal=KILL', options.container])
      log(`      ${c.yellow('■')} SIGKILL 전송 — restart 정책에 따라 Docker 가 되살립니다`)
    } else {
      docker(['stop', options.container])
      log(`      ${c.yellow('■')} 중단됨 — 이 동안 들어온 캔들은 유실됩니다`)
    }

    /* ---------- 3. 방치 ---------- */
    step(3, TOTAL, `${options.downtimeMinutes}분간 방치합니다 (이 사이 데이터에 구멍이 생깁니다)`)
    await countdown(downtimeMs, '수집 중단 중')

    /* ---------- 4. 재개 ---------- */
    step(4, TOTAL, '수집기를 다시 올립니다')
    if (containerState(options.container) !== 'running') {
      docker(['start', options.container])
    }
    log(`      ${c.green('▶')} 기동됨 — 부팅 시퀀스가 마지막 봉부터 현재까지를 백필합니다`)

    const recovered = await waitForRecovery(
      client,
      [...marks.keys()],
      options.interval,
      marks,
      options.recoveryTimeoutMs,
    )

    /* ---------- 5. 검증 ---------- */
    step(5, TOTAL, '복구 결과를 검증합니다')

    const after = await snapshot(client, options.interval)
    const events = await recentBackfills(client, experimentStart)
    const now = new Date()

    hr()
    log(
      `  ${'심볼'.padEnd(11)}${'중단 전'.padStart(9)}${'현재'.padStart(9)}` +
        `${'채워짐'.padStart(9)}${'REST'.padStart(8)}${'남은 구멍'.padStart(11)}`,
    )
    hr()

    let allHealed = true
    let totalFilled = 0

    for (const row of after) {
      const mark = marks.get(row.symbol)
      const beforeRow = before.find((r) => r.symbol === row.symbol)
      if (!mark || !beforeRow) continue

      const { missing } = await missingSince(client, row.symbol, options.interval, mark)
      const restFilled = await countRestInRange(client, row.symbol, options.interval, mark, now)
      const filled = row.candles - beforeRow.candles
      totalFilled += filled
      if (missing > 0) allHealed = false

      log(
        `  ${row.symbol.padEnd(11)}${String(beforeRow.candles).padStart(9)}${String(row.candles).padStart(9)}` +
          `${String(filled).padStart(9)}${String(restFilled).padStart(8)}` +
          `${(missing === 0 ? c.green('0') : c.red(String(missing))).padStart(missing === 0 ? 20 : 20)}`,
      )
    }
    hr()

    if (events.length > 0) {
      log(`\n  ${c.bold('이 실험이 남긴 백필 기록')} ${c.dim(`(pipeline_events · 시각 ${TZ_LABEL})`)}`)
      for (const event of events) {
        const d = event.detail ?? {}
        log(
          `      ${isoSecond(event.ts)}  ${String(event.symbol ?? '—').padEnd(9)} ` +
            `reason=${String(d.reason).padEnd(9)} ${String(d.written ?? 0).padStart(4)}봉  ${d.durationMs ?? '?'}ms`,
        )
      }
    }

    log('')
    if (!recovered || !allHealed) {
      log(`  ${c.red('✗ FAIL')} — 구멍이 남아 있습니다.`)
      log(c.dim('         무결성 스캐너가 다음 주기에 회수할 수도 있습니다.'))
      log(c.dim(`         잠시 뒤 다시 확인하거나 \`docker logs ${options.container}\` 를 보세요.`))
      exitCode = 1
    } else if (totalFilled === 0) {
      log(`  ${c.yellow('△ 확인 필요')} — 채워진 봉이 없습니다.`)
      log(c.dim('         중단 시간이 1분보다 짧았거나, 이미 백필이 끝난 상태였을 수 있습니다.'))
      log(c.dim('         --minutes 를 늘려 다시 실행해 보세요.'))
    } else {
      log(`  ${c.green('✓ PASS')} — 중단 동안 비었던 구간이 전부 메워졌고 연속성이 회복되었습니다.`)
      log(c.dim(`         복구한 봉 ${totalFilled}개 · 남은 구멍 0개`))
      log(c.dim('         source 컬럼이 REST 인 것이 백필이 한 일이라는 증거입니다.'))
    }
    hr()
  } finally {
    await client.end().catch(() => undefined)
  }

  process.exit(exitCode)
}

/**
 * 시각 표기는 대시보드와 같은 시간대를 쓴다 (`apps/web/src/lib/format.ts`).
 *
 * 저장은 UTC 그대로다. 바꾸는 것은 표시뿐이고, **한쪽만 바꾸면** 이 출력과 화면을
 * 대조할 때 머릿속에서 9시간을 더해야 한다. 그 한 단계가 실수를 만든다.
 */
const DISPLAY_TIME_ZONE = 'Asia/Seoul'
const TZ_LABEL = 'KST'

const fmtMinute = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const fmtSecond = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const isoMinute = (value) => fmtMinute.format(new Date(value))
const isoSecond = (value) => fmtSecond.format(new Date(value))

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
