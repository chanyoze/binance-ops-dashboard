/**
 * 재연결 지수 백오프.
 *
 * 상한이 없으면 몇 시간 뒤에 재접속을 시도하게 되어 사실상 영영 복구하지 못한다.
 * 상한을 두는 것이 이 함수의 핵심이며, 그래서 테스트 대상이다. (docs/DECISIONS.md D-10 #6)
 *
 * jitter 를 분리한 이유: 난수를 주입 가능하게 만들어 결정론적으로 테스트하기 위함이다.
 */

/**
 * attempt 회차의 기본 대기 시간. 1s -> 2s -> 4s -> 8s ... maxMs 에서 고정.
 *
 * @param attempt 1부터 시작하는 시도 회차
 */
export function calculateBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt < 1) throw new Error('attempt 는 1 이상이어야 합니다.')

  // 2^30 을 넘어가면 부동소수 오차가 생기므로 지수를 미리 잘라낸다.
  const exponent = Math.min(attempt - 1, 30)
  const raw = baseMs * 2 ** exponent

  return Math.min(raw, maxMs)
}

/**
 * 대기 시간에 지터를 적용한다. 결과는 [delay * (1 - ratio), delay] 범위.
 *
 * 워커를 여러 개로 확장했을 때 동시에 끊기면 전부 같은 타이밍에 재접속을 시도해
 * Binance 쪽에 순간 부하(thundering herd)를 준다. 지금은 워커가 1개라 무의미하지만,
 * 심볼 샤딩으로 확장하는 순간 필요해지므로 처음부터 넣어둔다. (D-04)
 */
export function applyJitter(delayMs: number, ratio = 0.2, random: () => number = Math.random): number {
  const clampedRatio = Math.max(0, Math.min(1, ratio))
  const factor = 1 - clampedRatio * random()
  return Math.round(delayMs * factor)
}

/** 실사용 진입점 — 지수 백오프 + 지터를 한 번에 계산한다. */
export function nextReconnectDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  return applyJitter(calculateBackoffDelay(attempt, baseMs, maxMs), 0.2, random)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
