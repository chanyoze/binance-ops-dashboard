# AGENTS.md

이 저장소에서 작업하는 에이전트/개발자를 위한 지침.

**이 문서의 목적은 이미 근거를 갖고 내린 결정이 조용히 뒤집히는 것을 막는 데 있다.**
아래 "하지 말 것" 항목은 대부분 *상식적으로는 추가하고 싶어지는* 것들이며, 그래서 명시적으로 적어둔다.

---

## 이 프로젝트가 푸는 문제

Binance 실시간 시세를 수집하는 파이프라인. 요구사항은 세 줄처럼 보이지만 사실 하나다 —
**데이터에 구멍이 생기는 순간들을 어떻게 다루는가.**

구멍은 네 가지 경로로 생긴다: ① 최초 실행(과거 데이터 없음) ② 프로세스 크래시 ③ WS 연결 끊김 ④ DB 장애.
**네 가지 모두 복구 코드는 `ensureRange` 하나다.** 이 통합이 설계의 중심이며, 깨뜨리지 말 것.

---

## 아키텍처 불변 규칙

### 1. collector 와 web 은 별도 프로세스다 — 합치지 말 것
생명주기가 다르다. web 은 배포마다 재시작되고 트래픽에 따라 복제되지만,
collector 는 무중단이어야 하고 복제되면 중복 수집이 발생한다.
합치면 **대시보드 CSS 한 줄 수정이 데이터에 구멍을 낸다.**

### 2. 두 프로세스는 서로를 직접 호출하지 않는다
Postgres 만이 유일한 접점이다. collector 는 web 의 존재를 몰라야 한다.
collector 에서 HTTP 로 web 을 부르거나, web 에서 collector 를 부르는 코드를 추가하지 말 것.

### 3. 백필은 `ensureRange(symbol, interval, from, to)` 하나로만 한다
"최초 백필용 함수"와 "갭 복구용 함수"를 따로 만들지 말 것. 같은 문제다.
시작점은 `lastOpenTime ?? (now - BACKFILL_DAYS)` 로 결정된다.

**재시작 시 `lastOpenTime + interval` 이 아니라 `lastOpenTime` 자체부터 다시 긁는다.**
마지막 봉은 미완성 상태로 저장돼 있을 수 있다. 이걸 "중복이니 건너뛰자"로 바꾸지 말 것.

### 4. 모든 kline 쓰기는 UPSERT 다
```sql
PRIMARY KEY (symbol, interval, open_time)
INSERT ... ON CONFLICT (symbol, interval, open_time) DO UPDATE SET ...
```
멱등성은 최적화가 아니라 **전제 조건**이다. 이게 있어서 구간을 겹치게 긁어도 되고,
백필과 실시간 수집이 동시에 같은 봉을 써도 되고, WS 의 미완성 봉이 확정 봉으로 자연히 덮인다.
`INSERT ... ON CONFLICT DO NOTHING` 으로 바꾸지 말 것 — 미완성 봉이 영구 고착된다.

### 5. 가격·수량은 문자열로 다룬다
JS `number` 는 배정밀도 부동소수라 시세를 정확히 표현하지 못한다.
Postgres `NUMERIC` ↔ TS `string` 으로 주고받는다. **`parseFloat` 로 변환해 저장하지 말 것.**
계산이 필요하면 SQL 에서 한다.

### 6. 집계 지표는 SQL 에서 계산한다
VWAP, 이동평균, Taker 비율, 커버리지 모두 쿼리/뷰로 산출한다.
애플리케이션 메모리에 누적 상태를 두지 말 것 — 웹을 재시작하면 리셋되고, 인스턴스를 늘리면 값이 갈린다.

### 7. 실시간 전송은 어댑터 뒤에 숨긴다
```ts
interface RealtimeBus {
  publish(channel: string, payload: object): Promise<void>
  subscribe(channel: string, handler: (payload: object) => void): Promise<void>
}
```
기본 구현은 Postgres `LISTEN/NOTIFY`. 이 인터페이스를 우회해 직접 `pg.query('NOTIFY ...')` 를
호출하지 말 것 — Redis 로 교체 가능한 구조를 유지하는 것이 요점이다.

---

## 하지 말 것 (전부 의도적으로 배제한 것들)

| 하지 말 것 | 이유 |
|---|---|
| **aggTrade 원본을 DB에 저장** | Taker 비율은 kline 의 `takerBuyBaseVolume` 로 이미 계산된다. aggTrade 는 `fromId` 기반 페이지네이션이라 시간 기반 복구 모델과 맞지 않아, 저장하면 복구 경로가 하나 더 생긴다. 받아서 최신가만 갱신하고 버린다 |
| **쓰기 버퍼 / 재시도 큐 / Kafka 추가** | 원본이 Binance REST 에 남아 있다. **Binance API 자체가 우리의 백업 저장소다.** 복구 가능한 원본이 외부에 있는데 자체 버퍼를 만드는 것은 해결된 문제를 다시 만드는 일이다 |
| **여러 인터벌을 각각 수집** | 1m 만 수집하고 5m/1h 는 SQL 롤업으로 만든다. 인터벌마다 수집하면 무결성 검증을 인터벌 수만큼 해야 하고 정합성 불일치가 생긴다 |
| **이중 축(dual-axis) 차트** | BTC(~$67k)와 ETH(~$3.2k)를 한 차트에 그릴 때 축을 두 개 두면, 눈금 설정만으로 "ETH가 BTC를 추월했다"는 착시를 임의로 만들 수 있다. **구간 시작가를 100으로 지수화**해 단일 축으로 그린다 |
| **초록/빨강만으로 등락 표현** | 적록색약에서 두 색의 거리가 ΔE 4.1 (허용 최저선 6). 캔들은 몸통 기하학이 2차 인코딩이라 유지하되, **숫자에는 반드시 부호(+/−)와 ▲▼ 아이콘을 병기**한다 |
| **오더북(depth) 수집** | 요구사항이 아니며 복잡도만 증가 |
| **커밋에 AI Co-Authored-By 트레일러** | AI 사용은 `docs/AI-USAGE.md` 에서 밝힌다. 트레일러는 "썼다"만 말할 뿐 "어떻게 썼는지"를 말하지 못한다 |
| **심볼 하드코딩** | `SYMBOLS` 환경변수로 처리한다. 코드에 `'BTCUSDT'` 를 직접 쓰지 말 것 |

---

## 코드 컨벤션

- **TypeScript strict**. `any` 금지. 타입 단언(`as`)은 외부 API 응답 파싱 경계에서만.
- **주석은 "무엇"이 아니라 "왜"를 쓴다.** 코드가 하는 일은 코드가 말한다.
  판단이 갈릴 수 있었던 지점(임계값, 트레이드오프, 배제한 대안)에만 주석을 단다.
- **주석과 커밋 메시지는 한국어**, 코드 식별자는 영어.
- 순수 함수와 I/O 를 분리한다. 위험한 계산(갭 산정, 백오프, 파싱)은 순수 함수로 격리해 테스트 가능하게 둔다.
- 파일 최상단에 그 파일이 존재하는 이유를 한 문단으로 적는다.

## 테스트 철학

**커버리지를 올리는 테스트는 쓰지 않는다.** "여기가 깨지면 데이터에 구멍이 난다"는 지점만 고른다.

현재 대상: 갭 구간 계산 · 페이지네이션 경계 · UPSERT 멱등성 · UPSERT 갱신(미완성→확정) ·
백오프 상한 · watchdog 트리거 · 무결성 스캐너 구멍 탐지.

DB 가 필요한 테스트는 `*.integration.test.ts` 로 분리한다.

## 커밋 컨벤션

Conventional Commits (`feat:` `fix:` `test:` `chore:` `docs:`), 스코프는 워크스페이스명 (`feat(shared):`).

**커밋 본문에 판단 근거를 적는다.** 무엇을 바꿨는지는 diff 가 말한다.
왜 그 선택을 했고 무엇을 배제했는지를 적는다. 한 커밋 = 한 관심사.

---

## 명령어

```bash
npm install                  # 워크스페이스 전체 설치
docker compose up            # Postgres + collector 기동
npm run db:migrate           # 마이그레이션
npm run dev:collector        # 수집기 (로컬)
npm run dev:web              # 대시보드 (로컬)
npm test                     # 단위 + 통합 테스트
npm run typecheck            # 타입체크
npm run demo:chaos           # 장애 복구 재현 — 수집기를 죽이고 자가 치유를 검증
```

## 저장소 구조

```
apps/collector/     WS 수집 · 백필 · 무결성 스캐너 (장기 실행 워커)
apps/web/           Next.js 대시보드 · API · SSE
packages/db/        Drizzle 스키마 + 마이그레이션 (양쪽 공유)
packages/shared/    타입 · 설정 · Binance 클라이언트 · 백필 계획
docs/               공개 문서 (ARCHITECTURE / METRICS / AI-USAGE)
```

`.gitignore` 에 개인 작업 노트(`PLAN.md`, `docs/DECISIONS.md`, `docs/DESIGN.md`,
`docs/INTERVIEW-PREP.md`)가 포함되어 있다. **이 파일들을 커밋하지 말 것.**
공개 문서는 그 노트를 원본으로 별도 작성한다.

## 작업 시작 전 확인

1. 위 "하지 말 것" 표를 읽었는가
2. 변경이 `ensureRange` 통합이나 UPSERT 멱등성을 깨뜨리지 않는가
3. 새 설정값을 추가했다면 `.env.example` 에 설명과 함께 넣었는가
