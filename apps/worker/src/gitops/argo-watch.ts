import { execFile } from "node:child_process";
import { DELIVERY, argoAppName, type BundleRef } from "./bundle.js";
import type { CommitResult } from "./repo.js";
import type { SyncWatcher, SyncWatchResult } from "./index.js";
import { envNumber } from "@svc/contracts";

// Z94: 앱 배포 뒤 Argo CD 반영 확인 (T20 deploying → syncing 의 argoHealthy 증거).
// 커밋한 리비전이 Argo Application 에 Synced + Healthy 로 보일 때까지 실제로 읽는다.
// 읽는 길 두 가지 (ARGO_SOURCE, 기본 auto):
//   rest — Argo CD REST API  GET {ARGOCD_URL}/api/v1/applications/{name}  (Bearer ARGOCD_TOKEN)
//   k8s  — 허브 클러스터의 Application CR 을 kubectl 로 읽는다 (kubectl get applications.argoproj.io {name} -n argocd -o json)
//   auto — ARGOCD_URL+ARGOCD_TOKEN 이 있으면 rest, 없고 ARGO_KUBE_CONTEXT 가 있으면 k8s, 둘 다 없으면 ARGO_NOT_CONFIGURED
// 흉내(바로 ok)는 MOCK_ARGO=1 일 때만 (시험 전용). 예전처럼 "설정 없으면 조용히 ok" 는 없앴다 → 설정 빠짐이 paused 로 보인다.
// 구 이름(Z59) ARGOCD_SERVER / ARGOCD_AUTH_TOKEN 도 받는다 (argocd CLI 와 같은 이름).
// 온프레(agent-pull)는 Agent 보고(Z92), Azure Mock 은 Mock 실행기가 맡아 여기서 기다리지 않는다.

export interface ArgoAppStatus {
  sync?: { status?: string; revision?: string };
  health?: { status?: string; message?: string };
  operationState?: { phase?: string; message?: string; syncResult?: { revision?: string } };
  conditions?: Array<{ type?: string; message?: string }>;
}

/** 한 번 읽은 상태 → 끝/계속. 순수 함수 (시험 대상) */
export function judgeArgo(s: ArgoAppStatus, commit: string): { done: boolean; ok: boolean; reason?: string } {
  const mine = s.sync?.revision === commit;
  const op = s.operationState;
  if (op && (op.phase === "Failed" || op.phase === "Error") && (op.syncResult?.revision ?? commit) === commit) {
    return { done: true, ok: false, reason: `ARGO_SYNC_FAILED: ${(op.message ?? "").slice(0, 200)}` };
  }
  if (mine && s.health?.status === "Degraded") {
    return { done: true, ok: false, reason: `ARGO_DEGRADED: ${(s.health.message ?? "").slice(0, 200)}` };
  }
  if (mine && s.sync?.status === "Synced" && s.health?.status === "Healthy") return { done: true, ok: true };
  return { done: false, ok: false };
}

/** 한 번 읽기 결과. kind: ok=상태 받음, missing=Application 아직 없음, auth=권한 없음(다시 해도 같음), error=일시 오류 */
export type ArgoRead =
  | { kind: "ok"; status: ArgoAppStatus }
  | { kind: "missing"; detail: string }
  | { kind: "auth"; detail: string }
  | { kind: "error"; detail: string };

export interface ArgoReader { source: "rest" | "k8s"; read(name: string, first: boolean): Promise<ArgoRead> }

export function restReader(url: string, token: string, fetchImpl: typeof fetch, reqTimeoutMs: number): ArgoReader {
  const base = url.replace(/\/+$/, "");
  return {
    source: "rest",
    async read(name, first) {
      // refresh=normal 은 첫 번 한 번만: 매 틱마다 붙이면 Argo 가 매번 git 을 다시 본다 (repo-server 부하)
      const q = first ? "?refresh=normal" : "";
      try {
        const r = await fetchImpl(`${base}/api/v1/applications/${encodeURIComponent(name)}${q}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(reqTimeoutMs),
        });
        if (r.status === 401 || r.status === 403) return { kind: "auth", detail: `HTTP ${r.status}` };
        // Argo CD 는 권한 없는 앱도 403 대신 404 를 줄 수 있다. 시간 안에 계속 404 면 ARGO_APP_MISSING 으로 끝낸다
        if (r.status === 404) return { kind: "missing", detail: "HTTP 404" };
        if (!r.ok) return { kind: "error", detail: `HTTP ${r.status}` };
        const app = await r.json() as { status?: ArgoAppStatus };
        return { kind: "ok", status: app.status ?? {} };
      } catch (e) {
        return { kind: "error", detail: (e as Error).message.slice(0, 120) };
      }
    },
  };
}

export type KubectlRun = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const realKubectl: KubectlRun = (args, timeoutMs) => new Promise((res) => {
  execFile(process.env.KUBECTL_BIN || "kubectl", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
    res({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) });
  });
});

export function k8sReader(namespace: string, context: string | undefined, run: KubectlRun, reqTimeoutMs: number): ArgoReader {
  return {
    source: "k8s",
    async read(name, first) {
      const ctx = context ? ["--context", context] : [];
      // Z94b (Z103 지적): CR 읽기만으로는 refresh 가 안 걸려 새 커밋이 Argo git 주기(기본 약 180초) 뒤에야 보일 수 있다.
      // 첫 읽기 전에 REST 의 refresh=normal 과 같은 주석을 한 번 건다. 실패(아직 NotFound 등)해도 읽기는 계속
      if (first) await run([...ctx, "annotate", "applications.argoproj.io", name, "-n", namespace, "argocd.argoproj.io/refresh=normal", "--overwrite"], reqTimeoutMs);
      const args = [...ctx, "get", "applications.argoproj.io", name, "-n", namespace, "-o", "json"];
      const r = await run(args, reqTimeoutMs);
      if (r.code === 0) {
        try { return { kind: "ok", status: (JSON.parse(r.stdout) as { status?: ArgoAppStatus }).status ?? {} }; }
        catch { return { kind: "error", detail: "kubectl 출력이 JSON 이 아님" }; }
      }
      const msg = r.stderr.trim().slice(0, 160);
      if (/NotFound|not found/i.test(msg)) return { kind: "missing", detail: msg };
      if (/Forbidden|Unauthorized|forbidden/.test(msg)) return { kind: "auth", detail: msg };
      return { kind: "error", detail: msg || `kubectl exit ${r.code}` };
    },
  };
}

export const mockArgoWatcher: SyncWatcher = { wait: async () => ({ ok: true, observed: { source: "mock", polls: 0, ms: 0 } }) };

const notConfigured: SyncWatcher = {
  async wait(b) {
    if (DELIVERY[b.env] !== "argocd-push") return { ok: true };
    return { ok: false, reason: "ARGO_NOT_CONFIGURED: ARGOCD_URL+ARGOCD_TOKEN 또는 ARGO_KUBE_CONTEXT 가 .env 에 없다 (시험은 MOCK_ARGO=1)" };
  },
};

export interface ArgoDeps { fetchImpl?: typeof fetch; kubectl?: KubectlRun; sleep?: (ms: number) => Promise<void>; now?: () => number }

export function argoReaderFromEnv(env: NodeJS.ProcessEnv, d: ArgoDeps = {}): ArgoReader | null {
  const url = env.ARGOCD_URL || env.ARGOCD_SERVER;
  const token = env.ARGOCD_TOKEN || env.ARGOCD_AUTH_TOKEN;
  const ctx = env.ARGO_KUBE_CONTEXT || undefined;
  const src = (env.ARGO_SOURCE || "auto").toLowerCase();
  const reqMs = envNumber(env.ARGO_REQ_TIMEOUT_MS, 5000);
  const rest = url && token ? restReader(url, token, d.fetchImpl ?? fetch, reqMs) : null;
  const k8s = () => k8sReader(env.ARGOCD_NAMESPACE || "argocd", ctx, d.kubectl ?? realKubectl, reqMs);
  if (src === "rest") return rest;
  if (src === "k8s") return k8s();
  return rest ?? (ctx ? k8s() : null);
}

export function argoWatcherFromEnv(env: NodeJS.ProcessEnv = process.env, d: ArgoDeps | typeof fetch = {}): SyncWatcher {
  const deps: ArgoDeps = typeof d === "function" ? { fetchImpl: d } : d;   // Z59 시험 호환: 두 번째 인자가 fetch 면 그대로
  if (env.MOCK_ARGO === "1") return mockArgoWatcher;
  const reader = argoReaderFromEnv(env, deps);
  if (!reader) return notConfigured;
  const demo = env.DEMO_MODE === "1";
  const waitMs = envNumber(env.ARGO_WAIT_SEC, 180) * 1000;
  // DRAFT(ai): 틱 기본 2초, 데모 모드 1초 (Synced+Healthy 를 빨리 잡아 화면 단계가 덜 멈춰 보이게)
  const tickMs = envNumber(env.ARGO_TICK_MS, demo ? 1000 : 2000);
  const maxErrors = envNumber(env.ARGO_MAX_ERRORS, 10);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  return {
    async wait(b: BundleRef, c: CommitResult): Promise<SyncWatchResult> {
      if (DELIVERY[b.env] !== "argocd-push") return { ok: true };   // 온프레 Agent(Z92)·Azure Mock 은 여기서 안 기다림
      const name = argoAppName(b);
      const t0 = now();
      const end = t0 + waitMs;
      let last = "no response";
      let polls = 0;
      let errs = 0;           // 연속 일시 오류 수
      let missing = true;     // 지금까지 Application 을 한 번도 못 봤는지
      const obs = (extra: Partial<NonNullable<SyncWatchResult["observed"]>> = {}) =>
        ({ source: reader.source, app: name, polls, ms: now() - t0, last, ...extra });
      while (true) {
        const r = await reader.read(name, polls === 0);
        polls++;
        if (r.kind === "ok") {
          errs = 0; missing = false;
          const j = judgeArgo(r.status, c.commit);
          last = `${r.status.sync?.status ?? "?"}/${r.status.health?.status ?? "?"} @${(r.status.sync?.revision ?? "").slice(0, 8)}`;
          const cond = r.status.conditions?.find((x) => /Error$/.test(x.type ?? ""));
          if (cond) last += ` ${cond.type}: ${(cond.message ?? "").slice(0, 80)}`;
          if (j.done) return { ok: j.ok, ...(j.reason ? { reason: j.reason } : {}), observed: obs({ sync: r.status.sync?.status, health: r.status.health?.status, revision: r.status.sync?.revision }) };
        } else if (r.kind === "auth") {
          // 토큰·RBAC 문제는 기다려도 안 풀린다 → 바로 끝
          last = r.detail;
          return { ok: false, reason: `ARGO_AUTH_FAILED: ${r.detail}`, observed: obs() };
        } else if (r.kind === "missing") {
          errs = 0; last = r.detail;   // ApplicationSet 이 아직 Application 을 안 만들었을 수 있다 → 계속
        } else {
          errs++; last = r.detail;
          if (errs >= maxErrors) return { ok: false, reason: `ARGO_UNREACHABLE: 연속 ${errs}회 실패, last ${last}`, observed: obs() };
        }
        if (now() >= end) break;
        // 일시 오류가 이어지면 간격을 늘린다 (2배씩, 최대 10초)
        const back = errs > 0 ? Math.min(tickMs * 2 ** (errs - 1), 10_000) : tickMs;
        await sleep(Math.max(0, Math.min(back, end - now())));
      }
      const code = missing ? "ARGO_APP_MISSING" : "ARGO_TIMEOUT";
      return { ok: false, reason: `${code}: ${waitMs / 1000}s, last ${last}`, observed: obs() };
    },
  };
}
