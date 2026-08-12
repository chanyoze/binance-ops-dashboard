import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

/** 모노레포 최상단. 워크스페이스 패키지가 이 아래에 있다. */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * 워크스페이스 패키지를 소스 그대로 가져온다.
   * `@app/db` · `@app/shared` 는 빌드 산출물(dist)을 만들지 않고 TS 로 두고 있어,
   * Next 가 직접 트랜스파일하게 해야 한다. 빌드 순서를 따로 관리하지 않아도 된다.
   */
  transpilePackages: ['@app/db', '@app/shared'],

  /**
   * 워크스페이스 패키지는 Node ESM 규칙대로 상대 임포트에 `.js` 를 붙인다
   * (`./backfill-plan.js`). 실제 파일은 `.ts` 이고, 이 프로젝트는 빌드 산출물을
   * 만들지 않고 tsx 로 소스를 그대로 실행한다. 번들러에게 같은 치환을 알려준다.
   *
   * 패키지를 dist 로 빌드하는 쪽이 흔한 해법이지만, 그러면 수집기의
   * "소스와 실행 코드가 같아 스택 트레이스가 그대로 읽힌다"는 선택이 깨진다.
   * 빌드 단계를 늘리는 대신 번들러 설정 두 줄로 끝낸다.
   */
  /**
   * 상대 임포트의 `.js` 를 `.ts` 로 치환한다.
   *
   * 워크스페이스 패키지는 TypeScript ESM 표준대로 상대 임포트에 `.js` 를 붙이고
   * (`./backfill-plan.js`) 실제 파일은 `.ts` 다. 이 프로젝트는 빌드 산출물을
   * 만들지 않고 tsx 로 소스를 그대로 실행하므로, 번들러에게 같은 치환을 알려줘야 한다.
   *
   * **이 옵션은 webpack 에서만 동작한다.** Turbopack 은 아직 이 치환을 하지 않아
   * `next build` 가 모듈을 못 찾는다. 그래서 웹 빌드만 `--webpack` 으로 돌린다
   * (package.json 의 dev/build/start 스크립트).
   *
   * 대안을 검토한 결과:
   *  - 패키지를 dist 로 빌드 → 수집기의 "소스와 실행 코드가 같아 스택 트레이스가
   *    그대로 읽힌다"는 결정이 깨지고 Dockerfile 에 빌드 단계가 붙는다
   *  - `.js` 확장자 제거 → 표준 ESM 표기를 버리게 된다 (문제는 우리 코드가 아니다)
   * 둘 다 번들러 하나 바꾸는 것보다 비싸다. Turbopack 이 지원하면 플래그만 지운다.
   */
  experimental: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
  },

  /**
   * 실행에 실제로 필요한 파일만 추려 `.next/standalone` 으로 낸다.
   *
   * 이게 없으면 실행 이미지에 node_modules 전체(next·react·타입 등)를 다시 설치해야 해서
   * 1GB를 넘는다. standalone 은 추적된 모듈만 넣으므로 배포 이미지가 크게 줄고,
   * Railway 처럼 이미지를 매번 올려야 하는 환경에서 배포 시간이 직접 짧아진다.
   */
  output: 'standalone',

  // 모노레포 루트를 알려준다. 이 값이 없으면 standalone 추적이 apps/web 만 보고
  // 워크스페이스 패키지(packages/*)를 빠뜨린다.
  outputFileTracingRoot: repoRoot,

  /**
   * `pg` 는 네이티브 모듈을 조건부로 로드한다. 번들러가 정적으로 따라가면
   * 빌드가 깨지므로 서버 런타임에서 그대로 require 하게 둔다.
   */
  serverExternalPackages: ['pg'],

  // 대시보드는 항상 최신 데이터를 보여줘야 한다. 응답을 캐시하지 않는다.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ]
  },
}

export default config
