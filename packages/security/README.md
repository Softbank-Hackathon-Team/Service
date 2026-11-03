# @svc/security (7번 보안·거버넌스)

상태: AI 초안 (팀 검토 전). 임시 역할 발급·회수는 진짜 요청 모양(STS·GCP·k8s) + Mock 발급기, 수집기는 STUB

| 항목 | 내용 |
|---|---|
| 목적 | 환경별 보안 결과를 매트릭스 칸으로 요약, 가드레일 판정, 출발·도착 이식성 판정(`evaluatePortability`), 그리고 고객 임시 역할을 최소 권한으로 발급·회수하고 감사에 남긴다 |
| 받는 것 | `Finding[]`, 환경·시각 / 출발·도착 `EnvFacts` + `SecurityRequirements` + 앱 env / `TempRoleRequest`(+`stage`), 환경 → 고객 역할 연결(`resolveEnv`), `infra/permissions/` 최소 권한 파일 |
| 넘기는 것 | `MatrixCell[]`, `GuardrailEvent`, `PortabilityResult`(막기·경고·선언 요청·추천), `TempCredential`(값이 아니라 `credentialRef`), 회수 결과 `{ operateRoleRevoked }`(T27 증거) |
| 부작용 | 발급기 호출(STS AssumeRole / IAM Credentials generateAccessToken / k8s TokenRequest), 프로세스 메모리 보관함, 감사 콜백(`temp_role.issued / denied / revoked / expired / issue_failed`) |
| 실패 코드 (403) | `ROLE_NO_CEILING`(권한 파일 없이 실행 역할), `ROLE_WILDCARD`, `ROLE_OBSERVE_WRITE`, `ROLE_OPERATE_NO_MIGRATION`, `ROLE_OPERATE_EMPTY`, `ROLE_AZURE_MOCK`, `ROLE_OPERATE_NO_STAGE`, `ROLE_OUTSIDE_CEILING`, `ROLE_POLICY_TOO_LARGE`, `ROLE_NO_ISSUER` / 404 `CREDENTIAL_NOT_FOUND` |

## 이식성 판정 (`src/portability`)

계획 단계에서 출발·도착 환경의 보안 사실(`EnvFacts`)과 앱 요구사항을 맞대어 승인 화면에 띄울 판정을 낸다. 순수 함수다.

- 규칙표는 `rules.ts` 의 `PORTABILITY_RULES` (번호는 보안 영역 설계 문서의 P-*·G-* 와 같다). 판정 단계는 `block`(승인 불가) / `warn`(위험 수용 체크 필요) / `attest`(고객 선언 필요) / `advise`(추천만)
- 모름(`unknown`)은 통과가 아니다. 클라우드는 `warn`, 온프레는 API 가 없어 `attest` 로 바꾼다
- Z95 보안 회귀(같은 열쇠가 pass→fail)가 잡는 "출발보다 나빠짐"은 다시 세지 않는다. 여기는 값(국가·키 소유·확장 목록)과 요구사항이 있어야 판정되는 것을 본다
- IR v2 (`v2.ts` `evaluatePortabilityV2`): 규칙마다 `scope` 가 있다. `env` 규칙은 한 번, `db` 규칙(도착 DB 를 읽는 것)은 도착 postgres 컴포넌트마다 돌리고, 같은 컴포넌트 id 의 출발 DB(`sourceDbs`)와 짝짓는다. 판정에 `componentId` 가 붙는다
- 사전 점검 변환 (`precheck.ts` `toSecurityPrecheckItems`): id `SEC:<규칙>:<컴포넌트|env>`. block→block, warn→warn, attest→warn("고객 확인"), advise→info. 클라우드 모름 경고는 쪽마다 `SEC:UNKNOWN:<source|target>` 한 항목으로 묶는다
- 연결: IR v2 `security` 칸(`SecuritySpecV2`), 출발 사실(`SourceDbFacts`, 가져오기), 도착 사실표(`adapters` `target/security-facts.ts`), 워커 `apps/worker/src/jobs/precheck.ts` `securityPrecheckFor`. 깃발 `SEC_PRECHECK=1` + `PLAN_IR=v2` 일 때만 켜진다 (기본 꺼짐)

## 임시 역할 흐름

1. `checkLeastPrivilege` (와일드카드·관찰 역할 쓰기 금지 등, D 단계 그대로)
2. 천장 검사: AWS 는 단계별 세션 정책(`aws-session-policy-<stage>.json`)이 실행 역할 정책(`aws-operate-role-policy.json`) 안인지 + 요청 동작이 세션 정책 안인지. GCP 는 커스텀 역할, 온프레는 ClusterRole 안인지
3. 발급: AWS `AssumeRole`(ExternalId, 세션 정책, 태그, SourceIdentity, 최소 900초), GCP `generateAccessToken`(최대 3600초), 온프레 TokenRequest(최소 600초). 최소값 때문에 늘어나면 `ttlAdjustedSec`
4. 값은 `CredentialVault`(메모리, JSON·inspect 시 `[redacted]`)에만. 다른 회사 참조는 404
5. 회수: 보관함 삭제 + 장부 revoked + 만료 대기. 실행 역할은 15분(900초)까지만 준다. AWS 고객 역할은 건드리지 않는다(고객 역할에 iam:PutRolePolicy 를 주면 권한 상승, 위협 모델 T-ROLE-9). GCP `hard: true` 는 oauth2 revoke, 토큰은 본문으로(【미확인】 효과)
6. 장부(`ledger.ts`, 워커는 DB 표 `temp_credentials`): 값 없이 참조·만료·상태·주인 워커. 다른 워커가 쥔 자격은 "회수 요청"만 남기고, 주인이 `sweep()` 때 지운다. T27 증거(`operateRoleRevoked`)는 장부로 세고, 메모리 장부(durable=false)면 참을 내지 않는다
7. 꺼내기(`use(ref, tenantId, migrationId)`): 실행 역할은 같은 이전 번호여야 한다(T-ROLE-7). 다른 회사·다른 이전은 404

## 위협 모델 대응 (parallel/U THREAT-MODEL 1.3)

| ID | 대응 | 시험 |
|---|---|---|
| T-ROLE-6 | 권한 파일 없으면 실행 역할 `ROLE_NO_CEILING`. 워커가 `infra/permissions` 를 읽어 넘긴다 | broker-j2, broker-threat |
| T-ROLE-7 | `use()` 가 이전 번호까지 확인 | broker-j2, broker-threat |
| T-ROLE-8 | DB 장부 + 회수 요청/주인 청소 | broker-j2, broker-threat, apps/worker temp-cred-ledger.db |
| T-ROLE-9 | 고객 역할 정책 바꾸는 경로 없음, 실행 역할 15분 | broker-j2 |
| T-ROLE-10 | GCP 회수 토큰을 본문으로 | broker-j2 |

```bash
npm run typecheck && node --import tsx --test packages/security/test/*.test.ts   # 기대: pass 25, fail 0, todo 0
```
