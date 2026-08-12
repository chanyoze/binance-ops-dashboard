import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Binance 수집 파이프라인 운영 대시보드',
  description:
    'Binance 실시간 캔들 수집 파이프라인의 건강 상태와 시장 지표를 함께 보는 운영 대시보드',
}

export const viewport: Viewport = {
  // 상시 표출용 화면이라 사용자 확대를 막지 않는다.
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
