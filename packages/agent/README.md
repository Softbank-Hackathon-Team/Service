# @svc/agent (온프레 k3s Agent 보고 + 8번 AI 에이전트 루프 + 명세 초안 에이전트)

상태: AI 초안 (팀 검토 전)

이름이 같은 "에이전트"가 둘이라 폴더로 나눴다. `src/onprem/`은 고객 온프레 k3s 안에서 도는 Agent의 보고, `src/ai/`는 LLM 에이전트 루프다.
DRAFT(ai): 나중에 `@svc/onprem-agent`와 `@svc/agent`로 쪼갤지 팀이 정한다.

| 항목 | 온프레 Agent 보고 (`onprem/`) | AI 에이전트 루프 (`ai/`) |
|---|---|---|
| 목적 | 온프레에서 안→밖으로 보낸 보고를 검사해 회사·환경을 붙인다 | 샌드박스 안에서 도구 7개로 점검·수정하고 `finish`로 제안만 넘긴다 |
| 받는 것 | HTTP 헤더(키 번호, 서명, 시각) + 본문 `AgentReport`(security / deploy / heartbeat) | 작업 설명, 작업 복사본, `LlmProvider`, `Sandbox`, 예산 |
| 넘기는 것 | `{tenantId, envId, report}`, `toDeployResult()` → `DeployResult` | `RunResult` (`AgentFinish`, 단계 기록, 바뀐 파일), `gateChanges()` 결과 |
| 부작용 | 없음 (키 저장소는 주입, STUB은 메모리) | 없음 (LLM·샌드박스 주입, STUB은 대본 LLM·메모리 샌드박스) |
| 실패 코드 | 401 `AGENT_AUTH_MISSING`, `AGENT_KEY_UNKNOWN`, `AGENT_TS_SKEW`, `AGENT_BAD_SIGNATURE` / 400 `AGENT_BAD_JSON`, `AGENT_BAD_SHAPE` | 실행 실패는 예외가 아니라 `state: "failed"` + 이유(예산 초과, finish 없음, 모델 거부) |

- 서명: HMAC-SHA256(secret, "시각.본문"), 시계 차이 5분. 본문에 `tenantId`를 넣으면 strict 검사에서 거부
- 도구 7개: sandbox_get, sandbox_logs, sandbox_apply, repo_read, repo_edit, run_check, finish. PR 만들기는 도구가 아니다
- 게이트는 STUB(줄 단위 4개 규칙). 설계 v1의 GATE-01~12(YAML 경로 비교)로 바꿀 자리

api에 붙이는 예 (통합 쪽에서, `POST /agent/reports`는 Agent 키 인증이라 회사 헤더 인증을 타지 않게 한다):
```ts
const r = await acceptAgentReport(
  { keyId: req.headers["x-agent-key-id"], signature: req.headers["x-agent-signature"], timestamp: req.headers["x-agent-timestamp"] },
  rawBody, keyRegistry, new Date());
```

```bash
npm run typecheck -w @svc/agent && npm test -w @svc/agent   # 기대: pass 16, fail 0
```

## 명세 초안 에이전트 (`src/draft/`, `src/llm/`)

가져오기(import)가 규칙으로 만든 명세 v1과 discover 원본을 LLM에게 보여 주고, 사람이 검토할 초안을 받는다.

| 항목 | 내용 |
|---|---|
| 목적 | AppSpec 초안 + 이전 위험 요약 + 이전 계획 설명(한국어 평문) |
| 받는 것 | `SpecDraftInput` {migrationId, source, target(provider, region, capabilities), inventory(RawInventory), baseline(v, spec, fieldMeta), plan 요약 또는 null}, `LlmProvider` |
| 넘기는 것 | `SpecDraftResult` {spec(AppSpec), fieldMeta(+`_draft`), risks(규칙 RISK-xx + AI-xx), planExplanation, rejectedChanges, model, usage} |
| 부작용 | 없음. 도구 8개 모두 메모리 입력만 읽는다 (클라우드·DB·네트워크 0). 저장은 agent-worker |
| 실패 | 예외 대신 `state: "failed"` + 이유: `모델 거부 (refusal)`, `LLM 호출 실패: LLM_AUTH 등`, `예산 초과: …`, `submit_draft 없이 종료`, `명세 초안이 3번 모양 검사 실패` |

- 도구: inventory_list, inventory_get(비밀처럼 보이는 값 가림), baseline_get, target_get, risk_rules, plan_get, validate_spec, submit_draft(끝내기)
- 가드(`guardDraft`): 이미지·환경변수·비밀 참조·호스트 이름과 v1에서 확실했던 칸(confidence 1)은 바꿔도 되돌린다. 원본에 없는 DB를 지어내면 지운다. 바뀐 칸은 출처 `ai:<모델>`, 믿음 0.6, 검토 필요
- 규칙 위험 10개(`ruleRisks`)는 에이전트가 지울 수 없다. 에이전트 위험은 최대 10개 덧붙음
- 예산 DRAFT(ai): 단계 12 / 도구 호출 24 / 300초 / 토큰 20만 / 모양 실패 3번

LLM 공급자 (`llmFromEnv`, 키 값은 SDK가 직접 읽고 이 코드는 "있는지"만 본다)

| 환경변수 | 뜻 | 기본 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 키. `.env` 에만 (커밋 금지) | 없음 → 가짜 공급자 |
| `AGENT_LLM_PROVIDER` | `anthropic` \| `mock` | 키 있으면 anthropic |
| `AGENT_MODEL` | 모델 id (예전 이름 `AGENT_LLM_MODEL` 도 읽음) | `claude-sonnet-5-5` (DRAFT(ai)), `claude-opus-5-5` 선택 가능 |
| `AGENT_LLM_EFFORT` | `low`~`max` | `medium` |

- Anthropic 호출: `client.beta.messages.create`, thinking 생략(적응형, 두 모델 모두 끌 수 없음), `output_config.effort`, 거부 대체 `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), 비스트리밍 max_tokens 16000, SDK 재시도 2회, 2분 시간 제한. 응답의 thinking 블록은 `raw` 로 다음 요청에 그대로 돌려보낸다
