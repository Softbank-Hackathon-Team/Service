import { randomBytes } from "node:crypto";
import type { Sandbox, WorkingCopy } from "./sandbox.js";
import { KubeError, statusMessage, type KubeClient } from "./kube.js";
import { checkManifest, redact, redactText, type ApplyKind, type ManifestDoc, imagesOf } from "./guard.js";
import { allowedPath } from "./tools.js";

// k3d 구현: 맥 로컬 k3d 클러스터(agent-sbx) 안에 실행마다 일회용 네임스페이스를 만든다.
//   만들기: 네임스페이스(PSS restricted 라벨) + 자원 상한(ResourceQuota·LimitRange) + 망 정책(DNS 말고 밖으로 못 나감)
//   씨앗:  작업 복사본 deploy/*.yaml 을 그대로 적용해 문제 상황을 재현 (플랫폼이 한다, 에이전트 도구 아님)
//   적용:  코드 정책 검사 → 서버 dry-run(dryRun=All) → 진짜 적용 (server-side apply)
//   끝:    네임스페이스 삭제 (처리기가 finally 로 부른다. 남은 것은 라벨로 일괄 삭제)
// 운영 클러스터에는 닿지 않는다: 노드 이름이 k3d-agent-sbx- 로 시작하지 않으면 만들기 전에 멈춘다.
// DRAFT(ai): 다음 단계(설계 v1)는 vCluster + gVisor + Kyverno. 지금은 네임스페이스 격리만이라 "같은 커널" 이라고 밝힌다

export const SANDBOX_LABEL = "app.kubernetes.io/managed-by";
export const SANDBOX_LABEL_VALUE = "svc-agent-sandbox";
const FIELD_MANAGER = "svc-agent-sandbox";

const RES: Record<ApplyKind, { api: string; plural: string; apiVersion: string }> = {
  Deployment: { api: "/apis/apps/v1", plural: "deployments", apiVersion: "apps/v1" },
  Service: { api: "/api/v1", plural: "services", apiVersion: "v1" },
  ConfigMap: { api: "/api/v1", plural: "configmaps", apiVersion: "v1" },
  HorizontalPodAutoscaler: { api: "/apis/autoscaling/v2", plural: "horizontalpodautoscalers", apiVersion: "autoscaling/v2" },
};

export interface K3dSandboxOptions {
  kube: KubeClient;
  tenantId: string;
  runId: string;
  seed?: WorkingCopy;                 // 문제 재현용으로 먼저 적용할 deploy/*.yaml
  nodePrefix?: string | null;         // 기본 "k3d-agent-sbx-". null 이면 검사 안 함 (시험용)
  ttlSeconds?: number;                // 남은 네임스페이스 청소 기준 (라벨). 기본 1800
  pollMs?: number;                    // run_check 관찰 간격. 기본 5000
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export interface K3dSandbox extends Sandbox {
  readonly namespace: string;
  readonly createMs: number;
  dispose(): Promise<void>;
}

const slug = (s: string, n: number) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, n) || "x";
const ok2xx = (s: number) => s >= 200 && s < 300;

export async function createK3dSandbox(o: K3dSandboxOptions): Promise<K3dSandbox> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 5000;
  const t0 = now();
  const kube = o.kube;
  const ns = `sbx-${slug(o.tenantId, 8)}-${slug(o.runId, 8)}-${randomBytes(2).toString("hex")}`;
  const nsPath = `/api/v1/namespaces/${ns}`;

  // 1) 오접속 방지: 샌드박스 전용 클러스터인지 노드 이름으로 확인
  const prefix = o.nodePrefix === undefined ? "k3d-agent-sbx-" : o.nodePrefix;
  if (prefix) {
    const r = await kube.call("GET", "/api/v1/nodes");
    if (!ok2xx(r.status)) throw new KubeError("SANDBOX_NODES", `노드 목록 실패: ${statusMessage(r)}`);
    const names = ((r.body as any)?.items ?? []).map((n: any) => String(n?.metadata?.name ?? ""));
    if (names.length === 0 || names.some((n: string) => !n.startsWith(prefix)))
      throw new KubeError("SANDBOX_WRONG_CLUSTER", `샌드박스 전용 클러스터가 아님 (노드 ${names.length}개, 기대 접두어 ${prefix}). 아무것도 만들지 않음`);
  }

  // 2) 네임스페이스 + 상한 + 망 정책
  const must = async (what: string, method: string, path: string, body: unknown) => {
    const r = await kube.call(method, path, { body });
    if (!ok2xx(r.status)) throw new KubeError("SANDBOX_CREATE", `${what} 실패 (${r.status}): ${statusMessage(r)}`);
  };
  await must("네임스페이스", "POST", "/api/v1/namespaces", {
    apiVersion: "v1", kind: "Namespace",
    metadata: { name: ns, labels: {
      [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE,
      "svc.sandbox/expires-at": String(Math.floor(now() / 1000) + (o.ttlSeconds ?? 1800)),
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/enforce-version": "latest",
    } },
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const r = await kube.call("DELETE", nsPath, { body: { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background" } });
    if (!ok2xx(r.status) && r.status !== 404) throw new KubeError("SANDBOX_DELETE", `네임스페이스 삭제 실패 (${r.status}): ${statusMessage(r)}`);
  };
  const allowedImages = new Set<string>();
  try {
    // DRAFT(ai): 상한 값. 맥 Docker 12.5GB 안에서 동시에 몇 개 돌려도 되게 작게
    await must("ResourceQuota", "POST", `${nsPath}/resourcequotas`, {
      apiVersion: "v1", kind: "ResourceQuota", metadata: { name: "sbx-quota" },
      spec: { hard: { pods: "6", services: "4", configmaps: "10", "requests.cpu": "1", "requests.memory": "1Gi", "limits.cpu": "2", "limits.memory": "2Gi" } },
    });
    await must("LimitRange", "POST", `${nsPath}/limitranges`, {
      apiVersion: "v1", kind: "LimitRange", metadata: { name: "sbx-limits" },
      spec: { limits: [{ type: "Container", default: { cpu: "500m", memory: "256Mi" }, defaultRequest: { cpu: "50m", memory: "64Mi" }, max: { cpu: "1", memory: "1Gi" } }] },
    });
    // 들어오기: 같은 네임스페이스만. 나가기: 같은 네임스페이스 + kube-dns(53) 만 (인터넷·다른 네임스페이스 0)
    await must("NetworkPolicy", "POST", `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`, {
      apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "sbx-default-deny" },
      spec: {
        podSelector: {}, policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [{ podSelector: {} }] }],
        egress: [
          { to: [{ podSelector: {} }] },
          { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
            ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        ],
      },
    });
    // 3) 씨앗: 작업 복사본 그대로 (문제 재현). 여기 쓰인 이미지만 에이전트가 쓸 수 있다
    for (const [path, text] of o.seed ?? []) {
      if (!allowedPath(path)) continue;
      const pol = checkManifest(text);
      if (!pol.ok) throw new KubeError("SANDBOX_SEED", `씨앗 매니페스트 거부 ${path}: ${pol.violations.join("; ")}`);
      for (const d of pol.docs) for (const img of imagesOf(d.obj)) allowedImages.add(img);
      const r = await applyDocs(pol.docs);
      if (!r.ok) throw new KubeError("SANDBOX_SEED", `씨앗 적용 실패 ${path}: ${r.message}`);
    }
  } catch (e) {
    await dispose().catch(() => {});
    throw e;
  }

  async function applyDocs(docs: ManifestDoc[]): Promise<{ ok: boolean; message: string }> {
    const done: string[] = [];
    for (const dryRun of [true, false]) {
      for (const d of docs) {
        const res = RES[d.kind];
        const obj = { ...d.obj, apiVersion: res.apiVersion, metadata: { ...(d.obj.metadata as object), namespace: ns } };
        const q = `fieldManager=${FIELD_MANAGER}&force=true${dryRun ? "&dryRun=All" : ""}`;
        const r = await kube.call("PATCH", `${res.api}/namespaces/${ns}/${res.plural}/${d.name}?${q}`,
          { body: obj, contentType: "application/apply-patch+yaml" });
        if (!ok2xx(r.status))
          return { ok: false, message: `${dryRun ? "서버 dry-run 거부" : "적용 실패"} ${d.kind}/${d.name} (${r.status}): ${redactText(statusMessage(r))}` };
        if (!dryRun) done.push(`${d.kind}/${d.name}`);
      }
    }
    return { ok: true, message: `적용함 (서버 dry-run 통과 뒤): ${done.join(", ")} → 네임스페이스 ${ns}` };
  }

  const listPods = async () => {
    const r = await kube.call("GET", `${nsPath}/pods`);
    return ok2xx(r.status) ? ((r.body as any)?.items ?? []) as any[] : [];
  };
  const listDeploys = async () => {
    const r = await kube.call("GET", `/apis/apps/v1/namespaces/${ns}/deployments`);
    return ok2xx(r.status) ? ((r.body as any)?.items ?? []) as any[] : [];
  };
  const podSummary = (p: any) => ({
    name: p.metadata?.name, phase: p.status?.phase,
    ready: (p.status?.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True"),
    containers: (p.status?.containerStatuses ?? []).map((c: any) => ({
      name: c.name, restartCount: c.restartCount ?? 0,
      state: c.state ? Object.keys(c.state)[0] : null,
      waitingReason: c.state?.waiting?.reason ?? null,
      lastState: c.lastState?.terminated
        ? { reason: c.lastState.terminated.reason ?? null, exitCode: c.lastState.terminated.exitCode ?? null, finishedAt: c.lastState.terminated.finishedAt ?? null }
        : null,
    })),
  });
  const restartsOf = (p: any) => (p.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
  const deployReady = (d: any) => {
    const want = d.spec?.replicas ?? 1;
    return (d.status?.readyReplicas ?? 0) >= want && (d.status?.replicas ?? want) <= want && (d.status?.updatedReplicas ?? 0) >= want && (d.status?.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0);
  };
  // 반환에는 env 이름만 (값은 안 줌, Z3-F5). 자원 상한·이미지·상태만
  const summarize = (kind: string, x: any): unknown => {
    switch (kind) {
      case "Pod": return podSummary(x);
      case "Deployment": return {
        name: x.metadata?.name, replicas: x.spec?.replicas ?? 1,
        readyReplicas: x.status?.readyReplicas ?? 0, updatedReplicas: x.status?.updatedReplicas ?? 0,
        containers: (x.spec?.template?.spec?.containers ?? []).map((c: any) => ({
          name: c.name, image: c.image, resources: c.resources ?? {},
          env: (c.env ?? []).map((e: any) => (e.valueFrom ? `${e.name} (참조)` : `${e.name}`)),
        })),
        conditions: (x.status?.conditions ?? []).map((c: any) => ({ type: c.type, status: c.status, reason: c.reason ?? null })),
      };
      case "Service": return { name: x.metadata?.name, type: x.spec?.type, ports: x.spec?.ports, selector: x.spec?.selector };
      case "ConfigMap": return { name: x.metadata?.name, data: redact(x.data ?? {}) };
      case "HorizontalPodAutoscaler": return {
        name: x.metadata?.name, min: x.spec?.minReplicas, max: x.spec?.maxReplicas, metrics: x.spec?.metrics,
        current: x.status?.currentReplicas, desired: x.status?.desiredReplicas,
      };
      default: return null;
    }
  };

  const sandbox: K3dSandbox = {
    mode: "k3d",
    namespace: ns,
    createMs: now() - t0,
    async get(kind, name) {
      const res = kind === "Pod" ? { api: "/api/v1", plural: "pods" } : RES[kind as ApplyKind];
      if (!res) return null;
      if (name !== null && !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(name)) return null;
      const r = await kube.call("GET", `${res.api}/namespaces/${ns}/${res.plural}${name ? `/${name}` : ""}`);
      if (r.status === 404) return null;
      if (!ok2xx(r.status)) throw new KubeError("KUBE_GET", `${kind} 읽기 실패 (${r.status})`);
      const b = r.body as any;
      return name ? summarize(kind, b) : (b?.items ?? []).slice(0, 20).map((x: any) => summarize(kind, x));
    },
    async logs(pod, tail) {
      if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(pod)) return null;
      // 정확한 파드 이름이 아니면 Deployment 이름으로 보고 그 파드 하나를 고른다 (web → web-7d9c…)
      const pods = await listPods();
      const p = pods.find((x) => x.metadata?.name === pod) ?? pods.find((x) => String(x.metadata?.name ?? "").startsWith(`${pod}-`));
      if (!p) return null;
      const name = String(p.metadata.name);
      const container = String(p.spec?.containers?.[0]?.name ?? "");
      const base = `${nsPath}/pods/${name}/log?tailLines=${tail}&container=${encodeURIComponent(container)}`;
      const out: string[] = [];
      if (restartsOf(p) > 0) {
        const prev = await kube.call("GET", `${base}&previous=true`);
        if (ok2xx(prev.status)) out.push(`--- 이전 컨테이너 (${name}) ---\n${prev.text}`);
      }
      const cur = await kube.call("GET", base);
      if (ok2xx(cur.status)) out.push(`--- 지금 컨테이너 (${name}) ---\n${cur.text}`);
      else out.push(`(지금 컨테이너 로그 없음: ${cur.status})`);
      return redactText(out.join("\n"));
    },
    async apply(manifest) {
      const pol = checkManifest(manifest, { allowedImages });
      const v = [...pol.violations];
      for (const d of pol.docs) {
        if (d.namespace !== null && d.namespace !== ns) v.push(`POL-07 다른 네임스페이스: ${d.namespace}`);
        const av = d.obj.apiVersion;
        if (av !== undefined && av !== RES[d.kind].apiVersion) v.push(`POL-08 apiVersion 이 틀림: ${String(av)}`);
      }
      if (v.length) return { ok: false, message: `거부 (코드 정책, 클러스터에 보내지 않음): ${v.join("; ")}` };
      return applyDocs(pol.docs);
    },
    async check(kind, seconds) {
      const start = now();
      let pods: any[] = [];
      let deps: any[] = [];
      const snap = async () => { pods = await listPods(); deps = await listDeploys(); return deps.length > 0 && deps.every(deployReady); };
      const waitReady = async (until: number) => {
        for (;;) {
          if (await snap()) return true;
          if (now() >= until) return false;
          await sleep(Math.min(pollMs, Math.max(0, until - now())));
        }
      };
      if (kind === "probe") {
        const ok = await waitReady(start + seconds * 1000);
        const ready = deps.filter(deployReady).length;
        return { ok, detail: ok ? `probe: ${Math.round((now() - start) / 1000)}초 만에 준비됨 (Deployment ${deps.length}개)` : `probe ${seconds}초: 준비 ${ready}/${deps.length}` };
      }
      // stability: (1) 방금 적용한 롤아웃이 끝나길 기다린다 (최대 min(N,120)초. 옛 파드의 재시작을 세지 않으려고)
      //            (2) 그때부터 N초 관찰해 지금 파드들의 재시작 증가를 센다
      const rolledOut = await waitReady(start + Math.min(seconds, 120) * 1000);
      const t1 = now();
      const base = new Map<string, number>();
      for (const p of pods) base.set(String(p.metadata?.name), restartsOf(p));
      const deadline = t1 + seconds * 1000;
      while (now() < deadline) { await sleep(Math.min(pollMs, Math.max(0, deadline - now()))); await snap(); }
      const ready = deps.filter(deployReady).length;
      let delta = 0;
      const reasons: string[] = [];
      for (const p of pods) {
        const n = String(p.metadata?.name);
        const d = restartsOf(p) - (base.get(n) ?? 0);
        delta += Math.max(0, d);
        for (const c of p.status?.containerStatuses ?? []) {
          const why = c.lastState?.terminated?.reason ?? c.state?.waiting?.reason;
          if (why && d > 0) reasons.push(`${n}: ${why}`);
        }
      }
      const ok = delta === 0 && deps.length > 0 && ready === deps.length;
      return { ok, detail: `stability ${seconds}초 (롤아웃 ${rolledOut ? `${Math.round((t1 - start) / 1000)}초 만에 끝남` : "안 끝남"}): 재시작 +${delta}, 준비 ${ready}/${deps.length}${reasons.length ? `, 이유 ${[...new Set(reasons)].join(", ")}` : ""}` };
    },
    dispose,
  };
  return sandbox;
}
