import { agentLlmStatusFromEnv, envNumber, type ConfigService } from "@svc/contracts";
import { observeMinSec } from "./guards.js";
import { createLogger } from "./obs/log.js";

// Z81-10: 시작할 때 "실제로 쓰는 설정 값" 한 줄 (Z62 판단, Z78 rehearse·demo-day 가 이 줄을 grep). 동작 변화 0: 값을 읽기만 하고 아무것도 안 바꾼다.
// 왜: 6차 맥에서 TRAFFIC_OBSERVE_SEC 가 기본 30초로 돌아 e2e 가 깨졌는데, 로그 어디에도 "지금 30초로 돈다"가 없어 아무도 못 봤다.
// 한 줄 JSON: {"msg":"effective config","config":{"TRAFFIC_OBSERVE_SEC":{"value":30,"source":"default"},…}}
//   source = env(환경 변수 값을 씀) | default(비었거나 없음 → 코드 기본값) | invalid→default(틀린 값이라 기본값) | 그 밖 이유 글자
// 비밀값·주소는 안 찍는다: GitOps 는 켜짐/꺼짐과 이유만, LLM 은 공급자 이름과 "키 있음/없음"만
// 값을 정하는 규칙은 각 코드와 같아야 한다 → 시험이 진짜 함수(observeMinSec·rateLimitOptsFromEnv·llmFromEnv·configFromEnv)와 맞춰 본다
export interface EffectiveEntry { value: string | number; source: string; floorApplied?: boolean }
const blank = (v: string | undefined) => v === undefined || v.trim() === "";

export function effectiveConfig(env: NodeJS.ProcessEnv = process.env): Record<string, EffectiveEntry> {
  const obs = observeMinSec(env);
  const rawObs = env.TRAFFIC_OBSERVE_SEC;
  const obsOk = !blank(rawObs) && Number.isFinite(Number(rawObs)) && Number(rawObs) > 0;
  const obsSource = blank(rawObs) ? "default" : !obsOk ? "invalid→default"
    : env.PROM_URL && Number(rawObs) < 30 ? "env, PROM_URL 있어 최소 30" : "env";

  // Z90: 규칙은 @svc/contracts agentLlmStatusFromEnv 한 곳 (= @svc/agent llmFromEnv(env).provider). 이름 칸은 grep 호환으로 그대로 둔다
  //   값: anthropic(키 있음, 실제 API) | key_missing(키 없음, 실행 실패) | fake(FAKE_LLM=1 시험) | invalid(틀린 예전 값)
  let llm: string, llmSource: string;
  try {
    const st = agentLlmStatusFromEnv(env, { keyFlag: false });
    llm = st.state === "ready" ? "anthropic" : st.state;
    llmSource = st.state === "fake" ? "env(FAKE_LLM=1)" : st.state === "ready" ? "default(키 있음)" : "default(키 없음)";
    if (st.warnings.length) llmSource += `, 무시: ${st.warnings.length}개`;
  } catch { llm = "invalid"; llmSource = "env(틀린 AGENT_LLM_PROVIDER·AGENT_LLM)"; }

  const gitopsOff = env.GITOPS_DISABLE === "1" || (blank(env.GITOPS_REPO_DIR) && blank(env.GITOPS_REPO_URL));
  const gitopsSource = env.GITOPS_DISABLE === "1" ? "GITOPS_DISABLE=1" : gitopsOff ? "레포 설정 없음" : "레포 설정 있음";

  return {
    // Z81-11: floorApplied = PROM_URL 이 있어 guards.ts observeMinSec 가 값을 30 으로 올렸는가 (명시한 값이 있었는데 덮였는지 한눈에)
    TRAFFIC_OBSERVE_SEC: { value: obs, source: obsSource, floorApplied: Boolean(env.PROM_URL) && (obsOk ? Number(rawObs) : 30) < 30 },
    ROLLBACK_WINDOW_SEC: { value: envNumber(env.ROLLBACK_WINDOW_SEC, 120), source: blank(env.ROLLBACK_WINDOW_SEC) ? "default" : "env" },
    RATE_LIMIT: { value: env.RATE_LIMIT !== "0" ? "on" : "off", source: env.RATE_LIMIT === undefined ? "default" : "env" },
    AGENT_LLM_PROVIDER: { value: llm, source: llmSource },
    GITOPS: { value: gitopsOff ? "off" : "on", source: gitopsSource },
    // packages/traffic providers/index.ts 와 같은 규칙: 빈 값("")도 mock
    // Z81-11: 진짜 지표 주소가 있는지만 (주소는 안 찍음). 있으면 관찰 하한 30초가 걸린다
    //   guards.ts 와 같게 "글자가 하나라도 있으면 있음"(공백만 있어도 있음 → 하한이 걸린다)
    PROM_URL: { value: env.PROM_URL ? "set" : "unset", source: env.PROM_URL ? "env" : "default" },
    TRAFFIC_PROVIDER: { value: env.TRAFFIC_PROVIDER || "mock", source: env.TRAFFIC_PROVIDER ? "env" : "default" },
  };
}

// 시작할 때 한 번. assertConfig 바로 뒤에 부른다
export function logEffectiveConfig(service: ConfigService, env: NodeJS.ProcessEnv = process.env,
  write?: (line: string) => void): void {
  createLogger(service, { component: "config" }, write ? { write } : {}).info({ config: effectiveConfig(env) }, "effective config");
}
