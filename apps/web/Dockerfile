# 빌드 컨텍스트는 저장소 루트다 (docker-compose.yml 의 context: .)
#
# 수집기와 달리 웹은 빌드 단계가 필요하다. Next 는 라우트 매니페스트와 서버
# 번들을 만들어야 동작하므로 tsx 로 소스를 그대로 돌릴 수 없다.
# 대신 **빌드 결과만 남기는 2단계 이미지**로 만들어, 실행 이미지에
# TypeScript·번들러 같은 빌드 도구가 따라오지 않게 한다.

# ---------- 1단계: 빌드 ----------
FROM node:22-alpine AS builder

WORKDIR /app
ENV TZ=UTC
# next build 는 devDependencies(next, typescript)가 필요하므로 여기서는 production 이 아니다.
ENV NEXT_TELEMETRY_DISABLED=1

# 매니페스트만 먼저 복사 -> 소스가 바뀌어도 npm ci 레이어가 재사용된다
# 워크스페이스 매니페스트는 전부 있어야 합니다 — npm 은 package.json 의 workspaces
# 목록에 선언된 디렉터리가 실재하지 않으면 lockfile 검증에 실패합니다.
# 다만 설치는 web 과 루트로 한정해 수집기 전용 의존성(ws 등)은 받지 않습니다.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY apps/collector/package.json ./apps/collector/
COPY apps/web/package.json ./apps/web/

RUN npm ci --include=dev --workspace @app/web --include-workspace-root

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# DATABASE_URL 은 빌드에 필요 없다. 페이지가 전부 force-dynamic 이라
# 빌드 시점에 DB 를 읽지 않는다 — 빌드가 DB 기동에 의존하지 않게 하려는 설계다.
RUN npm run build -w @app/web

# ---------- 2단계: 실행 ----------
FROM node:22-alpine AS runner

WORKDIR /app
ENV TZ=UTC
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# next.config.ts 의 output:'standalone' 이 실행에 필요한 모듈만 추려 놓는다.
# 여기서 npm ci 를 다시 돌리지 않는 이유가 그것이다 — 그러면 next·react·빌드 도구까지
# 딸려 들어와 이미지가 1GB 를 넘는다.
#
# outputFileTracingRoot 를 저장소 루트로 잡아 두었으므로 standalone 안의 경로도
# 저장소 구조를 그대로 따른다: standalone/apps/web/server.js
COPY --from=builder /app/apps/web/.next/standalone ./
# 정적 자산은 추적 대상이 아니라 따로 옮겨야 한다.
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# 루트 권한으로 돌릴 이유가 없다
USER node

EXPOSE 3000

# standalone 서버는 Next CLI 를 거치지 않고 직접 실행한다.
CMD ["node", "apps/web/server.js"]
