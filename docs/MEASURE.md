로드맵 위치: 결선 주간 / 실환경 측정값 수집·문서 수치 갱신 / 완성도·데모 30, 팀 개발(측정 숫자) 20

# 실측값 모으기와 문서 수치 바꾸기 (작업 Z40)

문서 상태: DRAFT(ai), 2026-11-01 KST. STUB 환경에서 두 도구 모두 돌려 봤다. 실제 클라우드 값으로는 아직 안 돌렸다.

## 0. 그림 한 장

```mermaid
flowchart LR
  A[이전 1건 끝남] --> B[collect.sh]
  B --> C[측정 JSON]
  C --> D[apply-numbers.mjs dry-run]
  D --> E[사람이 차이 확인]
  E --> F[--write 사본 또는 --in-place]
```

- `collect.sh`: 이전 1건이 끝난 뒤 API·DB에서 숫자를 읽어 JSON 1개로 만든다. 읽기만 한다.
- `apply-numbers.mjs`: JSON을 읽어 문서 속 옛 수치를 새 값으로 바꾸고, 출처 표시를 `【사실, 실측 날짜 조건】`으로 고친다. 기본은 보여 주기만 한다(dry-run).

## 1. 무엇을 모으나

| JSON 칸 | 뜻 | 어디서 |
|---|---|---|
| `steps` | 상태마다 머문 시간(ms) | `GET /migrations/:id/report` 타임라인 |
| `summary.totalMs` | 이전 1건 전체 소요 | 리포트 요약 |
| `cutoverPauseMs` | 컷오버 쓰기 멈춤 | 측정값 `cutover_pause_ms`, env=target |
| `rollbackPauseMs` | 컷오버 뒤 롤백 쓰기 멈춤 | 측정값 `cutover_pause_ms`, env=source (롤백한 이전에만 있음) |
| `replicationLagMs` | 복제 지연 최대 | 측정값 `replication_lag_ms` |
| `cost` | AWS·GCP·온프레 월 비용, 절약, 크레딧, 분기점, 가격 출처(seed/live) | `POST /cost/estimate`(데모 요청) + `GET /migrations/:id/cost` |
| `security` | 보안 표 지켜짐·약점·위반·미구현 건수 | `GET /migrations/:id/security` (Z18 합쳐진 뒤) |
| `stub` | 어느 단계가 STUB였나 | 감사 기록 `detail.stub` (psql 없으면 리포트 gaps) |
| `manual` | 손으로 넣은 값 | `--set 이름=값` |

`manual`에 넣을 수 있는 이름: `writes_total`, `writes_failed`, `writers`(부하 도구가 센 쓰기 수), `refresh_s`(화면 새로고침 체감 초).

## 2. 먼저 STUB로 한 번 (클라우드 없이, 5분)

터미널 3개를 쓴다. 명령마다 무엇을 하는지 위에 적었다.

DB를 띄우고 표를 만든다.

```
npm run db:up
```

API를 켠다 (터미널 1).

```
npm run dev:api
```

워커를 STUB로 켠다 (터미널 2). gitops를 끄면 배포 단계가 가짜로 돈다.

```
GITOPS_DISABLE=1 npm run dev:worker
```

이전 1건을 끝까지 돌린다 (터미널 3).

```
npm run smoke
```

방금 끝난 이전의 숫자를 모은다. 마지막에 JSON 파일 경로와 요약 5줄이 나온다.

```
bash tools/measure/collect.sh --label "STUB 맥"
```

기대 출력(요약, 숫자는 매번 조금 다름):

```
tools/measure/out/measure-20261031T173821Z-6768073f.json
이전 6768073f aws→gcp 상태=completed
STUB 단계: sync.shifting, cutover.rollback_window, cleanup.completed (판단 근거 audit_events.detail.stub)
전체 7788ms, 컷오버 멈춤 850ms, 롤백 멈춤 없음, 복제 지연 최대 120ms
비용 AWS 233.3 / GCP 146.9 / 절약 86.4 (GCP 단가 seed)
보안 표: API 없음(Z18 통합 전)
```

- 850ms는 STUB가 넣은 가짜 값이다. 그래서 다음 단계에서 문서에 안 들어간다.

문서가 어떻게 바뀔지 본다. STUB 값은 빼고 계산하므로 "바뀌는 줄 0개"가 정상이다.

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json
```

도구가 바꾸는 모습을 보고 싶으면 STUB 값도 넣어 본다. 표시는 `【추정, STUB 시험】`으로 붙는다. 파일은 안 건드린다.

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json --allow-stub
```

## 3. 실제 클라우드 이전 뒤 (맥)

`.env`의 `REPL_SOURCE_URL`·`REPL_TARGET_URL`이 실제 RDS·Cloud SQL을 가리키는 상태에서 이전을 돌린 뒤 한다.

이전 번호를 넣어 모은다. `--label`에는 조건을 적는다. 이 글자가 문서의 출처 표시에 그대로 들어간다.

```
bash tools/measure/collect.sh <이전번호> --label "AWS RDS → GCP Cloud SQL, 서울"
```

롤백 숫자도 원하면 이전을 한 건 더 돌리고, 되돌림 기간에 웹의 롤백 버튼(또는 아래 명령)을 누른 뒤 그 이전도 모은다.

```
curl -s -X POST -H "x-dev-tenant: 11111111-1111-4111-8111-111111111111" -H "content-type: application/json" -d '{"reason":"측정"}' http://localhost:3000/api/v1/migrations/<이전번호>/rollback
```

```
bash tools/measure/collect.sh <롤백한 이전번호> --label "AWS RDS → GCP Cloud SQL, 서울"
```

- 되돌림 기간이 3초면 누를 틈이 없다. 워커를 `ROLLBACK_WINDOW_SEC=20`으로 켠다.
- 같은 조건으로 3~5번 모으면 도구가 "중앙값 Xms (a~bms, n회)"로 쓴다. 1번이면 "Xms (1회)".

## 4. 문서 바꾸기

대상 문서 정하기:

- 레포에 합쳐진 뒤: 아무것도 안 주면 `docs/`의 TALK-SCRIPT, JUDGE-QA, DEMO-STORYBOARD-5MIN, DEMO-STORYBOARD, GLOSSARY, RUNBOOK-FINALS를 본다.
- 공유 폴더 판으로: `--parallel <parallel 폴더>`. Z26·Z29·Z28·Z16·Z37(DESIGN-FINALS)·Z42(MOCK-QA-50)를 보고, Z33이 같은 이름 문서를 냈으면 Z33 판을 쓴다. 런북은 Z33 판, 없으면 Z8 판.
- 직접: `--docs a.md b.md`.

차이만 본다 (기본, 파일 안 건드림).

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json --docs docs/archive/TALK-SCRIPT.md docs/archive/JUDGE-QA.md
```

무대 대표 숫자(41ms·44ms·4,338건·"같은 호스트 Postgres 두 대")까지 클라우드 값으로 바꾼다.

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json --headline cloud
```

- 부하 쓰기 건수까지 바꾸려면 collect 때 `--set writes_total=5120 --set writes_failed=0 --set writers=8`처럼 넣는다(숫자는 예시).

바꾼 사본을 따로 쓴다. 원본은 그대로, 사본은 `tools/measure/out/docs/`에 생긴다.

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json --headline cloud --write
```

원본을 직접 고친다. 원본 옆에 `.bak`가 하나 남는다.

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json --headline cloud --in-place
```

### 출력 읽는 법

```
=== docs/archive/JUDGE-QA.md  (바뀌는 줄 8)
@@ 77줄  [cloud:unmeasured-qa]
- 【미확인】 실제 RDS → Cloud SQL(리전 간 네트워크)에서는 아직 안 쟀다. …
+ 【사실, 실측 2026-11-01 AWS EKS → GCP GKE, 서울】 실제 클라우드(…)에서 잰 컷오버 쓰기 멈춤은 …
-- 아직 옛 수치가 남은 줄 3개 (조건이 다른 실측이거나 규칙 밖. 사람이 본다)
```

- `[…]` 안은 그 줄을 바꾼 규칙 이름이다.
- "아직 옛 수치가 남은 줄"은 규칙이 일부러 안 건드린 줄이다. 대부분 조건이 다른 실측(같은 호스트 41ms)이거나 예시 문장이다. 한 줄씩 보고 손으로 정한다.
- "[가격 확인됨: …]"이 붙은 줄은 숫자는 바꿨지만 "샘플·미확인" 같은 말이 같은 줄에 남은 줄이다. 문장을 손으로 고친다.

## 5. 무엇을 언제 바꾸나 (규칙 요약)

| 규칙 | 기본 | `--headline cloud` | 조건 |
|---|---|---|---|
| 비용 $233.3·$146.9·$219.9·$86.4·$73·$13.4·$250, 크레딧 비율, 190·911 rps | 바꿈 | 바꿈 | 값이 달라졌을 때만. 표시는 안 건드림 |
| "클라우드 사이는 안 쟀다【미확인】" 자리 | 실측으로 채움 | 채움 | 컷오버 값이 STUB가 아닐 때 |
| 보안 표 건수(지켜짐·약점·위반·미구현) | 바꿈 | 바꿈 | 이전 전체에 STUB 단계가 없을 때 |
| 컷오버 41ms(39~46, 5회)·롤백 44ms(41~52, 5회) | 안 바꿈 | 바꿈 + 출처 표시 교체 | STUB 아닐 때 |
| "같은 호스트 Postgres 두 대" | 안 바꿈 | `--label`로 바꿈 | |
| 쓰기 4,338건·"쓰기 8개 계속" | 안 바꿈 | `--set` 값이 있으면 바꿈 | |
| 새로고침 0.7초 | `--set refresh_s` 있을 때만 | 같음 | 0.7초는 코드 상수라 실측 아님 |

## 핵심 결정 3개

1. **기본은 무대 대표 숫자를 안 바꾼다.** 대안: 41ms·44ms를 바로 클라우드 값으로 덮기. 버린 이유: 41ms는 STUB가 아니라 "같은 호스트 Postgres 두 대, 쓰기 8개" 조건의 실측이다(W 2-2). 클라우드 1건과 조건이 달라 섞으면 틀린 문장이 된다. 바꿀지는 `--headline cloud`로 사람이 고른다. TODO(human): 5분판 대표 숫자를 클라우드 값으로 할지.
2. **STUB에서 나온 값은 문서에 안 들어간다.** 대안: 값만 보고 넣기. 버린 이유: STUB 컷오버 850ms가 문서에 들어가면 그대로 무대에서 말하게 된다. 판단 근거는 감사 기록 `detail.stub`이다.
3. **비용 문장의 "샘플·미확인" 표시는 자동으로 안 고친다.** 대안: 가격 출처가 live면 【미확인】을 【사실】로 바꾸기. 버린 이유: 시험해 보니 "GCP 단가가 샘플이라【미확인】이니"처럼 문장 뜻이 표시와 얽혀 있어, 표시만 바꾸면 거짓 문장이 됐다. 대신 그 줄을 따로 뽑아 사람이 고친다.

## 셀프 연습

STUB 측정 JSON 하나를 복사해서 `cutoverPauseMs`를 44로, `stubByValue.cutoverPauseMs`를 false로 바꾼 뒤 `--headline cloud`로 dry-run 해 본다. 컷오버 41ms가 44ms로 바뀐 줄을 롤백 규칙이 또 바꾸지 않는지(롤백 44ms와 섞이지 않는지) 확인한다.

## 검증 명령과 기대 출력

```
bash -n tools/measure/collect.sh && node --check tools/measure/apply-numbers.mjs && echo ok
```

기대: `ok`

```
node tools/measure/apply-numbers.mjs tools/measure/out/measure-*.json | tail -1
```

기대(STUB만 있을 때): `합계: 바뀌는 줄 0개. dry-run: 파일은 안 건드림 (--write 로 사본, --in-place 로 원본)`
