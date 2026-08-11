import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    // 통합 테스트(DB 필요)는 별도 태그로 분리한다.
    // 순수 함수 테스트만 돌리려면: npm test -- --exclude "**/*.integration.test.ts"
    testTimeout: 20_000,
  },
})
