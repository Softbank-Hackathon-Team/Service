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
  // ARGODEG: Application 이 관리하는 자원별 상태. Degraded 자원의 health.message 가 사유가 된다
  resources?: Array<{ kind?: string; name?: string; namespace?: string; status?: string; health?: { status?: string; message?: string } }>;
}

// ARGODEG DRAFT(ai): Argo 가 Application health.message 를 비워 두는 일이 많다(맥 실측 Z103) → 사유가 'ARGO_DEGRADED: ' 로 빔.
//   채우는 순서: ① Application health.message ② Application conditions(…Error 우선, 없으면 아무 조건) ③ resources[] 중 Degraded·Missing 자원의 health.message
//   ④ (k8s 길만) 그 Deployment 의 status.conditions(Available·Progressing)와 Pod 대기 이유(ImagePullBackOff 등) ⑤ 다 비면 고정 문구
export const DEGRADED_UNKNOWN = "이유를 못 읽음(Argo 메시지 없음)";

/** 사유 글에서 비밀값·이미지 자격 문구를 가린다 (화면·감사·로그에 그대로 나가므로) */
export function scrubReason(t: string): string {
  return t
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, (m) => `${m.split("://")[0]}://***@`)                       // URL 안 user:pass@
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, "$1 ***")                                                       // Authorization 값
    .replace(/\b(password|passwd|pwd|secret|token|apikey|api[_-]key|access[_-]?key|authorization|credentials?)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=***") // 키=값
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, "***")                                                                         // AWS 접근 키 ID
    .replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "***")                                       // JWT
    .replace(/\b\d{12}(?=\.dkr\.ecr|[:/])/g, "••••")                                                                         // ECR·ARN 의 계정 번호
    .replace(/\b\d{12}\b/g, (m) => `••••${m.slice(-4)}`)
    .replace(/(imagePullSecrets?|pull secret|docker-?registry)[^.;\n]*/gi, "$1 ***");                                         // 이미지 자격 문구
}
const clip = (t: string) => scrubReason(t.replace(/\s+/g, " ").trim()).slice(0, 200);

/** Application 상태만으로 만든 Degraded 사유 (순수). 못 찾으면 빈 문자열 */
export function degradedDetail(s: ArgoAppStatus): string {
  const m = s.health?.message?.trim();
  if (m) return clip(m);
  const conds = (s.conditions ?? []).filter((c) => c.message?.trim());
  const c = conds.find((x) => /Error$/.test(x.type ?? "")) ?? conds[0];
  if (c) return clip(`${c.type ?? "Condition"}: ${c.message}`);
  const bad = (s.resources ?? []).filter((r) => (r.health?.status === "Degraded" || r.health?.status === "Missing") && r.health.message?.trim());
  if (bad.length) { const r = bad[0]!; return clip(`${r.kind ?? "?"}/${r.name ?? "?"}: ${r.health!.message}`); }
  return "";
}

/** 한 번 읽은 상태 → 끝/계속. 순수 함수 (시험 대상) */
export function judgeArgo(s: ArgoAppStatus, commit: string): { done: boolean; ok: boolean; reason?: string; emptyDetail?: boolean } {
  const mine = s.sync?.revision === commit;
  const op = s.operationState;
  if (op && (op.phase === "Failed" || op.phase === "Error") && (op.syncResult?.revision ?? commit) === commit) {
    return { done: true, ok: false, reason: `ARGO_SYNC_FAILED: ${(op.message ?? "").slice(0, 200)}` };
  }
  if (mine && s.health?.status === "Degraded") {
    const d = degradedDetail(s);
    return { done: true, ok: false, reason: `ARGO_DEGRADED: ${d || DEGRADED_UNKNOWN}`, ...(d ? {} : { emptyDetail: true }) };
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

/** diagnose: Application 만으로 사유를 못 얻었을 때 한 번 더 읽는 길(k8s 길만). 못 읽으면 빈 문자열 */
export interface ArgoReader { source: "rest" | "k8s"; read(name: string, first: boolean): Promise<ArgoRead>; diagnose?(status: ArgoAppStatus): Promise<string> }

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

interface DeploymentJson {
  spec?: { selector?: { matchLabels?: Record<string, string> } };
  status?: { conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
}
interface PodsJson { items?: Array<{ status?: { containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }> } }> }

export function k8sReader(namespace: string, context: string | undefined, run: KubectlRun, reqTimeoutMs: number): ArgoReader {
  return {
    source: "k8s",
    // ARGODEG ④: Degraded Deployment 의 conditions(Available·Progressing 중 문제 있는 것) + Pod 대기 이유(ImagePullBackOff·CrashLoopBackOff 등). 한 Deployment 만 (첫 Degraded)
    async diagnose(status) {
      const ctx = context ? ["--context", context] : [];
      const dep = (status.resources ?? []).find((r) => r.kind === "Deployment" && r.health?.status !== "Healthy" && r.name);
      if (!dep) return "";
      const ns = dep.namespace ?? namespace, parts: string[] = [];
      const d = await run([...ctx, "get", "deployment", dep.name!, "-n", ns, "-o", "json"], reqTimeoutMs);
      let dj: DeploymentJson | null = null;
      if (d.code === 0) { try { dj = JSON.parse(d.stdout) as DeploymentJson; } catch { dj = null; } }
      const bad = (dj?.status?.conditions ?? []).filter((c) => (c.type === "Available" && c.status !== "True") || (c.type === "Progressing" && (c.status === "False" || /Deadline/.test(c.reason ?? ""))));
      for (const c of bad) if (c.message?.trim()) parts.push(`${c.type}: ${c.message}`);
      const sel = Object.entries(dj?.spec?.selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
      if (sel) {
        const p = await run([...ctx, "get", "pods", "-n", ns, "-l", sel, "-o", "json"], reqTimeoutMs);
        if (p.code === 0) {
          try {
            const w = ((JSON.parse(p.stdout) as PodsJson).items ?? []).flatMap((x) => x.status?.containerStatuses ?? []).map((c) => c.state?.waiting).find((x) => x?.reason && x.reason !== "ContainerCreating" && x.reason !== "PodInitializing");
            if (w) parts.push(`Pod: ${w.reason}${w.message ? ` (${w.message})` : ""}`);
          } catch { /* 읽기 실패는 사유 없음으로 */ }
        }
      }
      return parts.length ? clip(`Deployment/${dep.name}: ${parts.join("; ")}`) : "";
    },
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
          if (j.done && !j.ok && j.emptyDetail && reader.diagnose) {
            // ARGODEG ④: Application 에 사유가 없으면 Deployment·Pod 를 한 번 더 읽는다. 실패하면 고정 문구 그대로
            const extra = await reader.diagnose(r.status).catch(() => "");
            if (extra) j.reason = `ARGO_DEGRADED: ${extra}`;
          }
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
