import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  /**
   * 웹 앱의 `@/` 별칭. Next 는 tsconfig paths 로 풀지만 vitest 는 모른다.
   *
   * `@app/db` 같은 워크스페이스 패키지와 겹치지 않도록 **슬래시까지** 포함해 좁힌다
   * (`@/` 로 시작하는 것만). 정규식을 쓰는 이유가 그것이다.
   */
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./apps/web/src/', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    // 통합 테스트(DB 필요)는 별도 태그로 분리한다.
    // 순수 함수 테스트만 돌리려면: npm test -- --exclude "**/*.integration.test.ts"
    testTimeout: 20_000,
  },
})
