#!/usr/bin/env node
/**
 * 변이 검증 — **테스트가 실제로 무엇을 지키는지** 확인한다.
 *
 *   npm run test:mutate              # 전부
 *   npm run test:mutate -- --list    # 목록만
 *   npm run test:mutate -- backfill  # 이름으로 골라서
 *
 * ## 왜 이 스크립트가 필요한가
 *
 * 테스트가 통과한다는 사실은 **아무것도 말해주지 않는다.** 아무것도 검증하지 않는
 * 테스트도 통과한다. 이 저장소에서 실제로 두 번 나왔다 —
 * 모듈 대신 자기 자신을 try/catch 로 돌리던 테스트, 그리고 이미 끝난 약속에도
 * 늘 "대기 중"이라 답하던 헬퍼. 둘 다 초록불이었고, 둘 다 지키는 것이 없었다.
 *
 * 그래서 반대로 묻는다. **일부러 망가뜨렸을 때 테스트가 잡는가?**
 * 아래 표는 "이 코드가 이렇게 틀리면 이런 일이 난다"를 실행 가능한 형태로 적은 것이다.
 * `demo:chaos` 가 "죽여도 복구한다"를 문장이 아니라 실행으로 만든 것과 같은 발상이다.
 *
 * 각 변이는 **되돌린다.** 중간에 죽어도 원본을 복구한다.
 *
 * ## 대상을 고르는 기준
 *
 * 커버리지를 올리려고 고르지 않는다. **틀려도 조용한 곳**만 고른다 —
 * 오류도 로그도 없이 데이터에 구멍이 나거나 화면이 거짓말하는 지점.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 변이 목록.
 *
 * `find` 는 파일에 **정확히 한 번만** 나와야 한다. 여러 번 나오면 어디를 망가뜨렸는지
 * 모르게 되므로 그 자체를 오류로 본다.
 */
const MUTATIONS = [
  {
    name: 'rest-taker-swap',
    why: 'REST 응답의 taker 매수 기초/견적 자산을 맞바꾼다. Taker 비율이 통째로 틀리는데 화면에는 그럴듯한 숫자가 뜬다.',
    file: 'packages/shared/src/binance/rest.ts',
    find: 'takerBuyBase: row[K.TakerBuyBase],',
    replace: 'takerBuyBase: row[K.TakerBuyQuote],',
    tests: ['packages/shared/src/__tests__/binance-payload.test.ts'],
  },
  {
    name: 'ws-volume-swap',
    why: 'WS 이벤트의 거래량(v)과 거래대금(q)을 맞바꾼다. 글자 하나 차이라 사람이 가장 틀리기 쉽다.',
    file: 'packages/shared/src/binance/ws-payload.ts',
    find: 'volume: k.v,',
    replace: 'volume: k.q,',
    tests: ['packages/shared/src/__tests__/binance-payload.test.ts'],
  },
  {
    name: 'rest-retry-4xx',
    why: '4xx 를 재시도하게 만든다. 결과가 같은 요청을 반복해 rate limit 을 태우고, 그 여파로 정상 요청까지 막혀 구멍이 넓어진다.',
    file: 'packages/shared/src/binance/rest.ts',
    find: "if (error instanceof Error && error.message.startsWith('Binance 요청 실패')) throw error",
    replace: 'if (false) throw error',
    tests: ['packages/shared/src/__tests__/binance-rest.test.ts'],
  },
  {
    name: 'weight-threshold',
    why: '소프트 임계를 무시하고 통과시킨다. Binance 가 429/418 로 막으면 백필이 멈추고 그 구간이 구멍으로 남는다.',
    file: 'packages/shared/src/binance/weight-limiter.ts',
    find: 'if (this.used + weight <= ceiling) {',
    replace: 'if (true) {',
    tests: ['packages/shared/src/__tests__/weight-limiter.test.ts'],
  },
  {
    name: 'weight-header-overwrite',
    why: '응답 헤더로 카운터를 무조건 덮는다. 헤더는 직전 응답 기준이라 우리보다 뒤처져 있고, 낮은 값으로 덮으면 방금 쓴 weight 를 잊는다.',
    file: 'packages/shared/src/binance/weight-limiter.ts',
    find: 'this.used = Math.max(this.used, usedWeight)',
    replace: 'this.used = usedWeight',
    tests: ['packages/shared/src/__tests__/weight-limiter.test.ts'],
  },
  {
    name: 'scanner-isolation',
    why: '심볼 단위 격리를 없앤다. 앞 심볼이 던지면 뒤 심볼 스캔이 그 주기째 사라져, 실패가 지속되면 다른 심볼의 구멍이 영원히 방치된다.',
    file: 'apps/collector/src/integrity-scanner.ts',
    find: '          await this.scanSymbol(symbol, this.config.KLINE_INTERVAL, now)\n        } catch (error) {',
    replace:
      '          await this.scanSymbol(symbol, this.config.KLINE_INTERVAL, now)\n        } catch (error) {\n          throw error\n          // eslint-disable-next-line no-unreachable',
    tests: ['apps/collector/src/__tests__/integrity-scanner.test.ts'],
  },
  {
    name: 'ws-terminate-no-close',
    why: '좀비 연결을 끊은 뒤 재연결 예약을 막는다. 끊는 것으로 끝나면 수집은 멈춘 채다 — 끊고 다시 붙는 것까지가 복구다.',
    file: 'apps/collector/src/ws-collector.ts',
    find: '    this.markDisconnected({ code, reason })\n    this.scheduleReconnect()',
    replace: '    this.markDisconnected({ code, reason })',
    tests: ['apps/collector/src/__tests__/ws-collector.test.ts'],
  },
  {
    name: 'merge-kline-append',
    why: '진행 중인 봉을 덮지 않고 매번 새로 쌓는다. 1분봉은 매초 갱신돼 오므로 1분에 60개가 쌓이고 차트의 시간 축이 조용히 어긋난다.',
    file: 'apps/web/src/lib/merge-kline.ts',
    find: 'last && last.openTime === kline.openTime',
    replace: 'false',
    tests: ['apps/web/src/lib/__tests__/merge-kline.test.ts'],
  },
  {
    name: 'stream-stall-never',
    why: '스트림이 멎어도 live 로 본다. 프록시가 SSE 를 버퍼링하면 화면이 "연결됨"이라고 말한 채 영원히 멈춘다.',
    file: 'apps/web/src/lib/stream-health.ts',
    find: "return now - lastSignalAt >= stallMs ? 'stalled' : 'live'",
    replace: "return 'live'",
    tests: [
      'apps/web/src/lib/__tests__/stream-health.test.ts',
      'apps/web/src/lib/__tests__/useDashboard.test.tsx',
    ],
  },
  {
    name: 'hook-missing-signal',
    why: 'ops 핸들러에서 수신 신호를 빠뜨린다. 정상인데도 멎은 것으로 오판해 무거운 집계 폴링이 상시로 돈다 — 화면은 멀쩡히 갱신되므로 아무도 모른다.',
    file: 'apps/web/src/lib/useDashboard.ts',
    find: "source.addEventListener('ops', (event) => {\n      signal()",
    replace: "source.addEventListener('ops', (event) => {",
    tests: ['apps/web/src/lib/__tests__/useDashboard.test.tsx'],
  },
  {
    name: 'sse-leak-on-start-failure',
    why: 'start 실패 시 구독자를 되돌리지 않는다. 구독자 수가 영영 0 으로 돌아오지 않아 허브가 다시는 멈추지 않는다.',
    file: 'apps/web/src/server/realtime.ts',
    find: '    h.subscribers.delete(send)\n    throw error',
    replace: '    throw error',
    tests: ['apps/web/src/server/__tests__/realtime.test.ts'],
  },
  {
    name: 'symbol-whitelist-off',
    why: '심볼 화이트리스트를 해제한다. 수집하지 않는 임의 문자열이 조회 경로까지 들어간다.',
    file: 'apps/web/src/server/request.ts',
    find: 'if (!allowed.includes(upper)) {',
    replace: 'if (false) {',
    tests: [
      'apps/web/src/server/__tests__/request.test.ts',
      'apps/web/src/app/api/__tests__/routes.test.ts',
    ],
  },
  {
    name: 'display-timezone',
    why: '표시 시간대를 되돌린다. 시각이 아홉 시간 밀려도 화면은 멀쩡히 그려지고 숫자만 틀리다.',
    file: 'apps/web/src/lib/format.ts',
    find: "export const DISPLAY_TIME_ZONE = 'Asia/Seoul'",
    replace: "export const DISPLAY_TIME_ZONE = 'UTC'",
    tests: ['apps/web/src/lib/__tests__/format.test.ts'],
  },
  {
    name: 'lag-threshold',
    why: 'Data Lag 임계를 민다. 위험한 상태가 정상 색으로 표시된다 — 이 대시보드가 가장 하면 안 되는 일이다.',
    file: 'apps/web/src/lib/format.ts',
    find: "if (seconds < 3) return 'good'",
    replace: "if (seconds < 5) return 'good'",
    tests: ['apps/web/src/lib/__tests__/format.test.ts'],
  },
  {
    name: 'channel-name-guard',
    why: '채널명 검증을 등록보다 뒤로 되돌린다. 잘못된 이름이 목록에 남아 재구독 전체를 영구히 막는다.',
    file: 'packages/db/src/realtime-bus.ts',
    find: '    assertSafeChannelName(channel)\n\n    const existing = this.handlers.get(channel)',
    replace: '    const existing = this.handlers.get(channel)',
    tests: ['packages/db/src/__tests__/realtime-bus.integration.test.ts'],
  },
]

/* ---------------------------------------------------------------- 출력 */

const c = {
  dim: (s) => `[2m${s}[0m`,
  bold: (s) => `[1m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
  cyan: (s) => `[36m${s}[0m`,
}

const log = (message = '') => process.stdout.write(`${message}\n`)
const hr = () => log(c.dim('─'.repeat(78)))

/* ---------------------------------------------------------------- 실행 */

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  log(`사용법: npm run test:mutate -- [필터] [--list]

  필터      이름에 이 문자열이 든 변이만 돌립니다
  --list    목록만 출력하고 끝냅니다`)
  process.exit(0)
}

if (args.includes('--list')) {
  for (const mutation of MUTATIONS) {
    log(`${c.cyan(mutation.name.padEnd(26))} ${mutation.file}`)
    log(`${' '.repeat(27)}${c.dim(mutation.why)}`)
  }
  process.exit(0)
}

const filter = args.find((arg) => !arg.startsWith('-'))
const selected = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS

if (selected.length === 0) {
  log(c.red(`'${filter}' 에 해당하는 변이가 없습니다. --list 로 확인하세요.`))
  process.exit(1)
}

/** 되돌리지 못한 채 죽는 일이 없도록, 손댄 파일을 여기에 담아 둔다. */
const dirty = new Map()

const restoreAll = () => {
  for (const [path, original] of dirty) writeFileSync(path, original, 'utf8')
  dirty.clear()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll()
    process.exit(130)
  })
}

/** 대상 테스트를 돌린다. 실패하면 true — 변이를 잡았다는 뜻이다. */
function testsFail(tests) {
  try {
    execFileSync('npx', ['vitest', 'run', ...tests], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
    return false
  } catch {
    return true
  }
}

hr()
log(c.bold('  변이 검증 — 일부러 망가뜨렸을 때 테스트가 잡는가'))
hr()
log(c.dim('  통과한다는 사실만으로는 그 테스트가 무엇을 지키는지 알 수 없다.'))
log('')

let caught = 0
const escaped = []

for (const [index, mutation] of selected.entries()) {
  const path = new URL(mutation.file, `file://${ROOT.replaceAll('\\', '/')}`)
  const filePath = fileURLToPath(path)
  const original = readFileSync(filePath, 'utf8')

  const occurrences = original.split(mutation.find).length - 1
  if (occurrences !== 1) {
    log(
      `  ${c.red('✗')} ${c.bold(mutation.name)} — 대상 코드를 ${occurrences}번 찾았습니다 (1번이어야 합니다)`,
    )
    log(c.dim(`      코드가 바뀌었다면 이 변이의 find 를 갱신해야 합니다.`))
    escaped.push({ ...mutation, reason: '대상을 특정하지 못함' })
    continue
  }

  process.stdout.write(
    `  ${c.cyan(`[${index + 1}/${selected.length}]`)} ${mutation.name.padEnd(26)} `,
  )

  dirty.set(filePath, original)
  try {
    writeFileSync(filePath, original.replace(mutation.find, mutation.replace), 'utf8')
    if (testsFail(mutation.tests)) {
      log(c.green('잡힘'))
      caught += 1
    } else {
      log(c.red('빠져나감'))
      escaped.push({ ...mutation, reason: '테스트가 통과했습니다' })
    }
  } finally {
    writeFileSync(filePath, original, 'utf8')
    dirty.delete(filePath)
  }
}

log('')
hr()

if (escaped.length === 0) {
  log(`  ${c.green('✓ PASS')} — 변이 ${caught}건이 모두 잡혔습니다.`)
  log(c.dim('         각 테스트가 실제로 무엇을 지키는지 확인된 상태입니다.'))
  hr()
  process.exit(0)
}

log(`  ${c.red('✗ FAIL')} — ${escaped.length}건이 빠져나갔습니다. (잡힘 ${caught}건)`)
log('')
for (const item of escaped) {
  log(`      ${c.bold(item.name)} — ${item.reason}`)
  log(c.dim(`      ${item.why}`))
}
log('')
log(c.dim('      빠져나간 변이는 "그 코드를 지키는 테스트가 없다"는 뜻입니다.'))
hr()
process.exit(1)
