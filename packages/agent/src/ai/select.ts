import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseAllDocuments } from "yaml";
import type { LlmProvider } from "./llm.js";
import { scriptedLlm } from "./llm.js";
import { memorySandbox, noSandbox, type Sandbox, type WorkingCopy } from "./sandbox.js";
import { asHostKube, kubeClient, KubeError, type HostKube, type KubeClient } from "./kube.js";
import { createK3dSandbox } from "./k3d-sandbox.js";
import {
  createVcluster, expiredSandbox, helmRunner, hostKubeconfig, kubectlPortForward, leftoverRehearsal, sweepSandboxes, type VclusterHost,
} from "./vcluster.js";
import {
  agentLlmStatusFromEnv, sandboxIsolation, sandboxSettings, SandboxMode,
  type AgentLlmStatus, type RehearsalInput, type RehearsalResult,
} from "@svc/contracts";
import { runRehearsal, type RehearsalRun } from "../rehearsal/run.js";
import { mockRehearsalResult } from "../rehearsal/mock.js";
import { anthropicProvider, missingKeyLlm, type LlmCallLogger } from "../llm/anthropic.js";
import { llmCallOptionsFromEnv } from "../llm/select.js";

// 점검·수정(remediate) 경로의 LLM·샌드박스를 환경변수로 고른다. 키 값은 읽지 않고 "있는지"만 본다.
// 작업 Z90: LLM 기본 = 실제 Claude API (명세 초안과 같은 규칙, @svc/contracts agent-llm.ts)
//   FAKE_LLM=1         시험 전용 대본 LLM (정해진 도구 호출, 토큰 0). 화면에 가짜로 표시된다
//   ANTHROPIC_API_KEY  없으면 key_missing: 실행이 LLM_KEY_MISSING 으로 바로 실패 (가짜 결과 없음)
//   AGENT_MODEL        기본 claude-sonnet-5-5, claude-opus-5-5 로 바꿀 수 있다
//   AGENT_LLM_EFFORT / AGENT_LLM_TIMEOUT_MS / AGENT_LLM_MAX_RETRIES  ../llm/select.ts 와 같음
//   AGENT_LLM=real     예전 이름. 지금은 기본이라 없어도 된다. scripted 는 무시하고 경고만 (가짜는 FAKE_LLM=1)
//   SANDBOX_MODE       memory | k3d | vcluster  (기본 memory. 맥에서 k3d, 플랫폼 EKS 에서 vcluster)
//                      memory 는 FAKE_LLM=1 때만 가짜 클러스터. 진짜 LLM 설정이면 샌드박스 없음 (noSandbox, 도구가 모두 거부됨)
//   SANDBOX_KUBE_URL   샌드박스 클러스터 kube API. k3d 기본 http://127.0.0.1:8001 (kubectl proxy).
//                      vcluster·리허설은 비면 클러스터 안 서비스 계정 (KUBERNETES_SERVICE_HOST + 토큰·CA 파일).
//                      값이 있으면 클러스터 밖 실행으로 보고 가상 API 는 kubectl port-forward 로 닿는다
//   SANDBOX_KUBE_TOKEN_FILE / SANDBOX_KUBE_CA_FILE  (선택) 토큰으로 붙을 때 파일 경로. 토큰 파일은 요청마다 다시 읽는다
//   SANDBOX_HELM_BIN   vcluster 차트를 올리는 helm (기본 PATH 의 helm)
//   SANDBOX_KUBECTL_BIN 클러스터 밖에서 port-forward 를 여는 kubectl (기본 PATH 의 kubectl)
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

// DRAFT(ai): 수정 고리 vCluster 상한. 리허설처럼 묶음에서 셈할 입력이 없어 kind 에서 잰 고정값 (파드 512Mi 둘 + 제어판)
const REMEDIATION_QUOTA = { requests: { cpuM: 1000, memoryMi: 1536 }, limitsMemoryMi: 3072, pods: 10, storageMi: 1024 };

export function sandboxFromEnv(env: Env = process.env, o: { kube?: KubeClient; host?: VclusterHost } = {}): SandboxChoice {
  const raw = env.SANDBOX_MODE?.trim() || "memory";
  const parsed = SandboxMode.safeParse(raw);
  if (!parsed.success) throw new Error(`SANDBOX_MODE 값이 틀림: ${raw} (${SandboxMode.options.join(" | ")})`);
  const mode = parsed.data;
  // memory 는 대본 LLM(FAKE_LLM=1) 전용. LLM 을 고르는 remediateLlmFromEnv 와 같은 env 로 가른다 (키 없음도 진짜 LLM 설정이다)
  if (mode === "memory") return agentLlmStatusFromEnv(env, { keyFlag: false }).state === "fake"
    ? { mode, describe: "memory (가짜 클러스터, FAKE_LLM 전용)", create: async () => memorySandbox() }
    : { mode, describe: "없음 (memory 는 진짜 LLM 에 주지 않음, 샌드박스 도구는 SANDBOX_NOT_CONFIGURED)", create: async () => noSandbox() };
  if (mode === "vcluster") {
    // 수정 고리를 vCluster 로: 실행마다 vCluster(restricted, SANDBOX_RUNTIME_CLASS) 하나, 그 안에 k3d 와 같은 일회용 네임스페이스.
    // LLM 도구를 조회 전용 kubeconfig(Vcluster.agent) 로 옮기는 일은 다음 단계 (수정 고리 vCluster PR)
    const host = o.host ?? vclusterHostFromEnv(env);
    if (!host) throw new Error("SANDBOX_MODE=vcluster: 호스트 클러스터 접속 설정이 없음 (SANDBOX_KUBE_URL 또는 클러스터 안 실행)");
    const s = sandboxSettings(env);
    return {
      mode, describe: `vcluster (${s.vclusterChart})`,
      create: async (ctx) => {
        const vc = await createVcluster(host, { kind: "remediation", runId: ctx.runId, tenantId: ctx.tenantId, isolation: sandboxIsolation("remediation", env),
          k8sMinor: "1.35", quota: REMEDIATION_QUOTA, images: [], ttlSec: s.ttlSec });
        try {
          const inner = await createK3dSandbox({ kube: vc.admin, tenantId: ctx.tenantId, runId: ctx.runId, seed: ctx.seed, nodePrefix: null, ttlSeconds: s.ttlSec });
          return { ...inner, mode: "vcluster" as const, namespace: vc.name, dispose: async () => { await inner.dispose().catch(() => {}); const r = await vc.dispose(); if (!r.deleted) throw new KubeError("SANDBOX_DELETE", r.detail); } };
        } catch (e) { await vc.dispose(); throw e; }
      },
    };
  }
  const baseUrl = env.SANDBOX_KUBE_URL?.trim() || "http://127.0.0.1:8001";
  const kube = o.kube ?? kubeClient({
    baseUrl,
    tokenFile: env.SANDBOX_KUBE_TOKEN_FILE?.trim() || undefined,
    ca: env.SANDBOX_KUBE_CA_FILE ? readFileSync(env.SANDBOX_KUBE_CA_FILE, "utf8") : undefined,
  });
  const nodePrefix = env.SANDBOX_NODE_PREFIX?.trim() || "k3d-agent-sbx-";
  return {
    mode, describe: `k3d (${baseUrl}, 노드 ${nodePrefix}*)`,
    create: (ctx) => createK3dSandbox({ kube, tenantId: ctx.tenantId, runId: ctx.runId, seed: ctx.seed, nodePrefix }),
  };
}

// ── vCluster 호스트 (플랫폼 클러스터, agent-worker 서비스 계정) ──
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
// outOfCluster: SANDBOX_KUBE_URL 을 준 실행 (플랫폼 클러스터 밖). 가상 API 의 서비스 주소에 못 닿는다
export interface HostAccess { kube: HostKube; server: string; caFile?: string; tokenFile?: string; outOfCluster: boolean }
// 접속 설정이 없으면 null (로컬 개발: 리허설은 MOCK_SANDBOX=1 로 돈다)
export function hostAccessFromEnv(env: Env = process.env): HostAccess | null {
  const explicit = env.SANDBOX_KUBE_URL?.trim();
  const svcHost = env.KUBERNETES_SERVICE_HOST?.trim();
  const server = explicit || (svcHost ? `https://${svcHost}:${env.KUBERNETES_SERVICE_PORT?.trim() || "443"}` : "");
  if (!server) return null;
  const tokenFile = env.SANDBOX_KUBE_TOKEN_FILE?.trim() || (explicit ? undefined : `${SA_DIR}/token`);
  const caFile = env.SANDBOX_KUBE_CA_FILE?.trim() || (explicit ? undefined : `${SA_DIR}/ca.crt`);
  const kube = asHostKube(kubeClient({ baseUrl: server, tokenFile, ca: caFile ? readFileSync(caFile, "utf8") : undefined, timeoutMs: 30_000 }));
  return { kube, server, caFile, tokenFile, outOfCluster: !!explicit };
}

// 자식 프로세스 env 에는 PATH 가 없으니 절대 경로로 찾아 둔다
const whichBin = (set: string | undefined, name: string) => {
  if (set?.trim()) return set.trim();
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(d, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* 다음 */ }
  }
  return name;
};

export function vclusterHostFromEnv(env: Env = process.env, o: Partial<Pick<VclusterHost, "connect" | "reach">> = {}): VclusterHost | null {
  const access = hostAccessFromEnv(env);
  if (!access) return null;
  const home = mkdtempSync(join(tmpdir(), "svc-sandbox-"));
  const workDir = join(home, "work");
  mkdirSync(workDir, { mode: 0o700 });
  const kubeconfig = join(home, "host.kubeconfig");
  writeFileSync(kubeconfig, hostKubeconfig(access), { mode: 0o600 });
  const reach = access.outOfCluster ? kubectlPortForward({ bin: whichBin(env.SANDBOX_KUBECTL_BIN, "kubectl"), kubeconfig, home }) : undefined;
  const st = sandboxSettings(env);
  return {
    kube: access.kube, helm: helmRunner({ bin: whichBin(env.SANDBOX_HELM_BIN, "helm"), kubeconfig, home }), chart: st.vclusterChart, workDir,
    // 동시 실행(SANDBOX_REHEARSAL_CONCURRENCY ≥ 2)이면 샌드박스마다 회사 전용 sandbox 노드 하나에 고정 (vcluster.ts pickSandboxNode)
    pinNodes: st.pinNodes, nodeWaitMs: st.nodeWaitSec * 1000,
    ...(reach ? { reach } : {}), ...o,
  };
}

// 이미지에 넣은 CRD (차트 묶음 옆 crds/). 원본의 ExternalSecret·CNPG Cluster 를 스키마로 dry-run 하려고 가상 클러스터에 넣는다
export function loadVendorCrds(dir: string): any[] {
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()
    .flatMap((f) => parseAllDocuments(readFileSync(join(dir, f), "utf8")).map((d) => d.toJS()).filter((x) => x?.kind === "CustomResourceDefinition"));
}

// ── 리허설 (sandbox-rehearsal 큐) ──
export interface RehearsalChoice {
  describe: string;
  host: VclusterHost | null;   // 진짜 백엔드일 때만. 만료 청소가 같은 호스트를 쓴다
  rehearse(input: RehearsalInput, run: RehearsalRun): Promise<RehearsalResult>;
}
export function rehearsalFromEnv(env: Env = process.env, o: { host?: VclusterHost | null } = {}): RehearsalChoice {
  const s = sandboxSettings(env);
  if (s.mockResult) {
    const outcome = s.mockResult;
    return { describe: `mock (${outcome})`, host: null, rehearse: async (input, run) => mockRehearsalResult(input, run.id, outcome) };
  }
  const host = o.host === undefined ? vclusterHostFromEnv(env) : o.host;
  // 호스트가 없어도 결과 모양은 같다: 샌드박스를 못 만들어 REHEARSAL_SANDBOX_UNAVAILABLE (조용히 통과하는 길 없음)
  const create = host
    ? (spec: Parameters<typeof createVcluster>[1]) => createVcluster(host, spec)
    : async () => { throw new KubeError("SANDBOX_NO_HOST", "호스트 클러스터 접속 설정이 없음 (SANDBOX_KUBE_URL 또는 클러스터 안 실행)"); };
  const crds = host ? loadVendorCrds(join(dirname(s.vclusterChart), "crds")) : [];
  return {
    describe: host ? `vcluster (${s.vclusterChart}, CRD ${crds.length}개)` : "없음 (호스트 클러스터 설정 없음)",
    host,
    rehearse: (input, run) => runRehearsal(input, run, {
      create, crds, ttlSec: s.ttlSec,
      // 동시 실행이면 남은 것 청소는 그 회사 것만 (다른 회사 리허설은 지금 도는 중일 수 있다)
      sweepLeftovers: host ? (keep, tenantId) => sweepSandboxes(host.kube, leftoverRehearsal(keep, host.pinNodes ? tenantId : undefined)) : async () => ({ deleted: [], failed: [] }),
    }),
  };
}
// 만료 라벨이 지난 샌드박스 네임스페이스 청소 한 번 (#177). agent-worker 가 시작 때와 주기로 부른다
export const sweepExpiredSandboxes = (kube: HostKube, nowMs: number = Date.now()) => sweepSandboxes(kube, expiredSandbox(Math.floor(nowMs / 1000)));
