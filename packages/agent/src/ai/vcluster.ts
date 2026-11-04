import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxIsolation, SandboxRunKind } from "@svc/contracts";
import { kubeClient, KubeError, ok2xx, statusMessage, type HostKube, type KubeClient, type VirtualAdminKube, type VirtualAgentKube } from "./kube.js";
import { LIMIT_RANGE, type SandboxQuota } from "../rehearsal/manifests.js";

// vCluster 백엔드: 플랫폼 클러스터(호스트)의 sbx-<이름> 네임스페이스 하나에 일회용 가상 클러스터 하나.
// 호스트 쪽 순서는 플랫폼 차트(deploy/helm/platform README "샌드박스")와 맞물린다
//   1. 네임스페이스 + 라벨 넷 (VAP sbx-namespace-guard 가 본다) + 실행 번호 라벨
//   2. RoleBinding sbx-operator → platform/agent-worker
//   3. 이미지에 넣은 차트를 helm 으로 (ClusterRole 끔, 제어판 저장은 emptyDir)
//   4. 가상 API /readyz → 관리자 클라이언트
//   끝: helm uninstall → 네임스페이스 삭제. 남은 것은 만료 라벨로 청소(sweepSandboxes)

export const VCLUSTER_CHART = "vcluster-0.37.6" as const;
export const SANDBOX_LABEL = {
  sandbox: "platform.svc/sandbox",
  purpose: "platform.svc/sandbox-purpose",
  expiresAt: "platform.svc/expires-at",
  run: "platform.svc/sandbox-run",
} as const;
const POOL = "sandbox";
const TOLERATION = { key: "dedicated", operator: "Equal", value: POOL, effect: "NoSchedule" } as const;

// 가상 쿠버네티스 마이너 → 제어판 이미지 태그@다이제스트. 차트 기본(1.36)을 쓰지 않고 도착 마이너에 맞춘다
export const VIRTUAL_K8S: Readonly<Record<string, string>> = {
  "1.33": "v1.33.0@sha256:904908abebd144235856965cf2db4c5884756125d3b582f1b63025446bb1887e",
  "1.34": "v1.34.0@sha256:2c5c4154208cc566085df4c16744eeec8b4e155b71168566e7be654c80dcf959",
  "1.35": "v1.35.0@sha256:90097a08b87cd988e3c48f3885e9a459f25e9ea584bb8e77f13aff9471204fd0",
  "1.36": "v1.36.6@sha256:967b956bd407adcacc5e6323bb20346c58e190d8a292cc63dea7cef60b5e9cbc",
};
// DECISION(team): 가상 1.35 (ADR-006). 표에 없는 마이너는 이 값으로 돌고 결과 k8sVersion 에 그대로 보인다
export const DEFAULT_K8S_MINOR = "1.35";
// TODO(human): 제어판·CoreDNS 이미지(ghcr.io/loft-sh/*, docker.io/coredns/coredns)를 플랫폼 ECR 로 옮길지 (설계 질문 7)
const VCLUSTER_IMAGE_TAG = "0.37.6@sha256:99345bf4c01ec4ed777a72766c861d7d5435f195a6bd6643bb8f3db0f5eb89c8";

export const sandboxName = (kind: SandboxRunKind, runId: string) => `sbx-${kind}-${runId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)}`;

export interface VclusterSpec {
  kind: SandboxRunKind;
  runId: string;
  isolation: SandboxIsolation;
  k8sMinor: string;
  quota: SandboxQuota;
  images: ReadonlyArray<{ ref: string; sandboxRef: string }>;   // translateImage: 가상 매니페스트는 그대로, 호스트 파드만 샌드박스 자리에서 받는다
  ttlSec: number;
}

// 실행마다 바뀌는 칸까지 채운 차트 값 (순수 함수). 측정 값(kind 1.35, 11-04)을 바탕으로 한다
export function vclusterValues(s: VclusterSpec, name: string): Record<string, unknown> {
  const svc = `${name}.${name}.svc`;
  const q = s.quota;
  return {
    controlPlane: {
      distro: { k8s: { enabled: true, image: { tag: VIRTUAL_K8S[s.k8sMinor] ?? VIRTUAL_K8S[DEFAULT_K8S_MINOR] } } },
      statefulSet: {
        image: { repository: "loft-sh/vcluster-oss", tag: VCLUSTER_IMAGE_TAG },
        resources: { requests: { cpu: "200m", memory: "256Mi" }, limits: { memory: "1Gi" } },
        scheduling: { nodeSelector: { pool: POOL }, tolerations: [TOLERATION] },
        // 결정(리드): 플랫폼 EKS 에 EBS CSI 가 없어 제어판 저장은 emptyDir. 차트는 이때 StatefulSet 대신 Deployment 를 그린다
        persistence: { volumeClaim: { enabled: false } },
      },
      // 차트 기본 인증서에는 <이름>.<네임스페이스>.svc 가 없다 (측정). 클러스터 안에서 서비스 주소로 붙으려면 넣는다
      proxy: { extraSANs: [`${name}.${name}`, svc, `${svc}.cluster.local`] },
    },
    rbac: { clusterRole: { enabled: false }, enableVolumeSnapshotRules: { enabled: false } },
    sync: {
      toHost: {
        pods: {
          enforceTolerations: [`${TOLERATION.key}=${POOL}:${TOLERATION.effect}`],
          useSecretsForSATokens: true,
          rewriteHosts: { enabled: false },
          translateImage: Object.fromEntries(s.images.map((i) => [i.ref, i.sandboxRef])),
          ...(s.isolation.runtimeClass ? { runtimeClassName: s.isolation.runtimeClass } : {}),
        },
        persistentVolumes: { enabled: false }, ingresses: { enabled: false }, priorityClasses: { enabled: false }, networkPolicies: { enabled: false },
      },
      // 노드는 동기화하지 않고, 동기화된 파드에 nodeSelector pool=sandbox 만 붙는다 (sbx-pod-guard 가 본다)
      fromHost: { nodes: { enabled: false, clearImageStatus: true, selector: { labels: { pool: POOL } } } },
    },
    policies: {
      podSecurityStandard: s.isolation.podSecurity,
      resourceQuota: {
        enabled: true,
        // null 은 차트 기본 칸을 지운다. CPU 한도와 임시 저장소 합은 셈하지 않는다 (컨테이너마다 LimitRange 기본이 남는다)
        quota: {
          "requests.cpu": `${q.requests.cpuM}m`, "requests.memory": `${q.requests.memoryMi}Mi`, "limits.memory": `${q.limitsMemoryMi}Mi`,
          "limits.cpu": null, "requests.ephemeral-storage": null, "limits.ephemeral-storage": null,
          "count/pods": q.pods, "services.loadbalancers": 0, "services.nodeports": 0, "requests.storage": `${q.storageMi}Mi`,
        },
      },
      limitRange: { enabled: true, default: LIMIT_RANGE.default, defaultRequest: LIMIT_RANGE.defaultRequest },
      networkPolicy: { enabled: true, workload: { publicEgress: { enabled: false } } },
    },
    // 기본 Secret vc-<이름> = 관리자 (결정 코드만). vc-agent-<이름> = 가상 안 조회 전용 SA ai-agent (LLM 도구 몫)
    exportKubeConfig: {
      server: `https://${svc}:443`,
      additionalSecrets: [{ name: `vc-agent-${name}`, server: `https://${svc}:443`, serviceAccount: { name: "ai-agent", clusterRole: "view" } }],
    },
    telemetry: { enabled: false },
  };
}

// ── helm ──
export interface HelmRunner { run(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> }
// 자식 프로세스에는 정해진 env 만 준다 (DATABASE_URL·ANTHROPIC_API_KEY 같은 agent-worker 비밀은 안 넘어간다).
// kubeconfig 는 경로만 담는다 (서버 주소, CA 파일, 토큰 파일). bin 은 절대 경로
export function helmRunner(o: { bin: string; kubeconfig: string; home: string }): HelmRunner {
  const env = {
    HOME: o.home, KUBECONFIG: o.kubeconfig,
    HELM_CACHE_HOME: join(o.home, "cache"), HELM_CONFIG_HOME: join(o.home, "config"), HELM_DATA_HOME: join(o.home, "data"),
  };
  return {
    run: (args, timeoutMs) => new Promise((resolve) => {
      const p = spawn(o.bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const take = (d: Buffer) => { if (out.length < 64_000) out += d.toString("utf8"); };
      p.stdout.on("data", take); p.stderr.on("data", take);
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out: `${out}\n${e.message}` }); });
      p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    }),
  };
}
// helm 이 읽을 호스트 kubeconfig (JSON 은 YAML 이다). 비밀은 없고 파일 경로만
export function hostKubeconfig(h: { server: string; caFile?: string; tokenFile?: string }): string {
  return JSON.stringify({
    apiVersion: "v1", kind: "Config", "current-context": "host",
    clusters: [{ name: "host", cluster: { server: h.server, ...(h.caFile ? { "certificate-authority": h.caFile } : {}) } }],
    users: [{ name: "agent-worker", user: h.tokenFile ? { tokenFile: h.tokenFile } : {} }],
    contexts: [{ name: "host", context: { cluster: "host", user: "agent-worker" } }],
  });
}

// ── 만들기·지우기 ──
export interface VirtualCreds { ca: string; cert?: string; key?: string; token?: string }
export interface VclusterHost {
  kube: HostKube;
  helm: HelmRunner;
  chart: string;               // 차트 묶음 .tgz
  workDir: string;             // 실행마다 값 파일을 잠깐 쓰는 곳 (0700)
  connect?: (url: string, c: VirtualCreds) => KubeClient;
  virtualUrl?: (name: string) => Promise<string>;   // 기본 https://<이름>.<이름>.svc:443. 로컬 시험은 port-forward
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface DisposeReport { deleted: boolean; detail: string }
export interface Vcluster {
  readonly name: string;       // = 호스트 네임스페이스 = helm 릴리스
  readonly admin: VirtualAdminKube;
  readonly k8sVersion: string;
  readonly createMs: number;
  agent(): Promise<VirtualAgentKube>;
  dispose(): Promise<DisposeReport>;
}

const b64 = (v: unknown) => (typeof v === "string" && v ? Buffer.from(v, "base64").toString("utf8") : undefined);
function credsOf(secret: unknown): VirtualCreds | null {
  const d = (secret as { data?: Record<string, string> } | null)?.data ?? {};
  const ca = b64(d["certificate-authority"]);
  return ca ? { ca, cert: b64(d["client-certificate"]), key: b64(d["client-key"]), token: b64(d.token) } : null;
}
const defaultConnect = (url: string, c: VirtualCreds) =>
  kubeClient({ baseUrl: url, ca: c.ca, cert: c.cert, key: c.key, token: c.token, timeoutMs: 30_000 });

export async function createVcluster(h: VclusterHost, s: VclusterSpec, o: { readyTimeoutMs?: number; pollMs?: number } = {}): Promise<Vcluster> {
  const now = h.now ?? Date.now;
  const sleep = h.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const connect = h.connect ?? defaultConnect;
  const urlOf = h.virtualUrl ?? (async (n: string) => `https://${n}.${n}.svc:443`);
  const t0 = now();
  const name = sandboxName(s.kind, s.runId);
  const nsPath = `/api/v1/namespaces/${name}`;
  const must = async (what: string, method: string, path: string, body: unknown) => {
    const r = await h.kube.call(method, path, { body });
    if (!ok2xx(r.status)) throw new KubeError("SANDBOX_CREATE", `${what} 실패 (${r.status}): ${statusMessage(r)}`);
  };
  await must("네임스페이스", "POST", "/api/v1/namespaces", {
    apiVersion: "v1", kind: "Namespace",
    metadata: { name, labels: {
      [SANDBOX_LABEL.sandbox]: "true", [SANDBOX_LABEL.purpose]: s.kind,
      [SANDBOX_LABEL.expiresAt]: String(Math.floor(now() / 1000) + s.ttlSec),
      "pod-security.kubernetes.io/enforce": "baseline",
      [SANDBOX_LABEL.run]: s.runId.slice(0, 63),
    } },
  });
  let disposed: Promise<DisposeReport> | null = null;
  const dispose = () => (disposed ??= (async () => {
    await h.helm.run(["uninstall", name, "-n", name, "--wait", "--timeout", "60s"], 90_000);
    try {
      const r = await h.kube.call("DELETE", nsPath, { body: { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background" } });
      return ok2xx(r.status) || r.status === 404 ? { deleted: true, detail: "" } : { deleted: false, detail: `네임스페이스 삭제 실패 (${r.status}): ${statusMessage(r)}` };
    } catch (e) {
      return { deleted: false, detail: `네임스페이스 삭제 실패: ${(e as Error).message}` };
    }
  })());
  try {
    await must("RoleBinding", "POST", `/apis/rbac.authorization.k8s.io/v1/namespaces/${name}/rolebindings`, {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "sbx-operator" },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "sbx-operator" },
      subjects: [{ kind: "ServiceAccount", name: "agent-worker", namespace: "platform" }],
    });
    const values = join(h.workDir, `${name}.values.json`);
    await writeFile(values, JSON.stringify(vclusterValues(s, name)), { mode: 0o600 });
    const helm = await h.helm.run(["upgrade", "--install", name, h.chart, "-n", name, "-f", values, "--timeout", "120s"], 150_000)
      .finally(() => rm(values, { force: true }));
    if (helm.code !== 0) throw new KubeError("SANDBOX_HELM", `helm install 실패 (${helm.code ?? "시간 초과"}): ${helm.out.trim().slice(-400)}`);

    const deadline = now() + (o.readyTimeoutMs ?? 180_000);
    let admin: KubeClient | null = null;
    let last = "kubeconfig 비밀 없음";
    for (;;) {
      if (!admin) {
        const sec = await h.kube.call("GET", `${nsPath}/secrets/vc-${name}`);
        const creds = ok2xx(sec.status) ? credsOf(sec.body) : null;
        if (creds) admin = connect(await urlOf(name), creds);
      }
      if (admin) {
        const r = await admin.call("GET", "/readyz").catch((e: Error) => ({ status: 0, text: e.message }));
        if (r.status === 200) break;
        last = `readyz ${r.status} ${r.text.slice(0, 100)}`;
      }
      if (now() >= deadline) throw new KubeError("SANDBOX_NOT_READY", `vCluster 가 ${Math.round((o.readyTimeoutMs ?? 180_000) / 1000)}초 안에 준비되지 않음 (${last})`);
      await sleep(o.pollMs ?? 2000);
    }
    const v = await admin.call("GET", "/version");
    const k8sVersion = String((v.body as { gitVersion?: unknown } | null)?.gitVersion ?? "");
    const virtualAdmin = admin as VirtualAdminKube;
    return {
      name, admin: virtualAdmin, k8sVersion, createMs: now() - t0, dispose,
      async agent() {
        const sec = await h.kube.call("GET", `${nsPath}/secrets/vc-agent-${name}`);
        const creds = ok2xx(sec.status) ? credsOf(sec.body) : null;
        if (!creds?.token) throw new KubeError("SANDBOX_AGENT_KUBECONFIG", `vc-agent-${name} 비밀이 없음 (${sec.status})`);
        return connect(await urlOf(name), { ca: creds.ca, token: creds.token }) as VirtualAgentKube;
      },
    };
  } catch (e) {
    await dispose();
    throw e;
  }
}

// ── 청소 ──
// 남은 샌드박스 네임스페이스를 지운다 (#177). 실패는 실행 번호·네임스페이스와 함께 돌려주고 부르는 쪽이 경고 로그로 남긴다
export interface SandboxNamespace { name: string; labels: Record<string, string>; terminating: boolean }
export interface SweepReport { deleted: string[]; failed: Array<{ namespace: string; runId: string | null; error: string }> }
export async function sweepSandboxes(kube: HostKube, pick: (ns: SandboxNamespace) => boolean): Promise<SweepReport> {
  const out: SweepReport = { deleted: [], failed: [] };
  const r = await kube.call("GET", `/api/v1/namespaces?labelSelector=${encodeURIComponent(`${SANDBOX_LABEL.sandbox}=true`)}`);
  if (!ok2xx(r.status)) throw new KubeError("SANDBOX_SWEEP", `샌드박스 네임스페이스 목록 실패 (${r.status}): ${statusMessage(r)}`);
  for (const item of ((r.body as { items?: any[] })?.items ?? [])) {
    const ns: SandboxNamespace = { name: String(item?.metadata?.name ?? ""), labels: item?.metadata?.labels ?? {}, terminating: item?.status?.phase === "Terminating" };
    if (!ns.name.startsWith("sbx-") || ns.terminating || !pick(ns)) continue;
    const runId = ns.labels[SANDBOX_LABEL.run] ?? null;
    try {
      const d = await kube.call("DELETE", `/api/v1/namespaces/${ns.name}`, { body: { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background" } });
      if (ok2xx(d.status) || d.status === 404) out.deleted.push(ns.name);
      else out.failed.push({ namespace: ns.name, runId, error: `${d.status}: ${statusMessage(d)}` });
    } catch (e) {
      out.failed.push({ namespace: ns.name, runId, error: (e as Error).message });
    }
  }
  return out;
}
// 만료 라벨이 지난 것 (모든 목적)
export const expiredSandbox = (nowSec: number) => (ns: SandboxNamespace) => {
  const at = Number(ns.labels[SANDBOX_LABEL.expiresAt]);
  return Number.isFinite(at) && at < nowSec;
};
// 리허설 하나를 시작하기 전: 지금 실행 말고 남은 리허설 네임스페이스 전부. 리허설 큐는 동시 1건(singleton)이라
//   지금 실행이 아닌 리허설 네임스페이스는 죽은 실행이 남긴 것이다 (sandbox 노드에 한 번에 한 회사)
export const leftoverRehearsal = (keep: string) => (ns: SandboxNamespace) =>
  ns.labels[SANDBOX_LABEL.purpose] === "rehearsal" && ns.name !== keep;
