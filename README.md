# binance-ops-dashboard

Binance 실시간 거래 데이터 수집 파이프라인과 운영 대시보드.

BTCUSDT · ETHUSDT 의 시세를 WebSocket 으로 상시 수집하고, 어떤 이유로든 데이터에 구멍이 생기면
**스스로 감지해 REST 로 메우는** 파이프라인입니다. 대시보드는 시장 지표와 함께
**파이프라인 자체의 건강 상태**를 보여줍니다.

> 이 프로젝트는 Binance 의 공개 API 를 사용하는 비공식 프로젝트이며, Binance 와 아무런 관련이 없습니다.

---

## 핵심 아이디어

시스템이 다루는 문제는 결국 하나입니다 — **데이터에 구멍이 생기는 순간들.**
최초 실행 시(과거 데이터가 없음), 서버가 죽었다 살아났을 때, 네트워크가 잠깐 끊겼을 때.

이 셋은 사실 같은 문제입니다. *"내가 가진 마지막 봉이 언제인가"*를 묻고 거기서부터 채우면 됩니다.

```ts
const last = await db.maxOpenTime(symbol, '1m')

const from = last ?? (now - BACKFILL_DAYS * DAY)
//           ↑ 이 한 줄이 "최초 백필"과 "재시작 갭 백필"을 가릅니다

await ensureRange(symbol, '1m', from, now)
connectWebSocket()
```

같은 함수가 네 가지 상황을 처리합니다.

| 상황 | from | to | 호출 주체 |
|---|---|---|---|
| 최초 실행 | `now - 7d` | `now` | 부팅 시퀀스 |
| 서버 재시작 | DB 마지막 봉 | `now` | 부팅 시퀀스 |
| WS 재연결 직후 | 끊긴 시각 | `now` | 재연결 핸들러 |
| 중간 구멍 발견 | 구멍 시작 | 구멍 끝 | 무결성 스캐너 |

이것이 성립하는 이유는 **멱등성**입니다. `(symbol, interval, open_time)` 을 기본키로 두고
`ON CONFLICT DO UPDATE` 로 쓰기 때문에, 같은 구간을 몇 번 다시 긁어도 안전합니다.
그래서 구간을 일부러 겹치게 잡아도 됩니다.

---

## 시스템 구조

```
   Binance                  ┌─────────────┐
   ├─ WebSocket  ──실시간──▶ │             │
   └─ REST API   ──백필───▶ │  collector  │ ──▶ ┌──────────┐
                            │   (워커)     │     │ Postgres │
                            └─────────────┘     └────┬─────┘
                                                     │ LISTEN/NOTIFY
                                              ┌──────▼──────┐
                                    브라우저 ◀─│   Next.js   │
                                        SSE   │   (웹)      │
                                              └─────────────┘
```

수집기와 웹 서버는 **별도 프로세스**입니다. 생명주기가 다르기 때문입니다 —
웹은 배포마다 재시작되고 트래픽에 따라 복제되지만, 수집기는 무중단으로 살아 있어야 하고
복제되면 중복 수집이 발생합니다. 합쳐두면 *대시보드 CSS 한 줄 수정이 데이터에 구멍을 냅니다.*

두 프로세스는 서로를 직접 호출하지 않습니다. Postgres 만이 유일한 접점입니다.

---

## 안정성 설계

| 장애 | 대응 |
|---|---|
| WS 연결 끊김 | 지수 백오프 재연결 (1s → 최대 30s, jitter) |
| Binance 24h 강제 종료 | 위 재연결 로직이 동일하게 흡수 |
| **좀비 연결** (끊김 미감지) | `lastMessageAt` watchdog — 10초 무소식이면 강제 재접속 |
| 재연결 동안의 누락 | 재연결 직후 갭 백필 자동 호출 |
| 원인 불명의 누락 | 무결성 스캐너가 주기적으로 연속성 검사 후 자가 치유 |
| REST rate limit | weight 카운터 + 응답 헤더 보정 + `Retry-After` 존중 |
| 프로세스 크래시 | `restart: unless-stopped` → 재시작 시 갭 백필 자동 수행 |
| DB 장애 | 버퍼를 두지 않음 — 원본이 Binance 에 있으므로 복구 후 백필로 해결 |

가장 위험한 장애는 WS 가 끊기는 것이 아니라 **끊긴 걸 모르는 것**입니다.
TCP 연결이 살아 있는데 데이터만 안 오면 `onclose` 가 호출되지 않아 재연결이 영영 발동하지 않고,
대시보드는 멀쩡한 얼굴로 몇 시간 전 값을 띄웁니다. watchdog 이 이 조용한 실패를 잡습니다.

---

## 실행 방법

### 요구사항
- Docker / Docker Compose
- (로컬 개발 시) Node.js 20 이상

### 한 줄 실행

```bash
cp .env.example .env    # 모든 값에 기본값이 있어 그대로 두어도 동작합니다
docker compose up
```

Postgres 와 수집기가 함께 뜨고, 수집기는 부팅 시 과거 7일치를 백필한 뒤 실시간 수집을 시작합니다.

### 로컬 개발

```bash
npm install
docker compose up postgres -d
npm run db:migrate
npm run dev:collector
npm run dev:web
```

### 테스트

```bash
npm test
```

---

## 환경변수

전체 목록과 설명은 [`.env.example`](.env.example) 에 있습니다. 자주 건드리는 값만 옮기면:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SYMBOLS` | `BTCUSDT,ETHUSDT` | 수집 대상. 늘려도 코드 변경 불필요 |
| `BACKFILL_DAYS` | `7` | 최초 실행 시 거슬러 올라갈 기간 |
| `STALE_THRESHOLD_MS` | `10000` | 좀비 연결 판정 임계 |
| `INTEGRITY_SCAN_INTERVAL_MS` | `60000` | 무결성 스캐너 주기 |

---

## 기술 스택

| 레이어 | 선택 |
|---|---|
| 언어 | TypeScript |
| 수집기 | Node.js 독립 워커 |
| 웹 | Next.js (App Router) + React |
| DB | PostgreSQL 16 |
| ORM | Drizzle ORM |
| 실시간 전송 | Postgres `LISTEN/NOTIFY` → SSE |
| 실행 | Docker Compose |

---

## 프로젝트 구조

```
├─ apps/
│  ├─ collector/          # WS 수집 · 백필 · 무결성 스캐너
│  └─ web/                # 대시보드 · API · SSE
├─ packages/
│  ├─ db/                 # Drizzle 스키마 (양쪽 공유)
│  └─ shared/             # 타입 · 설정 · Binance 클라이언트 · 백필 계획
└─ docker-compose.yml
```

---

## 현재 진행 상황

- [x] 모노레포 구성 · Docker Compose · 환경변수 스키마
- [x] 백필 계획 로직 (`resolveBackfillStart` · `planBackfillPages` · `findGaps`)
- [x] Binance REST 클라이언트 + rate limit 가드
- [x] WebSocket 페이로드 파서
- [ ] DB 스키마 및 마이그레이션
- [ ] 백필 서비스 · WS 수집기 · 무결성 스캐너
- [ ] 운영 대시보드
- [ ] 장애 복구 재현 스크립트

---

## 라이선스

MIT
