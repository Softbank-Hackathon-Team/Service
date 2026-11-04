import {
  fidelityOwner, REHEARSAL_FAILURE_CLASS, RehearsalResult, sandboxIsolation,
  type FidelityMatrix, type RehearsalCheck, type RehearsalCheckId, type RehearsalFailureCode, type RehearsalInput,
  type SandboxIsolation, type SandboxRunPhase,
} from "@svc/contracts";
import { KubeError, ok2xx, statusMessage, type KubeClient, type KubeResponse, type VirtualAdminKube } from "../ai/kube.js";
import { redactText } from "../ai/guard.js";
import { sandboxName, VCLUSTER_CHART, type SweepReport, type Vcluster, type VclusterSpec } from "../ai/vcluster.js";
import {
  apiPath, originalLimits, parseManifests, podTemplates, PROBE_RESOURCES, sandboxQuotaPlan, subjectOf,
  type Manifest, type Resources,
} from "./manifests.js";
import { databaseStandIns } from "./stand-in.js";

// 리허설 한 번: 워커가 준 렌더 결과(original)와 치환본(apply)을 일회용 vCluster 에 올려 본다.
// 순서는 설계 3장 표. 한 단계라도 필수 검사가 실패하면 그 단계의 코드로 끝내고, 지우기는 언제나 한다
// 판정: 코드 없음 = passed, 코드의 뜻이 platform 이면 error(샌드박스 쪽), 그 밖은 failed(앱·매니페스트·보증 못 함)

export interface RehearsalTiming {
  readyMs: number; rolloutMs: number; jobMs: number; dbMs: number;
  restartWindowMs: number; probeMs: number; crdMs: number; pollMs: number;
}
// 설계 2.7 시간 상한. 롤아웃·잡은 매니페스트의 progressDeadlineSeconds·activeDeadlineSeconds 가 있으면 그 값 (최대 600초)
export const REHEARSAL_TIMING: RehearsalTiming = {
  readyMs: 180_000, rolloutMs: 300_000, jobMs: 300_000, dbMs: 180_000,
  restartWindowMs: 60_000, probeMs: 120_000, crdMs: 30_000, pollMs: 2_000,
};
// TODO(human): 검사 파드 이미지를 플랫폼 ECR 샌드박스 자리로 옮길지 (지금은 Docker Hub 다이제스트 고정)
export const PROBE_IMAGE = "docker.io/curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40";

export interface RehearsalBackend {
  create(spec: VclusterSpec): Promise<Vcluster>;
  sweepLeftovers(keep: string): Promise<SweepReport>;
  crds: readonly any[];             // 이미지에 넣은 CRD (ExternalSecret, CNPG Cluster). 원본 dry-run 용
  allocatable?: Resources;
  probeImage?: string;
  ttlSec: number;
  timing?: Partial<RehearsalTiming>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
// tenantId: sandbox_runs 줄의 회사. 호스트 네임스페이스 라벨 platform.svc/tenant 가 된다
export interface RehearsalRun { id: string; tenantId: string; onPhase?: (p: SandboxRunPhase) => Promise<void> | void }

class Stop { constructor(readonly code: RehearsalFailureCode) {} }
const FIELD_MANAGER = "svc-rehearsal";
const TARGET_POLICY_NS = "rehearsal-target-policy";
const PROBE_POD = "rehearsal-probe";

// 리허설에서 agent-worker 가 맡는 충실도 두 줄 (나머지는 워커 몫 그대로)
export function withSandboxFidelity(f: FidelityMatrix, target: RehearsalInput["targetPodSecurity"], iso: SandboxIsolation): FidelityMatrix {
  return {
    ...f,
    items: [
      ...f.items.filter((i) => fidelityOwner(i.id) === "worker"),
      {
        id: "sandbox_pod_security", status: iso.podSecurity === target ? "identical" : "substituted",
        real: `도착 파드 보안 ${target}`, sandbox: `가상 앱 네임스페이스 enforce=${iso.podSecurity}, warn·audit=restricted`,
        reason: iso.podSecurity === target ? "도착과 같은 수준에서 돌렸다" : "샌드박스 규칙이 도착보다 엄격하다. 여기서만 막히면 REHEARSAL_POLICY_DENIED 로 따로 보인다",
        refs: [],
      },
      {
        id: "runtime_isolation", status: "substituted",
        real: "도착 클러스터 노드",
        sandbox: iso.runtimeClass ? `RuntimeClass ${iso.runtimeClass} (커널 분리)` : "전용 sandbox 노드, 같은 커널(runc), 한 번에 한 회사",
        reason: "리허설은 플랫폼 안 일회용 가상 클러스터에서 돈다",
        refs: [],
      },
    ],
  };
}

export async function runRehearsal(input: RehearsalInput, run: RehearsalRun, b: RehearsalBackend): Promise<RehearsalResult> {
  const now = b.now ?? Date.now;
  const sleep = b.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const T: RehearsalTiming = { ...REHEARSAL_TIMING, ...b.timing };
  const iso = sandboxIsolation("rehearsal");
  const name = sandboxName("rehearsal", run.id);
  const ns = input.namespace;
  const checks: RehearsalCheck[] = [];
  const warnings = new Set<string>();
  const timings = { create: 0, apply: 0, check: 0, delete: 0 };
  let failure: RehearsalFailureCode | null = null;
  let vc: Vcluster | null = null;
  let k8sVersion = "";
  let deleted = false;

  const add = (id: RehearsalCheckId, subject: string, ok: boolean, ms: number, detail: string, required = true) => {
    checks.push({ id, subject: subject.slice(0, 200), required, ok, ms: Math.max(0, Math.round(ms)), detail: redactText(detail).slice(0, 500) });
    return ok;
  };
  // 단계 하나의 검사 줄을 다 쓴 뒤 부른다. 실패 줄이 있으면 그 코드로 멈춘다
  const gate = (failed: RehearsalFailureCode | null) => { if (failed) throw new Stop(failed); };
  // 단계 시간: 단계가 바뀔 때와 끝날 때(실패 포함) 지금 단계를 닫는다
  let open: { key: keyof typeof timings; at: number } | null = null;
  const close = () => { if (open) timings[open.key] += now() - open.at; open = null; };
  const phase = async (p: SandboxRunPhase, key?: keyof typeof timings) => {
    close();
    if (key) open = { key, at: now() };
    await run.onPhase?.(p);
  };
  const note = (r: KubeResponse) => { for (const w of r.warnings) if (warnings.size < 50) warnings.add(w.slice(0, 300)); };

  try {
    // 0. 순수 검사 (샌드박스를 만들기 전)
    let t = now();
    const orig = parseManifests(input.original, "original");
    const appl = parseManifests(input.apply, "apply");
    const standIns = databaseStandIns(input.databases, appl.manifests);
    const db = standIns.manifests;
    const problems = [...orig.problems, ...appl.problems, ...standIns.problems];
    add("unsupported_kind", "묶음", problems.length === 0, now() - t,
      problems.length ? problems.slice(0, 5).join("; ")
        : `원본 ${orig.manifests.length}개, 적용 ${appl.manifests.length}개 모두 지원 목록 안, DB 대체물 ${db.length}개`);
    gate(problems.length ? "REHEARSAL_UNSUPPORTED_KIND" : null);

    const lim = originalLimits(orig.manifests);
    const tq = input.targetQuota;
    const over = tq ? [
      ...(tq.limitsCpuM !== null && lim.cpuM > tq.limitsCpuM ? [`CPU 한도 합 ${lim.cpuM}m > 도착 ${tq.limitsCpuM}m`] : []),
      ...(tq.limitsMemoryMi !== null && lim.memoryMi > tq.limitsMemoryMi ? [`메모리 한도 합 ${lim.memoryMi}Mi > 도착 ${tq.limitsMemoryMi}Mi`] : []),
    ] : [];
    add("quota", "도착 네임스페이스 한도", over.length === 0, 0,
      tq ? (over.length ? over.join(", ") : `한도 합 CPU ${lim.cpuM}m, 메모리 ${lim.memoryMi}Mi (도착 안)`) : "도착 네임스페이스 한도 없음");
    gate(over.length ? "REHEARSAL_QUOTA_EXCEEDED" : null);

    const plan = sandboxQuotaPlan([...db, ...appl.manifests], b.allocatable);
    if (!plan.fits) {
      add("sandbox_ready", name, false, 0, `리허설에 필요한 요청량 CPU ${plan.need.cpuM}m·메모리 ${plan.need.memoryMi}Mi 가 sandbox 노드 할당량 CPU ${plan.cap.cpuM}m·메모리 ${plan.cap.memoryMi}Mi 를 넘는다`);
      gate("REHEARSAL_SANDBOX_UNAVAILABLE");
    }

    // 1. 샌드박스
    await phase("creating", "create");
    t = now();
    try {
      const swept = await b.sweepLeftovers(name);
      if (swept.failed.length) throw new KubeError("SANDBOX_LEFTOVER", `남은 리허설 네임스페이스를 못 지움: ${swept.failed.map((f) => `${f.namespace} (${f.error})`).join(", ")}`);
      vc = await b.create({ kind: "rehearsal", runId: run.id, tenantId: run.tenantId, isolation: iso, k8sMinor: input.k8sMinor, quota: plan.quota, images: input.images, ttlSec: b.ttlSec });
      k8sVersion = vc.k8sVersion;
      add("sandbox_ready", name, true, now() - t,
        `가상 ${vc.k8sVersion} 준비 ${Math.round(vc.createMs / 1000)}초, 상한 CPU ${plan.quota.requests.cpuM}m·메모리 ${plan.quota.requests.memoryMi}Mi·파드 ${plan.quota.pods}개${swept.deleted.length ? `, 남은 것 ${swept.deleted.length}개 지움` : ""}`);
    } catch (e) {
      add("sandbox_ready", name, false, now() - t, e instanceof KubeError ? `${e.code}: ${e.message}` : String((e as Error).message ?? e));
      gate("REHEARSAL_SANDBOX_UNAVAILABLE");
    }
    const kube = vc!.admin;

    // 2. dry-run · 도착 정책 · 적용
    await phase("applying", "apply");
    await prepare(kube, orig.manifests);
    gate(await dryRun(kube, orig.manifests));
    gate(await targetPolicy(kube, orig.manifests));
    // DB 대체물이 먼저 준비돼야 앱이 붙는다
    gate(await apply(kube, db, true));
    if (db.length) gate(await converge(kube, db, true));
    gate(await apply(kube, appl.manifests, false));

    // 3. 롤아웃 · 잡 · 재시작 · 준비 · 연결
    await phase("checking", "check");
    gate(await converge(kube, appl.manifests, false));
    gate(await restarts(kube, [...db, ...appl.manifests], db));
    gate(await ready(kube, [...db, ...appl.manifests], db));
    gate(await connectivity(kube, appl.manifests));
  } catch (e) {
    if (e instanceof Stop) failure = e.code;
    else {
      add("sandbox_ready", name, false, 0, `리허설 중 예기치 못한 오류: ${(e as Error).message ?? String(e)}`);
      failure = "REHEARSAL_SANDBOX_UNAVAILABLE";
    }
  } finally {
    close();
    if (vc) {
      await phase("deleting", "delete");
      const r = await vc.dispose();
      deleted = r.deleted;
      if (!r.deleted) warnings.add(`샌드박스 지우기 실패 (만료 청소가 마무리): ${r.detail}`.slice(0, 300));
      close();
    }
  }

  return RehearsalResult.parse({
    verdict: failure === null ? "passed" : REHEARSAL_FAILURE_CLASS[failure] === "platform" ? "error" : "failed",
    failureCode: failure,
    sandbox: { ...iso, name, hostNamespace: name, chart: VCLUSTER_CHART, k8sVersion, mock: false },
    bundleSha256: input.bundleSha256,
    checks: checks.slice(0, 300),
    fidelity: withSandboxFidelity(input.fidelity, input.targetPodSecurity, iso),
    warnings: [...warnings].slice(0, 50),
    timingsMs: { create: Math.round(timings.create), apply: Math.round(timings.apply), check: Math.round(timings.check), delete: Math.round(timings.delete) },
    deleted,
  });

  // ── 단계들 (kube = 가상 관리자) ──

  async function ssa(kube: KubeClient, path: string, obj: unknown, dryRunAll: boolean) {
    const r = await kube.call("PATCH", `${path}?fieldManager=${FIELD_MANAGER}&force=true${dryRunAll ? "&dryRun=All" : ""}`,
      { body: obj, contentType: "application/apply-patch+yaml" });
    note(r);
    return r;
  }
  function inNs(m: Manifest) { return { ...m.obj, metadata: { ...m.obj.metadata, namespace: ns } }; }

  // 앱 네임스페이스 (가상 안). enforce = 샌드박스 수준, warn·audit = restricted (경고만 모은다) + 원본에 필요한 CRD
  async function prepare(kube: VirtualAdminKube, original: Manifest[]) {
    const t0 = now();
    const nsObj = (n: string, level: string) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name: n, labels: {
      "pod-security.kubernetes.io/enforce": level, "pod-security.kubernetes.io/enforce-version": "latest",
      "pod-security.kubernetes.io/warn": "restricted", "pod-security.kubernetes.io/audit": "restricted" } } });
    const fails: string[] = [];
    const r = await ssa(kube, `/api/v1/namespaces/${ns}`, nsObj(ns, iso.podSecurity), false);
    if (!ok2xx(r.status)) fails.push(`네임스페이스 ${ns} (${r.status}): ${statusMessage(r)}`);
    const want = new Set(original.filter((m) => !m.info.applies).map((m) => `${m.obj.apiVersion.split("/")[0]}/${m.obj.kind}`));
    for (const key of want) {
      const crd = b.crds.find((c) => `${c?.spec?.group}/${c?.spec?.names?.kind}` === key);
      if (!crd) { fails.push(`CRD ${key} 가 이미지에 없음`); continue; }
      const path = `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${crd.metadata.name}`;
      const c = await ssa(kube, path, crd, false);
      if (!ok2xx(c.status)) { fails.push(`CRD ${key} (${c.status}): ${statusMessage(c)}`); continue; }
      const until = now() + T.crdMs;
      for (;;) {
        const g = await kube.call("GET", path);
        if ((g.body as any)?.status?.conditions?.some((x: any) => x.type === "Established" && x.status === "True")) break;
        if (now() >= until) { fails.push(`CRD ${key} Established 안 됨`); break; }
        await sleep(500);
      }
    }
    if (fails.length) {
      add("sandbox_ready", name, false, now() - t0, fails.join("; "));
      throw new Stop("REHEARSAL_SANDBOX_UNAVAILABLE");
    }
  }

  // 원본 그대로 (렌더 결과, 치환 전) 서버 dry-run. 실제 API 서버 구현이 판정한다
  async function dryRun(kube: VirtualAdminKube, original: Manifest[]): Promise<RehearsalFailureCode | null> {
    let failed = false;
    for (const m of original) {
      const t0 = now();
      const r = await ssa(kube, apiPath(m, ns, m.obj.metadata.name), inNs(m), true);
      failed = !add("dry_run", subjectOf(m), ok2xx(r.status), now() - t0, ok2xx(r.status) ? "서버 dry-run 통과" : `거부 (${r.status}): ${statusMessage(r)}`) || failed;
    }
    return failed ? "REHEARSAL_DRY_RUN_REJECTED" : null;
  }

  // 파드 틀마다 Pod 를 도착 수준 라벨 네임스페이스에 dry-run. PSA 만 보게 서비스 계정 칸은 뺀다 (없는 SA 거부를 막는다)
  async function targetPolicy(kube: VirtualAdminKube, original: Manifest[]): Promise<RehearsalFailureCode | null> {
    const level = input.targetPodSecurity;
    if (level === "privileged") { add("target_policy", "도착 파드 보안", true, 0, "도착 네임스페이스에 파드 보안 라벨 없음 (privileged)"); return null; }
    const r = await ssa(kube, `/api/v1/namespaces/${TARGET_POLICY_NS}`, { apiVersion: "v1", kind: "Namespace", metadata: { name: TARGET_POLICY_NS, labels: {
      "pod-security.kubernetes.io/enforce": level, "pod-security.kubernetes.io/enforce-version": "latest" } } }, false);
    if (!ok2xx(r.status)) { add("target_policy", TARGET_POLICY_NS, false, 0, `검사 네임스페이스 실패 (${r.status}): ${statusMessage(r)}`); return "REHEARSAL_SANDBOX_UNAVAILABLE"; }
    let code: RehearsalFailureCode | null = null;
    for (const [i, p] of podTemplates(original).entries()) {
      const t0 = now();
      const { serviceAccountName: _a, serviceAccount: _b, ...spec } = p.template.spec;
      const pod = { apiVersion: "v1", kind: "Pod", metadata: { name: `target-policy-${i}`, labels: p.template.metadata?.labels ?? {} }, spec: { ...spec, automountServiceAccountToken: false } };
      const d = await kube.call("POST", `/api/v1/namespaces/${TARGET_POLICY_NS}/pods?dryRun=All`, { body: pod });
      const msg = statusMessage(d);
      const ok = ok2xx(d.status);
      add("target_policy", subjectOf(p.owner), ok, now() - t0, ok ? `도착 ${level} 통과` : `거부 (${d.status}): ${msg}`);
      if (!ok) code ??= /PodSecurity/.test(msg) ? "REHEARSAL_TARGET_POLICY_DENIED" : "REHEARSAL_DRY_RUN_REJECTED";
    }
    return code;
  }

  // isDb: 플랫폼이 만든 DB 대체물. 거부되면 우리 쪽 문제다
  async function apply(kube: VirtualAdminKube, ms: Manifest[], isDb: boolean): Promise<RehearsalFailureCode | null> {
    let code: RehearsalFailureCode | null = null;
    for (const m of ms) {
      const t0 = now();
      const r = await ssa(kube, apiPath(m, ns, m.obj.metadata.name), inNs(m), false);
      const ok = ok2xx(r.status);
      const msg = statusMessage(r);
      add("apply", subjectOf(m), ok, now() - t0, `${ok ? "적용함" : `거부 (${r.status}): ${msg}`}${isDb ? " (샌드박스 DB 대체물)" : ""}`);
      if (!ok) code ??= isDb || /exceeded quota/i.test(msg) ? "REHEARSAL_SANDBOX_UNAVAILABLE" : "REHEARSAL_DRY_RUN_REJECTED";
    }
    return code;
  }

  // 롤아웃·잡을 한 고리에서 같이 기다린다 (마이그레이션 잡이 앱 준비보다 먼저 끝나야 할 수 있다)
  async function converge(kube: VirtualAdminKube, ms: Manifest[], isDb: boolean): Promise<RehearsalFailureCode | null> {
    const t0 = now();
    const cap = (sec: unknown, dflt: number) => Math.min(Number(sec) > 0 ? Number(sec) * 1000 : dflt, 600_000);
    const items = ms.filter((m) => m.info.wait !== null).map((m) => ({
      m, deadline: t0 + (isDb ? T.dbMs : m.info.wait === "job" ? cap(m.obj.spec?.activeDeadlineSeconds, T.jobMs) : cap(m.obj.spec?.progressDeadlineSeconds, T.rolloutMs)),
      done: null as null | { code: RehearsalFailureCode | null; detail: string; ms: number },
    }));
    while (items.some((w) => !w.done)) {
      const [pods, events] = await Promise.all([listPods(kube), listEvents(kube)]);
      for (const w of items.filter((x) => !x.done)) {
        const live = (await kube.call("GET", apiPath(w.m, ns, w.m.obj.metadata.name))).body as any;
        const mine = pods.filter((p) => matches(live?.spec?.selector?.matchLabels, p.metadata?.labels));
        const evidence = { pods: mine, events: events.filter((e) => relatedEvent(e, w.m.obj.metadata.name)) };
        const state = w.m.info.wait === "job" ? jobState(live) : rolloutState(live);
        if (state === "done") { w.done = { code: null, detail: w.m.info.wait === "job" ? "Complete" : `준비 ${live?.status?.readyReplicas ?? 0}/${live?.spec?.replicas ?? 1}`, ms: now() - t0 }; continue; }
        const diag = diagnose(evidence);
        const expired = now() >= w.deadline;
        if (state === "failed" || diag?.terminal || expired) {
          const fallback: RehearsalFailureCode = w.m.info.wait === "job" ? "REHEARSAL_JOB_FAILED" : "REHEARSAL_ROLLOUT_FAILED";
          let code = diag?.code ?? fallback;
          if (w.m.info.wait === "job" && code === "REHEARSAL_CRASHLOOP") code = "REHEARSAL_JOB_FAILED";
          if (isDb && REHEARSAL_FAILURE_CLASS[code] === "would_fail") code = "REHEARSAL_SANDBOX_UNAVAILABLE";
          w.done = { code, detail: `${state === "failed" ? "Failed" : expired ? `${Math.round((w.deadline - t0) / 1000)}초 안에 안 끝남` : "멈춤"}${diag ? `: ${diag.detail}` : ""}`, ms: now() - t0 };
        }
      }
      if (items.some((w) => !w.done)) await sleep(T.pollMs);
    }
    let code: RehearsalFailureCode | null = null;
    for (const w of items) {
      add(w.m.info.wait === "job" ? "job_complete" : "rollout", subjectOf(w.m), w.done!.code === null, w.done!.ms, `${w.done!.detail}${isDb ? " (샌드박스 DB 대체물)" : ""}`);
      code ??= w.done!.code;
    }
    return code;
  }

  // 롤아웃 뒤 관찰 창 동안 재시작이 늘었나 (k3d 구현과 같은 셈법: 파드마다 restartCount 차이)
  async function restarts(kube: VirtualAdminKube, ms: Manifest[], db: Manifest[]): Promise<RehearsalFailureCode | null> {
    const rollouts = ms.filter((m) => m.info.wait === "rollout");
    if (!rollouts.length) return null;
    const t0 = now();
    const before = new Map((await listPods(kube)).map((p) => [String(p.metadata?.name), restartsOf(p)]));
    await sleep(T.restartWindowMs);
    const after = await listPods(kube);
    let code: RehearsalFailureCode | null = null;
    for (const m of rollouts) {
      const mine = after.filter((p) => matches(m.obj.spec?.selector?.matchLabels, p.metadata?.labels));
      const delta = mine.reduce((n, p) => n + Math.max(0, restartsOf(p) - (before.get(String(p.metadata?.name)) ?? 0)), 0);
      const why = [...new Set(mine.flatMap((p) => (p.status?.containerStatuses ?? []).map((c: any) => c.lastState?.terminated?.reason ?? c.state?.waiting?.reason).filter(Boolean)))];
      const ok = add("restarts", subjectOf(m), delta === 0, now() - t0, `${Math.round(T.restartWindowMs / 1000)}초 관찰: 재시작 +${delta}${why.length ? `, 이유 ${why.join(", ")}` : ""}${db.includes(m) ? " (샌드박스 DB 대체물)" : ""}`);
      if (!ok) code ??= db.includes(m) ? "REHEARSAL_SANDBOX_UNAVAILABLE" : "REHEARSAL_CRASHLOOP";
    }
    return code;
  }

  async function ready(kube: VirtualAdminKube, ms: Manifest[], db: Manifest[]): Promise<RehearsalFailureCode | null> {
    const pods = await listPods(kube);
    let code: RehearsalFailureCode | null = null;
    for (const m of ms.filter((x) => x.info.wait === "rollout")) {
      const mine = pods.filter((p) => matches(m.obj.spec?.selector?.matchLabels, p.metadata?.labels));
      const readyN = mine.filter(podReady).length;
      const ok = add("ready", subjectOf(m), mine.length > 0 && readyN === mine.length, 0, `Ready ${readyN}/${mine.length}${db.includes(m) ? " (샌드박스 DB 대체물)" : ""}`);
      if (!ok) code ??= db.includes(m) ? "REHEARSAL_SANDBOX_UNAVAILABLE" : "REHEARSAL_NOT_READY";
    }
    return code;
  }

  // 검사 파드 하나에서 Service 마다, 그리고 워커가 찾은 연결(edges)마다 요청 한 번. 4xx 도 "닿았다"로 본다
  async function connectivity(kube: VirtualAdminKube, ms: Manifest[]): Promise<RehearsalFailureCode | null> {
    const targets = probeTargets(ms);
    if (!targets.length) return null;
    const t0 = now();
    const env = targets.map((x, i) => ({ name: `T${i}`, value: x.url }));
    const script = targets.map((_, i) => `c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$T${i}"); echo "probe ${i} $? $c"`).join("; ");
    const pod = {
      apiVersion: "v1", kind: "Pod", metadata: { name: PROBE_POD, labels: { "app.kubernetes.io/name": PROBE_POD } },
      spec: {
        restartPolicy: "Never", automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 100, runAsGroup: 101, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{
          name: "probe", image: b.probeImage ?? PROBE_IMAGE, command: ["sh", "-c", script], env, resources: PROBE_RESOURCES,
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        }],
      },
    };
    const c = await kube.call("POST", `/api/v1/namespaces/${ns}/pods`, { body: pod });
    if (!ok2xx(c.status)) { add("service_http", PROBE_POD, false, now() - t0, `검사 파드 만들기 실패 (${c.status}): ${statusMessage(c)}`); return "REHEARSAL_SANDBOX_UNAVAILABLE"; }
    const until = now() + T.probeMs;
    let phaseNow = "";
    for (;;) {
      const p = (await kube.call("GET", `/api/v1/namespaces/${ns}/pods/${PROBE_POD}`)).body as any;
      phaseNow = String(p?.status?.phase ?? "");
      if (phaseNow === "Succeeded" || phaseNow === "Failed") break;
      if (now() >= until) { add("service_http", PROBE_POD, false, now() - t0, `검사 파드가 ${Math.round(T.probeMs / 1000)}초 안에 안 끝남 (${phaseNow || "?"})`); return "REHEARSAL_SANDBOX_UNAVAILABLE"; }
      await sleep(T.pollMs);
    }
    const log = (await kube.call("GET", `/api/v1/namespaces/${ns}/pods/${PROBE_POD}/log`)).text;
    const seen = new Map<number, { exit: number; code: string }>();
    for (const line of log.split("\n")) {
      const m = /^probe (\d+) (\d+) (\d{3})/.exec(line.trim());
      if (m) seen.set(Number(m[1]), { exit: Number(m[2]), code: m[3]! });
    }
    let failed = false;
    for (const [i, x] of targets.entries()) {
      const s = seen.get(i);
      // HTTP: 응답 받고 5xx 아님. TCP(HTTP 프로브가 없는 포트): 연결됨 = 이름 풀기(6)·연결(7)·시간 초과(28) 실패가 아님
      const ok = !!s && (x.http ? s.exit === 0 && Number(s.code) < 500 : ![6, 7, 28].includes(s.exit));
      const detail = !s ? "결과 없음" : x.http ? `${x.url} → HTTP ${s.code} (curl ${s.exit})` : `${x.url} → TCP ${ok ? "연결됨" : `실패 (curl ${s.exit})`}`;
      failed = !add(x.id, x.subject, ok, now() - t0, detail) || failed;
    }
    return failed ? "REHEARSAL_CONNECTIVITY_FAILED" : null;
  }

  function probeTargets(ms: Manifest[]): Array<{ id: "service_http" | "edge_http"; subject: string; url: string; http: boolean }> {
    const workloads = podTemplates(ms).filter((p) => p.owner.info.wait === "rollout");
    const services = ms.filter((m) => m.obj.kind === "Service");
    // 포트의 HTTP 경로: 그 포트를 받는 컨테이너의 readiness(없으면 liveness) httpGet
    const httpPath = (svc: Manifest, port: any): string | null => {
      const sel = svc.obj.spec?.selector ?? {};
      for (const w of workloads) {
        if (!matches(sel, w.template.metadata?.labels)) continue;
        for (const ctr of w.template.spec.containers ?? []) {
          const cp = (ctr.ports ?? []).find((p: any) => p.containerPort === port.targetPort || p.name === port.targetPort || (port.targetPort === undefined && p.containerPort === port.port));
          if (!cp) continue;
          const probe = ctr.readinessProbe?.httpGet ?? ctr.livenessProbe?.httpGet;
          if (probe && (probe.port === cp.containerPort || probe.port === cp.name)) return String(probe.path ?? "/");
        }
      }
      return null;
    };
    const backed = (svc: Manifest) => workloads.some((w) => matches(svc.obj.spec?.selector ?? {}, w.template.metadata?.labels));
    const out: Array<{ id: "service_http" | "edge_http"; subject: string; url: string; http: boolean }> = [];
    for (const svc of services) {
      if (!backed(svc)) { add("service_http", subjectOf(svc), true, 0, "고르는 워크로드가 적용 묶음에 없어 건너뜀", false); continue; }
      for (const port of svc.obj.spec?.ports ?? []) {
        const path = httpPath(svc, port);
        out.push({ id: "service_http", subject: `Service/${svc.obj.metadata.name}:${port.port}`, url: `http://${svc.obj.metadata.name}:${port.port}${path ?? "/"}`, http: path !== null });
      }
    }
    for (const e of input.edges) {
      const svc = services.find((s) => s.obj.metadata.name === e.host.split(".")[0]);
      const port = svc?.obj.spec?.ports?.find((p: any) => p.port === e.port);
      const path = svc && port ? httpPath(svc, port) : null;
      out.push({ id: "edge_http", subject: `${e.from}→${e.host}:${e.port}`, url: `http://${e.host}:${e.port}${path ?? "/"}`, http: path !== null });
    }
    return out;
  }

  async function listPods(kube: KubeClient): Promise<any[]> {
    const r = await kube.call("GET", `/api/v1/namespaces/${ns}/pods`);
    return ok2xx(r.status) ? ((r.body as any)?.items ?? []).filter((p: any) => p.metadata?.name !== PROBE_POD) : [];
  }
  async function listEvents(kube: KubeClient): Promise<any[]> {
    const r = await kube.call("GET", `/api/v1/namespaces/${ns}/events`);
    return ok2xx(r.status) ? ((r.body as any)?.items ?? []) : [];
  }
}

// ── 판정 재료 (순수) ──
const matches = (sel: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!sel && Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels?.[k] === v);
const restartsOf = (p: any) => (p.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
const podReady = (p: any) => (p.status?.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True");
const relatedEvent = (e: any, name: string) => {
  const n = String(e.involvedObject?.name ?? "");
  return n === name || n.startsWith(`${name}-`);
};
function rolloutState(o: any): "done" | "pending" {
  const want = o?.spec?.replicas ?? 1;
  const s = o?.status ?? {};
  return (s.observedGeneration ?? 0) >= (o?.metadata?.generation ?? 1) && (s.readyReplicas ?? 0) >= want
    && (s.updatedReplicas ?? s.currentReplicas ?? 0) >= want ? "done" : "pending";
}
function jobState(o: any): "done" | "failed" | "pending" {
  const c = o?.status?.conditions ?? [];
  if (c.some((x: any) => x.type === "Complete" && x.status === "True")) return "done";
  if (c.some((x: any) => x.type === "Failed" && x.status === "True")) return "failed";
  return "pending";
}

// 멈춘 워크로드의 이유. 위에서부터 처음 맞는 줄. terminal 이면 기한을 기다리지 않고 바로 끝낸다
//   샌드박스만의 규칙(가상 PSA, 호스트 VAP)은 앱 고장이 아니라 "보증 못 함", 자원·스케줄은 우리 쪽, 이미지 받기는 복사 문제
export interface Evidence { pods: any[]; events: any[] }
const waitingReasons = (p: any): string[] => [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])]
  .map((c: any) => c.state?.waiting?.reason).filter(Boolean);
export const DIAGNOSES: ReadonlyArray<{ code: RehearsalFailureCode; find(e: Evidence): { detail: string; terminal: boolean } | null }> = [
  { code: "REHEARSAL_POLICY_DENIED", find: (e) => {
    const ev = e.events.find((x) => (x.reason === "FailedCreate" && /PodSecurity/.test(x.message ?? "")) || (/sync/i.test(x.reason ?? "") && /denied|forbidden/i.test(x.message ?? "")));
    return ev ? { detail: `${ev.reason}: ${ev.message}`, terminal: true } : null;
  } },
  { code: "REHEARSAL_SANDBOX_UNAVAILABLE", find: (e) => {
    const ev = e.events.find((x) => x.reason === "FailedCreate" && /exceeded quota/i.test(x.message ?? ""));
    if (ev) return { detail: `샌드박스 상한: ${ev.message}`, terminal: false };
    const p = e.pods.find((x) => (x.status?.conditions ?? []).some((c: any) => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable"));
    return p ? { detail: `sandbox 노드에 자리가 없음: ${(p.status.conditions.find((c: any) => c.type === "PodScheduled")?.message ?? "").slice(0, 200)}`, terminal: false } : null;
  } },
  { code: "REHEARSAL_IMAGE_MIRROR_FAILED", find: (e) => {
    const p = e.pods.find((x) => waitingReasons(x).some((r) => /ImagePullBackOff|ErrImagePull|InvalidImageName/.test(r)));
    if (!p) return null;
    const why = waitingReasons(p).find((r) => /Image/.test(r))!;
    return { detail: `${p.metadata?.name}: ${why}`, terminal: why !== "ErrImagePull" };
  } },
  // 컨테이너를 만들 수조차 없음 (없는 Secret 키, 이름뿐인 USER 로 runAsNonRoot 확인 불가 등). 기다려도 안 풀린다 (kind 실측)
  { code: "REHEARSAL_ROLLOUT_FAILED", find: (e) => {
    const p = e.pods.find((x) => waitingReasons(x).some((r) => /CreateContainerConfigError|CreateContainerError|RunContainerError/.test(r)));
    if (!p) return null;
    const c = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])].find((x: any) => /Create|Run/.test(x.state?.waiting?.reason ?? ""));
    return { detail: `${p.metadata?.name}: ${c?.state?.waiting?.reason}: ${String(c?.state?.waiting?.message ?? "").slice(0, 200)}`, terminal: true };
  } },
  { code: "REHEARSAL_CRASHLOOP", find: (e) => {
    const p = e.pods.find((x) => restartsOf(x) > 0 || waitingReasons(x).includes("CrashLoopBackOff"));
    if (!p) return null;
    const last = (p.status?.containerStatuses ?? []).map((c: any) => c.lastState?.terminated?.reason).find(Boolean);
    return { detail: `${p.metadata?.name}: 재시작 ${restartsOf(p)}${last ? ` (${last})` : ""}`, terminal: restartsOf(p) >= 2 };
  } },
];
export function diagnose(e: Evidence): { code: RehearsalFailureCode; detail: string; terminal: boolean } | null {
  for (const d of DIAGNOSES) { const hit = d.find(e); if (hit) return { code: d.code, ...hit }; }
  return null;
}
