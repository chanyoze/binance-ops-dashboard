import type { KlineRepository, RealtimeBus } from '@app/db'
import type { BinanceRestClient } from '@app/shared'
import { alignToInterval } from '@app/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { BackfillService } from '../backfill-service.js'
import { FakeBus, FakeRepo, FakeRestClient, fakeLogger, makeKline } from './fakes.js'

/**
 * 백필 서비스 — 이 시스템의 심장.
 *
 * `ensureRange` 하나가 네 상황(initial · restart · reconnect · scanner)을 처리하므로,
 * 여기가 틀리면 "구멍을 스스로 메운다"는 주장 전체가 무너진다.
 *
 * 순수 계획 로직(`resolveBackfillStart` · `planBackfillPages`)은 이미 단위 테스트가
 * 있다. 여기서 보는 것은 그 계획을 **실제로 어떻게 실행하는가** 다 —
 * 어떤 구간을 요청하는지, 무엇을 기록하는지, 실패하면 어떻게 되는지.
 */

const MINUTE = 60_000
const SYMBOL = 'BTCUSDT'
const NOW = alignToInterval(Date.UTC(2026, 0, 10, 12, 0, 0), MINUTE)

describe('BackfillService', () => {
  let repo: FakeRepo
  let rest: FakeRestClient
  let bus: FakeBus
  let service: BackfillService

  beforeEach(() => {
    repo = new FakeRepo()
    rest = new FakeRestClient(MINUTE)
    bus = new FakeBus()
    service = new BackfillService(
      rest as unknown as BinanceRestClient,
      repo as unknown as KlineRepository,
      bus as unknown as RealtimeBus,
      fakeLogger(),
    )
  })

  describe('DB 상태 하나가 initial 과 restart 를 가른다', () => {
    it('DB 가 비어 있으면 initial — BACKFILL_DAYS 만큼 거슬러 올라간다', async () => {
      const result = await service.backfillFromLastKnown(SYMBOL, '1m', 1, NOW)

      expect(result.reason).toBe('initial')
      // 하루치 + 경계 봉 = 1,441봉 (구간이 양끝 포함이다).
      // 요청 상한이 1,000이므로 2페이지로 나뉜다.
      expect(result.pages).toBe(2)
      expect(result.fetched).toBe(1441)
    })

    it('DB 에 봉이 있으면 restart — 그 지점부터만 채운다', async () => {
      repo.seed([makeKline(SYMBOL, '1m', NOW - 5 * MINUTE)])

      const result = await service.backfillFromLastKnown(SYMBOL, '1m', 7, NOW)

      expect(result.reason).toBe('restart')
      // 7일치가 아니라 5분치만 채운다 — 이 한 줄이 두 상황을 가른다.
      expect(result.pages).toBe(1)
      expect(result.fetched).toBeLessThan(10)
    })

    it('재연결 복구는 끊긴 시각이 아니라 DB 마지막 봉을 기준으로 삼는다', async () => {
      // 끊기기 직전 몇 초의 저장이 실패했을 수 있다. DB 를 진실로 삼으면
      // 그 구간까지 함께 복구된다.
      repo.seed([makeKline(SYMBOL, '1m', NOW - 3 * MINUTE)])

      const result = await service.backfillFromLastKnownForReconnect(SYMBOL, '1m', NOW)

      expect(result.reason).toBe('reconnect')
      expect(rest.calls[0]?.startTime).toBe(NOW - 3 * MINUTE)
    })

    it('DB 가 빈 상태로 재연결돼도 터지지 않는다', async () => {
      const result = await service.backfillFromLastKnownForReconnect(SYMBOL, '1m', NOW)

      expect(result.reason).toBe('reconnect')
      expect(result.fetched).toBeGreaterThan(0)
    })
  })

  describe('멱등성 — 같은 구간을 다시 긁어도 안전하다', () => {
    it('두 번 돌려도 저장된 봉 수가 늘지 않는다', async () => {
      await service.ensureRange(SYMBOL, '1m', NOW - 10 * MINUTE, NOW, 'scanner')
      const afterFirst = repo.candles.size

      await service.ensureRange(SYMBOL, '1m', NOW - 10 * MINUTE, NOW, 'scanner')

      expect(repo.candles.size).toBe(afterFirst)
    })

    it('구간을 겹쳐 잡아도 안전하다 — 그래서 경계를 정밀하게 계산하지 않아도 된다', async () => {
      await service.ensureRange(SYMBOL, '1m', NOW - 10 * MINUTE, NOW - 5 * MINUTE, 'scanner')
      await service.ensureRange(SYMBOL, '1m', NOW - 7 * MINUTE, NOW, 'scanner')

      const times = await repo.getOpenTimes(SYMBOL, '1m', NOW - 20 * MINUTE, NOW)
      const unique = new Set(times)

      expect(times.length).toBe(unique.size)
    })
  })

  describe('이벤트 기록 — 자가 치유의 증거가 남는다', () => {
    it('시작과 완료가 reason 과 함께 기록된다', async () => {
      await service.ensureRange(SYMBOL, '1m', NOW - 3 * MINUTE, NOW, 'scanner')

      const started = repo.eventsOfType('backfill_started')
      const completed = repo.eventsOfType('backfill_completed')

      expect(started).toHaveLength(1)
      expect(completed).toHaveLength(1)
      expect(started[0]?.detail.reason).toBe('scanner')
      expect(completed[0]?.detail.reason).toBe('scanner')
      expect(completed[0]?.detail.written).toBeGreaterThan(0)
    })

    it('채울 구간이 없으면 아무것도 기록하지 않는다', async () => {
      // 시작이 끝보다 뒤면 채울 것이 없다. 여기서 이벤트를 남기면
      // 대시보드 로그가 "아무 일도 없었다"는 기록으로 가득 찬다.
      // (스캐너가 매 분 도는 구조라 이 가드가 없으면 로그가 금방 쓸모없어진다)
      const result = await service.ensureRange(SYMBOL, '1m', NOW + MINUTE, NOW, 'scanner')

      expect(result.pages).toBe(0)
      expect(repo.events).toHaveLength(0)
      expect(rest.calls).toHaveLength(0)
    })

    it('경계가 같으면 봉 하나를 채운다 — 구간은 양끝을 포함한다', async () => {
      // 재시작 직후 gapMinutes=0 인 경우다. 마지막 봉이 미완성이었을 수 있으므로
      // 한 봉을 다시 받아 확정본으로 덮는 편이 안전하다.
      const result = await service.ensureRange(SYMBOL, '1m', NOW, NOW, 'restart')

      expect(result.pages).toBe(1)
      expect(result.fetched).toBe(1)
    })

    it('완료 후 대시보드에 알린다', async () => {
      await service.ensureRange(SYMBOL, '1m', NOW - 3 * MINUTE, NOW, 'restart')

      expect(bus.published).toHaveLength(1)
      expect(bus.published[0]?.payload).toMatchObject({ type: 'backfill_completed', symbol: SYMBOL })
    })

    it('알림 발행이 실패해도 백필은 성공으로 끝난다', async () => {
      // 데이터는 이미 DB 에 있다. 알림 실패가 백필을 실패로 만들면 안 된다.
      bus.failPublish = true

      const result = await service.ensureRange(SYMBOL, '1m', NOW - 3 * MINUTE, NOW, 'restart')

      expect(result.written).toBeGreaterThan(0)
      expect(repo.eventsOfType('backfill_completed')).toHaveLength(1)
    })
  })

  describe('예외 상황', () => {
    it('빈 페이지(상장 이전 구간)를 만나도 멈추지 않고 계속 채운다', async () => {
      // 요청 구간의 앞부분에는 데이터가 없는 상황
      rest.listedAt = NOW - 3 * MINUTE

      const result = await service.ensureRange(SYMBOL, '1m', NOW - 2000 * MINUTE, NOW, 'initial')

      expect(result.pages).toBeGreaterThan(1)
      expect(result.fetched).toBeGreaterThan(0)
      expect(result.fetched).toBeLessThan(10)
    })

    it('DB 쓰기가 실패하면 백필도 실패한다 — 조용히 성공으로 끝나지 않는다', async () => {
      repo.failNextUpsert = true

      await expect(
        service.ensureRange(SYMBOL, '1m', NOW - 3 * MINUTE, NOW, 'restart'),
      ).rejects.toThrow(/DB 쓰기 실패/)

      // 완료 이벤트가 남으면 안 된다. 남으면 대시보드가 복구됐다고 거짓말한다.
      expect(repo.eventsOfType('backfill_completed')).toHaveLength(0)
    })
  })
})
