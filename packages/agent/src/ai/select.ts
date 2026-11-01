import { readFileSync } from "node:fs";
import type { LlmProvider } from "./llm.js";
import { scriptedLlm } from "./llm.js";
import { memorySandbox, type Sandbox, type SandboxMode, type WorkingCopy } from "./sandbox.js";
import { kubeClient, type KubeClient } from "./kube.js";
import { createK3dSandbox } from "./k3d-sandbox.js";
import { agentLlmStatusFromEnv, type AgentLlmStatus } from "@svc/contracts";
import { anthropicProvider, missingKeyLlm, type LlmCallLogger } from "../llm/anthropic.js";
import { llmCallOptionsFromEnv } from "../llm/select.js";

// 점검·수정(remediate) 경로의 LLM·샌드박스를 환경변수로 고른다. 키 값은 읽지 않고 "있는지"만 본다.
// 작업 Z90: LLM 기본 = 실제 Claude API (명세 초안과 같은 규칙, @svc/contracts agent-llm.ts)
//   FAKE_LLM=1         시험 전용 대본 LLM (정해진 도구 호출, 토큰 0). 화면에 가짜로 표시된다
//   ANTHROPIC_API_KEY  없으면 key_missing: 실행이 LLM_KEY_MISSING 으로 바로 실패 (가짜 결과 없음)
//   AGENT_MODEL        기본 claude-sonnet-5-5, claude-opus-5-5 로 바꿀 수 있다
//   AGENT_LLM_EFFORT / AGENT_LLM_TIMEOUT_MS / AGENT_LLM_MAX_RETRIES  ../llm/select.ts 와 같음
//   AGENT_LLM=real     예전 이름. 지금은 기본이라 없어도 된다. scripted 는 무시하고 경고만 (가짜는 FAKE_LLM=1)
//   SANDBOX_MODE       memory | k3d       (기본 memory. 맥에서 k3d)
//   SANDBOX_KUBE_URL   k3d 일 때 kube API (기본 http://127.0.0.1:8001 = kubectl proxy)
//   SANDBOX_KUBE_TOKEN_FILE / SANDBOX_KUBE_CA_FILE  (선택) proxy 대신 토큰으로 붙을 때 파일 경로
//   SANDBOX_NODE_PREFIX 오접속 방지 노드 접두어 (기본 k3d-agent-sbx-)
type Env = Record<string, string | undefined>;

export interface RemediateLlmChoice {
  llm: LlmProvider; mode: "scripted" | "real" | "key_missing"; model: string; why: string; warnings: string[]; status: AgentLlmStatus;
}
export function remediateLlmFromEnv(script: Array<{ name: string; input: unknown }>, env: Env = process.env,
  o: { onCall?: LlmCallLogger } = {}): RemediateLlmChoice {
  const status = agentLlmStatusFromEnv(env, { keyFlag: false });
  const base = { why: status.why, warnings: status.warnings, status };
  if (status.state === "fake") { const llm = scriptedLlm(script); return { ...base, llm, mode: "scripted", model: llm.model }; }
  const call = llmCallOptionsFromEnv(env);
  if (status.state === "key_missing") return { ...base, llm: missingKeyLlm(status.model), mode: "key_missing", model: status.model };
  // DRAFT(ai): 한 턴 출력 상한 8000. 도구 호출 위주라 길게 쓸 일이 없다
  return { ...base, llm: anthropicProvider({ model: status.model, ...call, maxTokens: 8000, onCall: o.onCall }), mode: "real", model: status.model };
}

export interface SandboxFactoryCtx { tenantId: string; runId: string; seed?: WorkingCopy }
export interface SandboxChoice { mode: SandboxMode; create(ctx: SandboxFactoryCtx): Promise<Sandbox>; describe: string }

export function sandboxFromEnv(env: Env = process.env, o: { kube?: KubeClient } = {}): SandboxChoice {
  const mode = env.SANDBOX_MODE?.trim() || "memory";
  if (mode !== "memory" && mode !== "k3d") throw new Error(`SANDBOX_MODE 값이 틀림: ${mode} (memory | k3d)`);
  if (mode === "memory") return { mode, describe: "memory (가짜 클러스터)", create: async () => memorySandbox() };
  const baseUrl = env.SANDBOX_KUBE_URL?.trim() || "http://127.0.0.1:8001";
  const kube = o.kube ?? kubeClient({
    baseUrl,
    token: env.SANDBOX_KUBE_TOKEN_FILE ? readFileSync(env.SANDBOX_KUBE_TOKEN_FILE, "utf8").trim() : undefined,
    ca: env.SANDBOX_KUBE_CA_FILE ? readFileSync(env.SANDBOX_KUBE_CA_FILE, "utf8") : undefined,
  });
  const nodePrefix = env.SANDBOX_NODE_PREFIX?.trim() || "k3d-agent-sbx-";
  return {
    mode, describe: `k3d (${baseUrl}, 노드 ${nodePrefix}*)`,
    create: (ctx) => createK3dSandbox({ kube, tenantId: ctx.tenantId, runId: ctx.runId, seed: ctx.seed, nodePrefix }),
  };
}
