import { describe, expect, it } from 'vitest'
import {
  alignToInterval,
  calculateCoverage,
  findGaps,
  planBackfillPages,
  resolveBackfillStart,
} from '../backfill-plan.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** 분 경계에 정렬된 기준 시각 */
const BASE = alignToInterval(1_700_000_000_000, MINUTE)

/**
 * 테스트 1·2 — 백필 시작점 결정.
 *
 * 과제 요구사항 두 가지("최초 실행 백필", "재시작 갭 백필")가
 * 같은 함수의 두 분기로 처리된다는 것이 이 프로젝트 설계의 핵심 주장이다.
 * 그 주장이 실제로 성립하는지 검증한다. (docs/DECISIONS.md D-02)
 */
describe('resolveBackfillStart — 두 요구사항이 하나의 분기로 갈린다', () => {
  it('[요구사항 1] DB가 비어 있으면 (lastOpenTime=null) 설정된 기간만큼 과거로 거슬러 간다', () => {
    const from = resolveBackfillStart({
      lastOpenTime: null,
      now: BASE,
      backfillDays: 7,
      intervalMs: MINUTE,
    })

    expect(from).toBe(BASE - 7 * DAY)
  })

  it('[요구사항 2] DB에 데이터가 있으면 마지막 봉 시각부터 이어서 긁는다', () => {
    const lastOpenTime = BASE - 45 * MINUTE

    const from = resolveBackfillStart({
      lastOpenTime,
      now: BASE,
      backfillDays: 7,
      intervalMs: MINUTE,
    })

    // backfillDays(7일)는 완전히 무시되어야 한다 — 재시작 시에는 갭 구간만 채운다.
    expect(from).toBe(lastOpenTime)
  })

  it('마지막 봉을 건너뛰지 않고 그 봉부터 다시 긁는다 (미완성 봉 고착 방지)', () => {
    const lastOpenTime = BASE - 10 * MINUTE

    const from = resolveBackfillStart({
      lastOpenTime,
      now: BASE,
      backfillDays: 7,
      intervalMs: MINUTE,
    })

    // lastOpenTime + MINUTE 이 아니라 lastOpenTime 자체여야 한다.
    // 마지막 봉은 WS 로 받다 죽었다면 미완성 상태로 남아 있을 수 있고,
    // UPSERT 가 멱등성을 보장하므로 다시 긁는 비용은 사실상 0이다. (D-03)
    expect(from).toBe(lastOpenTime)
    expect(from).not.toBe(lastOpenTime + MINUTE)
  })

  it('분 경계에 맞춰 내림 정렬한다 (Binance 봉 시작 시각과 일치시키기 위함)', () => {
    const unaligned = BASE + 37_123 // 분 중간의 어중간한 시각

    const from = resolveBackfillStart({
      lastOpenTime: unaligned,
      now: BASE + DAY,
      backfillDays: 7,
      intervalMs: MINUTE,
    })

    expect(from).toBe(BASE)
    expect(from % MINUTE).toBe(0)
  })
})

/**
 * 테스트 3 — 페이지네이션.
 * 경계에서 봉 하나를 흘리기 가장 쉬운 지점이라 별도로 검증한다.
 */
describe('planBackfillPages — Binance 1회 조회 상한(1000)에 맞춰 자른다', () => {
  it('2,500개 구간이 1000 / 1000 / 500 으로 나뉜다', () => {
    const from = BASE
    const to = BASE + 2_499 * MINUTE // 양 끝 포함이므로 2,500개

    const pages = planBackfillPages(from, to, MINUTE, 1000)

    expect(pages.map((p) => p.expectedCount)).toEqual([1000, 1000, 500])
  })

  it('페이지 사이에 빈틈도 겹침도 없다', () => {
    const from = BASE
    const to = BASE + 2_499 * MINUTE

    const pages = planBackfillPages(from, to, MINUTE, 1000)

    for (let i = 1; i < pages.length; i++) {
      const prevEnd = pages[i - 1]!.endTime
      const currStart = pages[i]!.startTime
      // 이전 페이지의 마지막 봉 바로 다음 봉에서 시작해야 한다.
      expect(currStart).toBe(prevEnd + MINUTE)
    }
  })

  it('전체 구간을 정확히 덮는다', () => {
    const from = BASE
    const to = BASE + 2_499 * MINUTE

    const pages = planBackfillPages(from, to, MINUTE, 1000)

    expect(pages[0]!.startTime).toBe(from)
    expect(pages.at(-1)!.endTime).toBe(to)
    expect(pages.reduce((sum, p) => sum + p.expectedCount, 0)).toBe(2500)
  })

  it('구간이 정확히 1000개면 페이지 하나로 끝난다 (경계값)', () => {
    const pages = planBackfillPages(BASE, BASE + 999 * MINUTE, MINUTE, 1000)

    expect(pages).toHaveLength(1)
    expect(pages[0]!.expectedCount).toBe(1000)
  })

  it('구간이 1001개면 1000 / 1 로 나뉜다 (경계값 +1)', () => {
    const pages = planBackfillPages(BASE, BASE + 1_000 * MINUTE, MINUTE, 1000)

    expect(pages.map((p) => p.expectedCount)).toEqual([1000, 1])
  })

  it('봉 하나짜리 구간도 정상 처리한다', () => {
    const pages = planBackfillPages(BASE, BASE, MINUTE, 1000)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toEqual({ startTime: BASE, endTime: BASE, expectedCount: 1 })
  })

  it('채울 구간이 없으면 빈 배열을 반환한다 (이미 최신인 경우)', () => {
    const pages = planBackfillPages(BASE + MINUTE, BASE, MINUTE, 1000)

    expect(pages).toEqual([])
  })
})

/** 무결성 스캐너가 사용하는 구멍 탐지 — 자가 치유의 출발점 */
describe('findGaps — 연속이어야 할 봉 목록에서 구멍을 찾는다', () => {
  it('구멍이 없으면 빈 배열', () => {
    const times = [BASE, BASE + MINUTE, BASE + 2 * MINUTE]

    expect(findGaps(times, MINUTE)).toEqual([])
  })

  it('중간에 빠진 3개 봉을 정확한 구간으로 짚어낸다', () => {
    // BASE+1 ~ BASE+3 이 없음
    const times = [BASE, BASE + 4 * MINUTE, BASE + 5 * MINUTE]

    expect(findGaps(times, MINUTE)).toEqual([
      { startTime: BASE + MINUTE, endTime: BASE + 3 * MINUTE, missingCount: 3 },
    ])
  })

  it('구멍이 여러 개면 전부 찾는다', () => {
    const times = [BASE, BASE + 3 * MINUTE, BASE + 4 * MINUTE, BASE + 9 * MINUTE]

    const gaps = findGaps(times, MINUTE)

    expect(gaps).toHaveLength(2)
    expect(gaps[0]!.missingCount).toBe(2)
    expect(gaps[1]!.missingCount).toBe(4)
  })

  it('빈 목록과 원소 하나짜리 목록을 안전하게 처리한다', () => {
    expect(findGaps([], MINUTE)).toEqual([])
    expect(findGaps([BASE], MINUTE)).toEqual([])
  })
})

/** 대시보드의 데이터 완전성(coverage) 지표 */
describe('calculateCoverage — 기대 봉 수 대비 실제 적재 수', () => {
  it('빠짐없이 채워져 있으면 1', () => {
    expect(calculateCoverage(100, BASE, BASE + 99 * MINUTE, MINUTE)).toBe(1)
  })

  it('절반이 비어 있으면 0.5', () => {
    expect(calculateCoverage(50, BASE, BASE + 99 * MINUTE, MINUTE)).toBe(0.5)
  })

  it('중복 등으로 기대치를 넘겨도 1을 넘지 않는다', () => {
    expect(calculateCoverage(150, BASE, BASE + 99 * MINUTE, MINUTE)).toBe(1)
  })
})
