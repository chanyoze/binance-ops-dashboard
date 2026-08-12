'use client'

import { useEffect } from 'react'

/**
 * 대시보드가 뜨지 못했을 때의 화면.
 *
 * 운영 도구에서 가장 나쁜 실패는 **아무것도 안 보이는 것**이다. 화면이 비면
 * 보는 사람은 "시장이 조용한가" 와 "수집이 죽었나" 를 구분하지 못한다.
 * 그래서 무엇이 실패했는지와 무엇을 확인해야 하는지를 말하고, 재시도를 준다.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] 렌더 실패', error)
  }, [error])

  return (
    <main
      style={{
        height: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 460, display: 'grid', gap: 14, justifyItems: 'center' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderRadius: 999,
            background: 'var(--surface-2)',
            border: '1px solid var(--axis)',
            fontSize: 11.5,
            color: 'var(--ink-2)',
          }}
        >
          <span
            style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--critical)' }}
          />
          <b style={{ color: 'var(--ink)' }}>대시보드를 불러오지 못했습니다</b>
        </span>

        <p style={{ margin: 0, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
          데이터베이스에 연결하지 못했거나 조회가 실패했습니다.
          <br />
          <code style={{ fontFamily: 'var(--mono)', color: 'var(--ink-muted)' }}>
            docker compose up -d
          </code>{' '}
          로 Postgres 와 수집기가 떠 있는지 확인해 주세요.
        </p>

        {error.digest ? (
          <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-muted)' }}>
            digest {error.digest}
          </p>
        ) : null}

        <button
          type="button"
          onClick={reset}
          style={{
            border: '1px solid var(--axis)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 6,
            padding: '7px 16px',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          다시 시도
        </button>
      </div>
    </main>
  )
}
