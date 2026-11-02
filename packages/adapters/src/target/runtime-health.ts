import type { AppSpecV2, Provider, TfOutputs } from "@svc/contracts";
import { arr, get, runJson, str, type CliDeps } from "../common/cli.js";
import { regionOf, type Target as Tgt } from "../common/target.js";
import { managedServicesOf, vmServicesOf } from "./shared.js";

// DEPLOYNONK8S DRAFT(ai): Terraform 이 앱까지 띄우는 도착(관리형 ECS·Cloud Run / VM EC2·GCE)의 배포 확인.
//   이 도착엔 Helm 워크로드가 0개라 gitops·Argo 를 거치지 않는다. 대신 apply 출력(서비스 이름·인스턴스 목록)을 읽고,
//   live=true 면 읽기 CLI 로 실제 상태를 본다 (쓰기 0, 셸 없음, 자격 증명은 프로세스 env — 코드에 없음). 명령은 관찰 권한 표(observe-permissions.ts)에 있다.
//     ECS: aws ecs describe-services → status ACTIVE·desiredCount ≥ 1·runningCount ≥ desiredCount
//     Cloud Run: gcloud run services describe → conditions Ready=True
//     VM: EC2 describe-instance-status → running / GCE compute instances list → RUNNING
//   STUB: VM 앱 자체의 헬스 URL(HTTP 200)은 아직 안 본다 — 인스턴스는 사설 IP 뿐이고 앞단(로드밸런서)이 없다 (RUNTIMEMAP v2 TODO(human))
//   한 명세 안의 섞임(k8s + 비k8s)은 managedBlockers·vmBlockers 가 계획 전에 막는다고 가정한다.
//   막 apply 한 직후라 아직 뜨는 중일 수 있어 attempts 번까지 interval 초 간격으로 다시 본다 (DRAFT(ai): 20번 × 15초 = 5분)

export type TerraformRuntime = "managedContainer" | "vm";

/** 이 명세가 Terraform 이 앱까지 띄우는 도착이면 그 실행 방식, k8s(Helm) 면 null */
export function terraformRuntimeOf(spec: AppSpecV2 | null | undefined): TerraformRuntime | null {
  if (!spec) return null;
  if (managedServicesOf(spec).length) return "managedContainer";
  if (vmServicesOf(spec).length) return "vm";
  return null;
}

export type RuntimeHealthCode = "RUNTIME_OUTPUT_MISSING" | "RUNTIME_UNHEALTHY" | "RUNTIME_CHECK_FAILED";
export type RuntimeHealth =
  | { ok: true; resources: string[]; checked: "outputs" | "live"; attempts: number }
  | { ok: false; code: RuntimeHealthCode; reason: string; resources: string[]; attempts: number };

export interface RuntimeHealthInput {
  provider: Provider;
  runtime: TerraformRuntime;
  spec: AppSpecV2;
  tfOutputs: TfOutputs;
  /** false = 출력만 본다 (흉내 길 MOCK_IAC). true = 읽기 CLI 로 실제 상태까지 */
  live: boolean;
  /** 없으면 Builder 와 같은 규칙(regionOf: "default" → 서울) — 루트 변수 region 과 같은 값 */
  region?: string;
  projectId?: string | null;
}
export interface RuntimeHealthDeps extends CliDeps {
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const mapOut = (out: TfOutputs, k: string): Record<string, unknown> => {
  const v = out[k];
  if (!v) return {};
  try { const o = JSON.parse(v); return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : {}; } catch { return {}; }
};
const listOf = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.length > 0) : []);
const cut = (s: string) => s.slice(0, 300);

interface Target { id: string; kind: string; names: string[] }

/** 출력에서 확인할 대상(서비스 이름·인스턴스 목록)을 뽑는다. 빠진 출력은 missing */
function targetsOf(i: RuntimeHealthInput): { targets: Target[]; missing: string[] } {
  const out = i.tfOutputs, missing: string[] = [], targets: Target[] = [];
  if (i.runtime === "managedContainer") {
    const names = mapOut(out, "service_names");
    for (const s of managedServicesOf(i.spec)) {
      const n = out[`service.${s.id}.name`] ?? str(names[s.id]);
      if (!n) missing.push(`service.${s.id}.name`);
      else targets.push({ id: s.id, kind: i.provider === "aws" ? "EcsService" : "CloudRunService", names: [n] });
    }
    if (i.provider === "aws" && i.live && !out.ecs_cluster_name) missing.push("ecs_cluster_name");
  } else {
    const key = i.provider === "aws" ? "vm_instance_ids" : "vm_instance_names";
    const m = mapOut(out, key);
    for (const v of vmServicesOf(i.spec)) {
      const ns = listOf(m[v.id]);
      if (!ns.length) missing.push(`${key}.${v.id}`);
      else targets.push({ id: v.id, kind: i.provider === "aws" ? "Ec2Instance" : "GceInstance", names: ns });
    }
  }
  return { targets, missing };
}

/** 한 번 보기: 건강하지 않은 대상 설명 목록 (빈 배열 = 다 건강) */
async function probe(i: RuntimeHealthInput, targets: Target[], d: CliDeps): Promise<string[]> {
  const bad: string[] = [];
  if (i.runtime === "managedContainer" && i.provider === "aws") {
    const names = targets.flatMap((t) => t.names);
    const r = await runJson(d, "aws", ["ecs", "describe-services", "--cluster", i.tfOutputs.ecs_cluster_name!, "--services", ...names, "--region", i.region!, "--output", "json"]);
    const svcs = arr(get(r, "services"));
    for (const n of names) {
      const s = svcs.find((x) => x.serviceName === n);
      const want = Number(s?.desiredCount ?? 0), run = Number(s?.runningCount ?? 0);
      if (!s) bad.push(`${n}: 서비스 없음`);
      else if (s.status !== "ACTIVE" || want < 1 || run < want) bad.push(`${n}: status ${String(s.status)} running ${run}/${want}`);
    }
  } else if (i.runtime === "managedContainer") {
    for (const n of targets.flatMap((t) => t.names)) {
      const r = await runJson(d, "gcloud", ["run", "services", "describe", n, "--region", i.region!, ...(i.projectId ? ["--project", i.projectId] : []), "--format", "json"]);
      const ready = arr(get(r, "status", "conditions")).find((c) => c.type === "Ready");
      if (ready?.status !== "True") bad.push(`${n}: Ready ${String(ready?.status ?? "없음")}${ready?.reason ? ` (${String(ready.reason)})` : ""}`);
    }
  } else if (i.provider === "aws") {
    const ids = targets.flatMap((t) => t.names);
    const r = await runJson(d, "aws", ["ec2", "describe-instance-status", "--instance-ids", ...ids, "--include-all-instances", "--region", i.region!, "--output", "json"]);
    const st = arr(get(r, "InstanceStatuses"));
    for (const id of ids) {
      const s = st.find((x) => x.InstanceId === id);
      const state = str(get(s, "InstanceState", "Name"));
      if (state !== "running") bad.push(`${id}: ${state ?? "없음"}`);
    }
  } else {
    const names = targets.flatMap((t) => t.names);
    const r = await runJson(d, "gcloud", ["compute", "instances", "list", "--filter", `name:(${names.join(" ")})`, ...(i.projectId ? ["--project", i.projectId] : []), "--format", "json"]);
    const list = arr(r);
    for (const n of names) {
      const s = list.find((x) => x.name === n);
      if (s?.status !== "RUNNING") bad.push(`${n}: ${String(s?.status ?? "없음")}`);
    }
  }
  return bad;
}

export async function checkTerraformRuntime(i: RuntimeHealthInput, d: RuntimeHealthDeps = {}): Promise<RuntimeHealth> {
  i = { ...i, region: i.region ?? regionOf({ provider: i.provider, region: "default" } as Tgt) };
  const { targets, missing } = targetsOf(i);
  const resources = targets.flatMap((t) => t.names.map((n) => `${t.kind}/${t.id}/${n}`)).sort();
  if (missing.length)
    return { ok: false, code: "RUNTIME_OUTPUT_MISSING", reason: cut(`apply 출력에 없음: ${missing.sort().join(", ")}`), resources, attempts: 0 };
  if (!i.live) return { ok: true, resources, checked: "outputs", attempts: 0 };
  const attempts = Math.max(1, d.attempts ?? 20), interval = d.intervalMs ?? 15_000;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: string[] = [];
  for (let n = 1; n <= attempts; n++) {
    try { last = await probe(i, targets, d); }
    catch (e) { return { ok: false, code: "RUNTIME_CHECK_FAILED", reason: cut((e as Error).message), resources, attempts: n }; }
    if (!last.length) return { ok: true, resources, checked: "live", attempts: n };
    if (n < attempts) await sleep(interval);
  }
  return { ok: false, code: "RUNTIME_UNHEALTHY", reason: cut(`${attempts}번 봐도 안 뜸: ${last.join("; ")}`), resources, attempts };
}
