/**
 * 백필 계획 수립 — 이 프로젝트의 심장부.
 *
 * 과제 요구사항 두 가지
 *   (1) 최초 실행 시 과거 시세 백필
 *   (2) 서버 재시작 후 누락 구간 백필
 * 는 사실 같은 문제다. "내가 가진 마지막 봉이 언제인가"를 묻고, 거기서부터 지금까지 긁으면 된다.
 * 차이는 그 질문의 답이 null 이냐 값이냐 뿐이다. (docs/DECISIONS.md D-02)
 *
 * 여기 있는 함수는 전부 순수 함수다 — 네트워크도 DB도 시계도 건드리지 않는다.
 * 파이프라인 전체에서 가장 위험한 계산이므로, 테스트가 쉬운 형태로 격리했다.
 */

export interface BackfillRange {
  /** 포함 (inclusive) */
  startTime: number
  /** 포함 (inclusive) */
  endTime: number
  /** 이 요청으로 기대되는 캔들 개수 */
  expectedCount: number
}

export interface ResolveStartInput {
  /** DB 에 저장된 가장 최근 봉의 openTime. 없으면 null. */
  lastOpenTime: number | null
  /** 현재 시각 (epoch ms) */
  now: number
  /** 최초 실행 시 거슬러 올라갈 기간(일) */
  backfillDays: number
  intervalMs: number
}

/**
 * 백필 시작 시각을 결정한다. **분기 하나가 두 요구사항을 가른다.**
 *
 *   lastOpenTime === null  ->  최초 실행   : now - backfillDays
 *   lastOpenTime !== null  ->  재시작 갭   : 마지막 봉부터
 *
 * 재시작의 경우 `lastOpenTime + intervalMs` 가 아니라 **lastOpenTime 그 자체**부터 다시 긁는다.
 * 마지막 봉은 WS 로 받다가 프로세스가 죽었다면 미완성(isClosed=false) 상태로 남아 있을 수 있기 때문이다.
 * UPSERT 가 멱등성을 보장하므로(D-03) 한 봉을 다시 긁는 비용은 사실상 0이고,
 * 그 대가로 "마지막 봉이 미완성으로 영구 고착되는" 버그를 원천 차단한다.
 */
export function resolveBackfillStart(input: ResolveStartInput): number {
  const { lastOpenTime, now, backfillDays, intervalMs } = input

  if (lastOpenTime === null) {
    const from = now - backfillDays * 24 * 60 * 60 * 1000
    return alignToInterval(from, intervalMs)
  }

  return alignToInterval(lastOpenTime, intervalMs)
}

/**
 * [from, to] 구간을 Binance 의 1회 최대 조회 개수(limit)에 맞춰 페이지로 자른다.
 *
 * 경계에서 봉 하나를 흘리기 가장 쉬운 지점이라 별도 함수로 분리했다.
 * 양 끝이 모두 포함(inclusive)이므로 2,500개 구간은 1000 / 1000 / 500 으로 나뉜다.
 */
export function planBackfillPages(
  from: number,
  to: number,
  intervalMs: number,
  maxPerRequest = 1000,
): BackfillRange[] {
  if (intervalMs <= 0) throw new Error('intervalMs 는 양수여야 합니다.')
  if (maxPerRequest <= 0) throw new Error('maxPerRequest 는 양수여야 합니다.')

  const start = alignToInterval(from, intervalMs)
  const end = alignToInterval(to, intervalMs)

  // 채울 구간이 없음 — 이미 최신이다.
  if (end < start) return []

  const totalCount = Math.floor((end - start) / intervalMs) + 1
  const pages: BackfillRange[] = []

  for (let offset = 0; offset < totalCount; offset += maxPerRequest) {
    const pageStart = start + offset * intervalMs
    const remaining = totalCount - offset
    const count = Math.min(maxPerRequest, remaining)
    const pageEnd = pageStart + (count - 1) * intervalMs

    pages.push({ startTime: pageStart, endTime: pageEnd, expectedCount: count })
  }

  return pages
}

/**
 * 연속이어야 할 1분봉 목록에서 구멍을 찾아낸다. 무결성 스캐너가 사용한다.
 *
 * @param openTimes DB 에 실제로 존재하는 openTime 목록 (오름차순 정렬 가정)
 * @returns 빠진 구간들 — 그대로 ensureRange 에 넘기면 된다.
 */
export function findGaps(
  openTimes: readonly number[],
  intervalMs: number,
): Array<{ startTime: number; endTime: number; missingCount: number }> {
  const gaps: Array<{ startTime: number; endTime: number; missingCount: number }> = []

  for (let i = 1; i < openTimes.length; i++) {
    const prev = openTimes[i - 1]!
    const curr = openTimes[i]!
    const delta = curr - prev

    if (delta <= intervalMs) continue

    const missingCount = Math.floor(delta / intervalMs) - 1
    if (missingCount <= 0) continue

    gaps.push({
      startTime: prev + intervalMs,
      endTime: curr - intervalMs,
      missingCount,
    })
  }

  return gaps
}

/**
 * 기대 캔들 수 대비 실제 적재 수 = 데이터 완전성(coverage).
 * 대시보드의 핵심 운영 지표이며, 이 값이 100%가 아니면 어딘가에 구멍이 있다는 뜻이다.
 */
export function calculateCoverage(
  actualCount: number,
  from: number,
  to: number,
  intervalMs: number,
): number {
  const expected = Math.floor((alignToInterval(to, intervalMs) - alignToInterval(from, intervalMs)) / intervalMs) + 1
  if (expected <= 0) return 1
  return Math.min(1, actualCount / expected)
}

/** 임의 시각을 인터벌 경계로 내림 정렬한다. Binance 의 봉 시작 시각과 맞추기 위함. */
export function alignToInterval(timestamp: number, intervalMs: number): number {
  return Math.floor(timestamp / intervalMs) * intervalMs
}
