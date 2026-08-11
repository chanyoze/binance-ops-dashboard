# 빌드 컨텍스트는 저장소 루트다 (docker-compose.yml 의 context: .)
# 모노레포이므로 워크스페이스 매니페스트를 먼저 복사해 의존성 레이어를 캐시한다.
FROM node:22-alpine

WORKDIR /app

# 시계열 데이터를 다루므로 컨테이너 타임존을 UTC 로 고정한다.
ENV TZ=UTC
ENV NODE_ENV=production

# 1) 매니페스트만 먼저 복사 -> 소스가 바뀌어도 npm ci 레이어가 재사용된다
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY apps/collector/package.json ./apps/collector/

# tsx 로 TypeScript 를 직접 실행하므로 devDependencies 가 필요하다.
# (별도 빌드 단계를 두지 않은 이유: 산출물이 단일 워커라 빌드 이점이 크지 않고,
#  소스와 실행 코드가 같아 디버깅 시 스택 트레이스가 그대로 읽힌다)
RUN npm ci --include=dev

# 2) 소스 복사
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/collector ./apps/collector

# 루트 권한으로 돌릴 이유가 없다
USER node

CMD ["npm", "run", "start", "-w", "@app/collector"]
