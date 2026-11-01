# agent-worker

상태: AI 초안 (팀 검토 전)

AI 에이전트를 돌리는 별도 프로그램. `agent-run` 큐만 받는다. 클라우드 실행 권한을 주지 않는다.
실행 한 건의 종류(`agent_runs.kind`)에 따라 처리기 둘로 나눈다.

| 항목 | spec_draft (명세 초안) | remediate (장애 분석) |
|---|---|---|
| 목적 | 가져오기 결과로 AppSpec 초안 + 이전 위험 요약 + 계획 설명 만들기 | 샌드박스에서 점검·수정 제안 |
| 받는 것 | 큐 작업 `AgentRunJob {tenantId, requestId, agentRunId}` → DB에서 이전·명세 v1·계획서를 다시 읽음 | 같음 |
| 넘기는 것 | `spec_versions` 다음 판(fieldMeta `_draft` = DRAFT(ai) 표시), `agent_runs.result` {version, risks, planExplanation, rejectedChanges} | `AgentFinish` + 게이트 결과 |
| 부작용 | DB 쓰기: spec_versions INSERT, agent_runs UPDATE, agent_steps INSERT, audit_events(actor `ai_agent`). 상태(advance)는 안 바꿈 | DB 쓰기: agent_runs UPDATE(queued→running→finished/failed), agent_steps INSERT, audit_events(`agent.remediate`, actor `ai_agent`) (Z65). 상태(advance)는 안 바꿈 |
| LLM | `llmFromEnv()` — 키 있으면 Anthropic, 없으면 가짜 공급자 | 대본 LLM (토큰 안 씀) |
| 실패 | LLM 실패·거부·예산 초과는 `agent_runs.status=failed` + reason, 감사 기록 error. 두 번 온 작업은 건너뜀 | 같음 |

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
