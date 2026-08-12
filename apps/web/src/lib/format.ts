/**
 * 표시용 포맷터.
 *
 * 가격은 서버에서 문자열로 온다(NUMERIC 정밀도 보존). 화면에 그릴 때만 number 로
 * 내리고, **그 값을 다시 계산에 쓰지 않는다.** 계산은 전부 SQL 에서 끝나 있다.
 */

const dec2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const num = (v: string | number): number => (typeof v === 'number' ? v : Number(v))

export const fmtPrice = (v: string | number): string => dec2.format(num(v))

/** 축 눈금용 — 큰 수는 정수, 작은 수는 소수점을 남긴다. */
export function fmtAxis(v: number): string {
  if (v >= 1000) return Math.round(v).toLocaleString('en-US')
  return v.toFixed(v >= 100 ? 1 : 2)
}

/** 부호를 항상 붙인다. 색 없이도 방향이 읽혀야 한다. (docs/DESIGN.md §5) */
export const fmtSigned = (v: number, digits = 2): string =>
  `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`

export function fmtCompact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(0)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * 시각은 전부 UTC 로 표시한다.
 * 수집·저장이 UTC 이므로 화면만 로컬로 바꾸면 이벤트 로그와 봉 시각을 대조할 때
 * 머릿속에서 시차를 더해야 한다. 운영 화면에서 그 한 단계가 실수를 만든다.
 */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function hhmmss(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(s % 60)}s`
  return `${s}s`
}

export type Severity = 'good' | 'warning' | 'serious' | 'critical'

/** Data Lag 임계 — docs/DESIGN.md §6. 색은 status 팔레트를 따른다. */
export function lagSeverity(seconds: number | null): Severity {
  if (seconds === null) return 'critical'
  if (seconds < 3) return 'good'
  if (seconds < 10) return 'warning'
  if (seconds < 30) return 'serious'
  return 'critical'
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  good: '정상',
  warning: '주의',
  serious: '경고',
  critical: '위험',
}

/** 심볼 색은 고정 슬롯이다. 필터로 개수가 변해도 색이 재배정되면 안 된다. */
export function symbolColor(symbol: string, symbols: readonly string[]): string {
  const slots = ['var(--btc)', 'var(--eth)', '#38a3a5', '#e5b53a']
  const index = symbols.indexOf(symbol)
  return slots[index >= 0 ? index % slots.length : 0] ?? 'var(--btc)'
}

export const shortSymbol = (symbol: string): string => symbol.replace(/USDT$/, '')
