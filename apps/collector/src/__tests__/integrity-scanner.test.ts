import type { KlineRepository, RealtimeBus } from '@app/db'
import type { AppConfig, BinanceRestClient } from '@app/shared'
import { alignToInterval } from '@app/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { BackfillService } from '../backfill-service.js'
import { IntegrityScanner } from '../integrity-scanner.js'
import { FakeBus, FakeRepo, FakeRestClient, fakeLogger, makeKline } from './fakes.js'

/**
 * 무결성 스캐너 — 마지막 방어선.
 *
 * 재연결 복구와 재시작 백필이 놓친 구멍을 잡는 장치다. 특징은 **"왜 구멍이 났는지"를
 * 묻지 않는다**는 것 — 주기적으로 훑어서 있으면 메운다. 원인별 대응 대신
 * 상태 수렴으로 푸는 쪽이 원인이 하나 늘 때마다 코드가 늘지 않는다.
 *
 * 그래서 여기서 검증할 것은 "구멍을 정확히 찾는가"와
 * **"구멍이 없을 때 조용한가"** 둘이다. 후자가 없으면 매 분 도는 스캐너가
 * 이벤트 로그를 쓸모없게 만든다.
 */

const MINUTE = 60_000
const SYMBOL = 'BTCUSDT'
/** 진행 중인 봉은 검사 대상이 아니므로, 기준 시각은 정각으로 맞춰 둔다. */
const NOW = alignToInterval(Date.UTC(2026, 0, 10, 12, 0, 0), MINUTE)

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SYMBOLS: [SYMBOL],
    KLINE_INTERVAL: '1m',
    INTEGRITY_SCAN_INTERVAL_MS: 60_000,
    ...overrides,
  } as AppConfig
}

/** [from, to] 구간을 1분봉으로 가득 채운 배열 */
function fill(from: number, to: number, skip: number[] = []) {
  const rows = []
  for (let t = from; t <= to; t += MINUTE) {
    if (skip.includes(t)) continue
    rows.push(makeKline(SYMBOL, '1m', t, MINUTE, 'ws'))
  }
  return rows
}

describe('IntegrityScanner', () => {
  let repo: FakeRepo
  let rest: FakeRestClient
  let scanner: IntegrityScanner

  beforeEach(() => {
    repo = new FakeRepo()
    rest = new FakeRestClient(MINUTE)
    const backfill = new BackfillService(
      rest as unknown as BinanceRestClient,
      repo as unknown as KlineRepository,
      new FakeBus() as unknown as RealtimeBus,
      fakeLogger(),
    )
    scanner = new IntegrityScanner(
      makeConfig(),
      repo as unknown as KlineRepository,
      backfill,
      fakeLogger(),
    )
  })

  it('구멍이 없으면 아무것도 하지 않는다', async () => {
    repo.seed(fill(NOW - 30 * MINUTE, NOW - MINUTE))

    const recovered = await scanner.scanSymbol(SYMBOL, '1m', NOW)

    expect(recovered).toBe(0)
    expect(repo.events).toHaveLength(0)
    expect(rest.calls).toHaveLength(0)
  })

  it('뚫린 구멍을 찾아 메우고 연속성을 회복한다', async () => {
    const hole = [NOW - 20 * MINUTE, NOW - 19 * MINUTE, NOW - 18 * MINUTE]
    repo.seed(fill(NOW - 30 * MINUTE, NOW - MINUTE, hole))

    const recovered = await scanner.scanSymbol(SYMBOL, '1m', NOW)

    expect(recovered).toBeGreaterThan(0)
    for (const t of hole) {
      expect(repo.candles.has(`${SYMBOL}|1m|${t}`)).toBe(true)
    }

    // 메운 뒤 다시 훑으면 조용해야 한다 — 수렴하지 않으면 매 주기 같은 일을 반복한다.
    repo.events.length = 0
    expect(await scanner.scanSymbol(SYMBOL, '1m', NOW)).toBe(0)
    expect(repo.events).toHaveLength(0)
  })

  it('구멍을 찾으면 감지 사실을 기록한다 — 대시보드가 읽는 증거다', async () => {
    repo.seed(fill(NOW - 30 * MINUTE, NOW - MINUTE, [NOW - 10 * MINUTE]))

    await scanner.scanSymbol(SYMBOL, '1m', NOW)

    const detected = repo.eventsOfType('gap_detected')
    expect(detected).toHaveLength(1)
    expect(detected[0]?.detail.missingCandles).toBe(1)
    expect(detected[0]?.detail.gaps).toBe(1)
  })

  it('진행 중인 봉은 검사 대상에서 뺀다 — 넣으면 매번 오탐한다', async () => {
    // 마지막으로 닫힌 봉(NOW - 1분)까지 빠짐없이 있는 상태.
    // 현재 진행 중인 봉(NOW)은 아직 없는 것이 정상이다.
    repo.seed(fill(NOW - 30 * MINUTE, NOW - MINUTE))

    const recovered = await scanner.scanSymbol(SYMBOL, '1m', NOW + 30_000)

    expect(recovered).toBe(0)
    expect(repo.eventsOfType('gap_detected')).toHaveLength(0)
  })

  it('데이터가 아예 없으면 관여하지 않는다 — 부팅 백필의 몫이다', async () => {
    const recovered = await scanner.scanSymbol(SYMBOL, '1m', NOW)

    expect(recovered).toBe(0)
    expect(rest.calls).toHaveLength(0)
  })

  it('구멍이 여러 개면 전부 메운다', async () => {
    const holes = [NOW - 25 * MINUTE, NOW - 15 * MINUTE, NOW - 5 * MINUTE]
    repo.seed(fill(NOW - 30 * MINUTE, NOW - MINUTE, holes))

    await scanner.scanSymbol(SYMBOL, '1m', NOW)

    for (const t of holes) {
      expect(repo.candles.has(`${SYMBOL}|1m|${t}`)).toBe(true)
    }
    expect(repo.eventsOfType('gap_detected')[0]?.detail.gaps).toBe(3)
  })

  describe('scanAll — 주기 실행', () => {
    it('모든 심볼을 훑는다', async () => {
      const config = makeConfig({ SYMBOLS: ['BTCUSDT', 'ETHUSDT'] })
      const backfill = new BackfillService(
        rest as unknown as BinanceRestClient,
        repo as unknown as KlineRepository,
        new FakeBus() as unknown as RealtimeBus,
        fakeLogger(),
      )
      const multi = new IntegrityScanner(
        config,
        repo as unknown as KlineRepository,
        backfill,
        fakeLogger(),
      )

      repo.seed(fill(NOW - 10 * MINUTE, NOW - MINUTE, [NOW - 5 * MINUTE]))
      repo.seed(
        fill(NOW - 10 * MINUTE, NOW - MINUTE, [NOW - 5 * MINUTE]).map((k) => ({
          ...k,
          symbol: 'ETHUSDT',
        })),
      )

      await multi.scanAll(NOW)

      expect(repo.eventsOfType('gap_detected').map((e) => e.symbol).sort()).toEqual([
        'BTCUSDT',
        'ETHUSDT',
      ])
    })

    it('한 심볼에서 터져도 스캐너가 멈추지 않는다', async () => {
      // 스캐너는 무인으로 도는 장치다. 예외가 타이머를 죽이면
      // 마지막 방어선이 조용히 사라진다.
      repo.seed(fill(NOW - 10 * MINUTE, NOW - MINUTE, [NOW - 5 * MINUTE]))
      repo.failNextUpsert = true

      await expect(scanner.scanAll(NOW)).resolves.toBeUndefined()

      // 다음 주기에는 정상적으로 복구된다.
      await scanner.scanAll(NOW)
      expect(repo.candles.has(`${SYMBOL}|1m|${NOW - 5 * MINUTE}`)).toBe(true)
    })
  })
})
