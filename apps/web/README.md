로드맵 위치: 본선 D-7 / 이전 콘솔 웹 화면(apps/web) / 본선 연결점: 완성도·데모 30점(라이브 데모에서 22상태 진행과 승인을 눈으로 보여 줌)

# web: 이전 콘솔

상태: AI 초안 (목업 API로 동작 확인, 실제 통합본 API로는 아직 안 붙여 봄)

## 무엇을 하나

- 환경 목록 (`GET /environments`)
- 이전 목록 + 진행 막대 (`GET /migrations`, 3초마다)
- 새 이전 만들기 (`POST /migrations`)
- 이전 상세: 정상 경로 15칸 진행 표시, 비정상 상태(멈춤·실패·거절·낡음 등 7개)는 멈춘 칸에 표시, "다음에 갈 수 있는 상태" (1.5초마다)
- 할 일 버튼 (상태에 맞는 것만 보임)
  - `spec_review` → 명세 확정 (`POST /migrations/:id/plan`)
  - `awaiting_approval` → 계획서 보고 승인/거절 (`GET /migrations/:id/plan` → `POST /plans/:id/approvals`, planHash 그대로 보냄)
  - `approved` → 실행 시작 (`POST /migrations/:id/start`)
- POST마다 `Idempotency-Key` 헤더(uuid)를 붙임 (서버는 지금 선택으로 받음)
- 오류는 서버의 `{status, code, message, requestId}`를 그대로 보여 줌

## 서버와 붙는 방법

```text
브라우저 → /api/...  → Vite 프록시 → localhost:3000/api/v1/...
브라우저 → /api/healthz, /api/readyz → localhost:3000/healthz, /readyz
```

- 같은 출처처럼 보이게 해서 API 서버에 CORS 설정이 필요 없음
- 회사 번호는 화면 위쪽 입력칸 → `x-dev-tenant` 헤더 (기본값은 개발 seed 회사)
- 접두사 바꾸기: `API_PREFIX=` (접두사 없음) 또는 `vite.config.ts`의 기본값 한 줄
- 서버 주소 바꾸기: `API_URL=http://다른주소:3000`
- `GET /migrations`, `GET /environments`가 404면 화면이 대체 동작 (이 브라우저가 만든 이전만 / 개발 seed 환경 2개)

## 실행

Service 루트에서 (workspaces가 `apps/*`라 자동 포함):

```bash
npm install
npm run dev -w @svc/web
```

- 첫 줄: 화면 의존성(react, vite)을 루트 node_modules에 설치
- 둘째 줄: http://localhost:5173 에 화면을 띄움. API(3000)는 따로 떠 있어야 함

DB·워커 없이 화면만 볼 때:

```bash
npm run mock -w @svc/web
```

- 3000번에 가짜 API를 띄움. 타이머가 상태를 한 칸씩(1.5초) 옮김. 진짜 API와 동시에 못 띄움

## 파일

| 파일 | 하는 일 |
|---|---|
| `src/api.ts` | 경로 호출 전부. 접두사 상수 `API_BASE` |
| `src/types.ts` | contracts의 화면용 모양을 타입만 옮긴 것 (zod 없이) |
| `src/status.ts` | 상태 한국어 이름, 정상 경로 15칸, 색 |
| `src/usePoll.ts` | 일정 간격 다시 읽기 (SSE 생기면 교체) |
| `src/components/*` | 환경, 이전 목록, 상세, 진행 칸, 계획서 |
| `mock/mock-api.mjs` | 가짜 API (의존성 없음) |

## 핵심 결정 3개 (+대안)

| 결정 | 대안 | 버린 이유 |
|---|---|---|
| Vite 프록시로 같은 출처 | API에 CORS 플러그인 | 공유 파일(main.ts) 수정 필요, 배포 때 허용 출처 관리가 늘어남 |
| 폴링(상세 1.5초, 목록 3초) | SSE `GET /events` | 서버에 아직 없음. 생기면 `usePoll`만 바꿈 |
| contracts 타입을 손으로 복사 | `@svc/contracts` 직접 import | contracts가 zod·NodeNext 기준이라 브라우저 빌드 설정을 더 만져야 함. TODO(human): 통합 후 import로 바꿀지 |

## 셀프 연습 1개

1. `vite.config.ts`에서 `"/api/healthz"` 줄을 지운다
2. 화면 위쪽 점이 빨간색(API 응답 없음)으로 바뀌는 걸 본다
3. 왜 그런지 한 줄로 쓴다. 힌트: `/api/healthz`가 `/api/v1/healthz`로 가는데 서버엔 그 경로가 없다

## 검증 명령과 기대 출력

```bash
npm run build -w @svc/web
```

기대 출력: `tsc` 오류 없이 `✓ built in 1.xs`, `dist/assets/index-*.js` 약 240 kB (gzip 약 76 kB)

【실측】 목업 API(한 칸 0.7초)로 Playwright 전체 흐름 3회: 만들기→명세 검토 1.81~1.84초, 승인 대기 4.66~4.67초, 승인 후 completed 10.73~10.75초, 거절 경로 정상, 브라우저 콘솔 오류 0개.
