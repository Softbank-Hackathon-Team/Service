# agent-worker

상태: AI 초안 (팀 검토 전)

AI 에이전트와 샌드박스 리허설을 돌리는 별도 프로그램. `agent-run`·`sandbox-rehearsal` 큐를 받는다. 클라우드 실행 권한을 주지 않는다.
실행 한 건의 종류(`agent_runs.kind`)에 따라 처리기 둘로 나눈다.

| 항목 | spec_draft (명세 초안) | remediate (장애 분석) |
|---|---|---|
| 목적 | 가져오기 결과로 AppSpec 초안 + 이전 위험 요약 + 계획 설명 만들기 | 샌드박스에서 점검·수정 제안 |
| 받는 것 | 큐 작업 `AgentRunJob {tenantId, requestId, agentRunId}` → DB에서 이전·명세 v1·계획서를 다시 읽음 | 같음 |
| 넘기는 것 | `spec_versions` 다음 판(fieldMeta `_draft` = DRAFT(ai) 표시), `agent_runs.result` {version, risks, planExplanation, rejectedChanges} | `AgentFinish` + 게이트 결과 |
| 부작용 | DB 쓰기: spec_versions INSERT, agent_runs UPDATE, agent_steps INSERT, audit_events(actor `ai_agent`). 상태(advance)는 안 바꿈 | DB 쓰기: agent_runs UPDATE(queued→running→finished/failed), agent_steps INSERT, audit_events(`agent.remediate`, actor `ai_agent`) (Z65). 상태(advance)는 안 바꿈 |
| LLM | `llmFromEnv()` — 키 있으면 Anthropic, 없으면 가짜 공급자 | 대본 LLM (토큰 안 씀) |
| 실패 | LLM 실패·거부·예산 초과는 `agent_runs.status=failed` + reason, 감사 기록 error. 두 번 온 작업은 건너뜀 | 같음 |

## sandbox-rehearsal 큐 (vCluster 리허설)

LLM 을 쓰지 않는 결정 코드다. deploying 안, GitOps 커밋 바로 앞에서 워커가 넣은 리허설 한 건을 돌린다.

| 항목 | 내용 |
|---|---|
| 목적 | 커밋할 렌더 결과(원본)와 치환본을 일회용 vCluster 에 올려 보고 `RehearsalResult` 를 쓴다 |
| 받는 것 | 큐 작업 `SandboxRunJob {tenantId, requestId, sandboxRunId}` → `sandbox_runs` 줄(회사 벽 안)과 그 `input`(`RehearsalInput`) |
| 넘기는 것 | `sandbox_runs` queued → running(phase creating·applying·checking·deleting) → passed·failed·error + `result`·`failure_code`·`deleted_at`, phase done |
| 부작용 | 플랫폼 클러스터 `sbx-rehearsal-<번호>` 네임스페이스·helm 릴리스(끝나면 지움), 감사 `sandbox.rehearsal`(actor `agent_worker`), 기다리는 deploy 작업 깨우기(core `wakeQueued`). 이전 상태(advance)는 안 바꿈 |
| 백엔드 | `MOCK_SANDBOX=1` 이면 정해진 결과(`MOCK_SANDBOX_RESULT=fail` = `REHEARSAL_CRASHLOOP`). 그 밖은 `SANDBOX_KUBE_URL` 또는 클러스터 안 서비스 계정. 둘 다 없으면 `REHEARSAL_SANDBOX_UNAVAILABLE` |
| 실패 | `RehearsalFailureCode` (contracts). 입력이 계약에 안 맞거나 처리기가 던지면 결과 없이 `REHEARSAL_SANDBOX_UNAVAILABLE`. 두 번 온 작업·기한 지난 줄·워커가 먼저 닫은 줄은 건너뜀 |

- `src/handle-rehearsal.ts` 큐 처리기, `src/pg-sandbox-run-store.ts` 저장소, `src/sweeper.ts` 만료 샌드박스 청소(#177, 시작 때 + 5분마다)
- 리허설 순서와 판정은 `packages/agent/src/rehearsal/run.ts`, vCluster 만들기·지우기는 `packages/agent/src/ai/vcluster.ts`
- 차트·CRD 는 `vendor/` (이미지 `/app/vendor`). 로컬 kind 로 끝까지 돌리기: `scripts/rehearse-kind.ts`

- `src/pg-agent-run-store.ts` 장애 분석 Postgres 저장소 (Z65). `AGENT_REMEDIATE_STORE=memory` 면 메모리 저장소. 시작은 `POST /api/v1/migrations/:id/agent-review/run` (개발 도구 `tools/agent-remediate.ts`)
- `src/route.ts` 큐 한 건을 kind 로 나눈다. `agent_runs` 표가 없으면 예전처럼 remediate 로 간다
- `src/handle-spec-draft.ts` 명세 초안 처리기 + 메모리 저장소
- `src/pg-spec-draft-store.ts` Postgres 저장소 (표: `db/migrations/0006_agent_runs.sql`)
- `src/handle-agent-run.ts` 장애 분석 처리기 (D, 손대지 않음)
- STUB: discover 를 agent-worker 가 다시 부른다 (지금 어댑터 discover 는 데모 원본). TODO(human): import 가 가린 원본을 표에 남기고 그걸 읽게
- TODO(human): DB 역할 `app_agent`, 기본 모델 확정 (지금 DRAFT(ai) sonnet-5-5, 실측: `scripts/bench-spec-draft.ts`)

```bash
npm run typecheck -w @svc/agent-worker && npm test -w @svc/agent-worker   # 기대: pass 5, fail 0
npm run test:db                                                           # 기대: spec-draft.db 2개 포함 전부 통과
npm run start -w @svc/agent-worker   # 기대 첫 줄: "agent-worker LLM: mock (mock-draft) — ANTHROPIC_API_KEY 없음"
```
