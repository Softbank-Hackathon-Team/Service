import type { AccuracyField, ImportAccuracy, ImportResultV2, RawInventory } from "@svc/contracts";
import { cpuMilliOf, mibOf, probeOf } from "./mappers/k8s-deployment.js";
import { cronOf } from "./mappers/k8s-cronjob.js";
import { mainContainer } from "./mappers/ecs-service.js";
import { CLOUDRUN_RAW_KINDS, type RawCloudRunJob, type RawCloudRunService } from "./raw-cloudrun.js";
import { ECS_RAW_KIND, type RawEcsService } from "./raw-ecs.js";
import { VM_RAW_KIND, type RawVmGroup } from "./raw-vm.js";
import { fromK8sProbe } from "../target/k8s-probe.js";
import { DB_RAW_KINDS, K8S_RAW_KINDS, type RawK8sCronJob, type RawK8sDeployment, type RawK8sHpa } from "./raw-k8s.js";

// DRAFT(ai): 가져오기 정확도 % (ALIGN-v2 IR-10, 설계 20번 5.6장 "되돌려 그리기"의 숫자 버전).
//   순수 함수: 네트워크·환경변수·시계를 안 쓴다. 같은 입력이면 같은 출력.
//   "원본에서 읽은 것만" 비교한다: 원본에 칸이 없으면 칸 자체를 안 만들고, 읽었지만 값이 모호하면 비교 불가(분모에서 뺌).
//   환경변수는 이름만 비교한다 (값은 어디에도 안 담음). 비밀은 이름이 있는지만 본다.
//   G3b-6: 기준은 매퍼가 쓴 바로 그 원본이다 (출발을 다시 읽지 않음) → 매퍼·discover 가 같은 값을 잘못 읽으면 "일치"로 나온다.
//     그래서 숫자 옆에 비교한 칸·안 본 칸 목록(compared·notCompared)을 같이 싣는다. 출발을 다시 읽는 비교는 TODO(human): X-1 지문과 같이
//   k8s 워크로드·CronJob·관리형 Postgres + ECS 서비스·Cloud Run 서비스/잡·VM 묶음 (원본에서 다시 읽어 같은 칸을 맞춘다).

type Rendered = { workloads?: unknown[] } | null | undefined;
export interface MeasureInput { inventory: RawInventory; result: ImportResultV2; rendered?: Rendered }

/** 도착 쪽에서 본 한 워크로드 (렌더 결과 또는 공통 명세 props 에서 뽑는다) */
interface TargetView {
  digest: string | null; ports: number[]; envNames: string[]; replicas: { min: number; max: number } | null;
  cpuMilli: number | null; memMiB: number | null;
  probes: Record<string, ProbeView | undefined>;
  command: string[] | null; schedule: string | null;
  // G3b-6: 더 보는 칸
  args: string[] | null; cpuLimit: number | null; memLimit: number | null; extraContainers: number;
}
type ProbeView = { type?: string; path?: string; port?: string; periodSec?: number; failureThreshold?: number; initialDelaySec?: number };
type Obj = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const probeView = (p: Obj | undefined): ProbeView | undefined => (p ? { type: p.type, path: p.path, port: p.port == null ? undefined : String(p.port),
  periodSec: num(p.periodSec) ?? undefined, failureThreshold: num(p.failureThreshold) ?? undefined, initialDelaySec: num(p.initialDelaySec) ?? undefined } : undefined);
// PB-1: 렌더 값의 프로브는 이제 k8s 모양(httpGet·tcpSocket·grpc·exec + …Seconds) → 비교용 IR 모양으로 되돌림
const renderProbeView = (p: Obj | undefined): ProbeView | undefined => {
  if (!p) return undefined;
  const k = p.httpGet ? { type: "http", path: p.httpGet.path, port: p.httpGet.port } : p.tcpSocket ? { type: "tcp", port: p.tcpSocket.port }
    : p.grpc ? { type: "grpc", port: p.grpc.port } : p.exec ? { type: "exec" } : { type: p.type, path: p.path, port: p.port };
  return probeView({ ...k, periodSec: p.periodSeconds ?? p.periodSec, failureThreshold: p.failureThreshold, initialDelaySec: p.initialDelaySeconds ?? p.initialDelaySec });
};
const digestOfRef = (ref: unknown): string | null => { const s = typeof ref === "string" ? ref : ""; const at = s.indexOf("@"); return at >= 0 ? s.slice(at + 1) : null; };

// PB-1: 차트 k8s 프로브 → 비교 모양 (G3b-6 시간 칸 포함)
const k8sProbeView = (p: Obj | undefined): ProbeView | undefined => {
  const b = fromK8sProbe(p);
  return b && p ? { ...b, periodSec: num(p.periodSeconds) ?? undefined, failureThreshold: num(p.failureThreshold) ?? undefined, initialDelaySec: num(p.initialDelaySeconds) ?? undefined } : undefined;
};
// PB-1: 렌더 결과 = 차트 값(ChartValues) 모양. name·image 글자·containerPort·k8s 프로브·replicas|scale·job.schedule
function viewFromRender(w: Obj, injected: number): TargetView {
  const pr = w.probes ?? {};
  const req = w.resources?.requests ?? {}, lim = w.resources?.limits ?? {};
  return {
    digest: digestOfRef(w.image),
    ports: ((w.ports ?? []) as Obj[]).map((p) => num(p.containerPort)).filter((x): x is number => x != null),
    envNames: ((w.env ?? []) as Obj[]).map((e) => String(e.name)),
    replicas: w.scale ? { min: w.scale.min, max: w.scale.max } : num(w.replicas) != null ? { min: w.replicas, max: w.replicas } : null,
    cpuMilli: req.cpu != null ? cpuMilliOf(req.cpu) : null, memMiB: req.memory != null ? mibOf(req.memory) : null,
    probes: { readiness: k8sProbeView(pr.readiness), liveness: k8sProbeView(pr.liveness), startup: k8sProbeView(pr.startup) },
    command: strArr(w.command), schedule: typeof w.job?.schedule === "string" ? w.job.schedule : null,
    args: strArr(w.args), cpuLimit: lim.cpu != null ? cpuMilliOf(lim.cpu) : null, memLimit: lim.memory != null ? mibOf(lim.memory) : null,
    // 렌더는 메시 주입 사이드카(injected)를 안 그린다 (도착 메시가 다시 넣음) → 명세에서 센 수를 더한다
    extraContainers: ((w.sidecars ?? []) as unknown[]).length + ((w.initContainers ?? []) as unknown[]).length + injected,
  };
}
function viewFromSpec(p: Obj): TargetView {
  const req = p.resources?.request ?? {}, lim = p.resources?.limit ?? {};
  return {
    digest: typeof p.image?.digest === "string" ? p.image.digest : null,
    ports: ((p.ports ?? []) as Obj[]).map((x) => num(x.port)).filter((x): x is number => x != null),
    envNames: ((p.env ?? []) as Obj[]).map((e) => String(e.name)),
    replicas: p.replicas ? { min: p.replicas.min, max: p.replicas.max } : null,
    cpuMilli: num(req.cpuMilli), memMiB: num(req.memMiB),
    probes: { readiness: probeView(p.probes?.readiness), liveness: probeView(p.probes?.liveness), startup: probeView(p.probes?.startup) },
    command: strArr(p.command), schedule: typeof p.schedule === "string" ? p.schedule : null,
    args: strArr(p.args), cpuLimit: num(lim.cpuMilli), memLimit: num(lim.memMiB),
    extraContainers: ((p.sidecars ?? []) as unknown[]).length + ((p.initContainers ?? []) as unknown[]).length,
  };
}

// G3b-6 DRAFT(ai): 숫자 옆에 싣는 "비교한 칸"·"안 본 칸" 목록. 안 본 칸이 많을수록 % 가 이식 정도를 덜 말한다
export const ACCURACY_COMPARED = ["image.digest", "env.names", "resources.cpu", "resources.memory", "resources.cpuLimit", "resources.memoryLimit",
  "command", "args", "ports", "replicas", "probes.readiness", "probes.liveness", "probes.startup", "containers.extra", "schedule", "db.version", "db.storageGb"] as const;
export const ACCURACY_NOT_COMPARED = ["env.values", "secretMounts", "volumes", "configs", "securityContext", "scheduling", "probes.timeoutSeconds",
  "sidecars.fields", "links", "entry", "posture", "db.selection", "data-resources", "ecs·cloudRun·vm 워크로드"] as const;

const list = (a: Array<string | number>) => (a.length ? a.join(",") : "없음");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function measureImportAccuracy(input: MeasureInput): ImportAccuracy {
  const { inventory, result } = input;
  const items = inventory.items as Obj[];
  const comps = new Map(result.spec.components.map((c) => [c.id, c as Obj]));
  const basis: ImportAccuracy["basis"] = input.rendered ? "render" : "spec";
  const renderedBy = new Map<string, Obj>(((input.rendered?.workloads ?? []) as Obj[]).map((w) => [String(w.name), w]));
  const fields: AccuracyField[] = [];
  const add = (component: string, field: string, result: AccuracyField["result"], detail?: string) =>
    fields.push({ component, field, result, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  const cmp = (component: string, field: string, ok: boolean, detail: string) => add(component, field, ok ? "match" : "mismatch", ok ? undefined : detail);

  // VACCURACY 고침: 벤더 고유 ID(ARN·selfLink)가 있는 자원은 ids 열쇠가 그 값이다 (normalizeV2 nativeKey = native.uid ?? …)
  const idOf = (kind: string, ns: string | undefined, name: string, uid?: string | null): string | null => {
    if (uid && result.ids[uid]) return result.ids[uid]!;
    const keys = Object.keys(result.ids);
    const exact = `${kind}//${ns ?? ""}/${name}`;
    const k = keys.includes(exact) ? exact : keys.find((x) => x.startsWith(`${kind}/`) && x.endsWith(`/${ns ?? ""}/${name}`)) ?? keys.find((x) => x.startsWith(`${kind}/`) && x.endsWith(`/${name}`));
    return k ? result.ids[k] ?? null : null;
  };
  const hpas = items.filter((i) => i.kind === K8S_RAW_KINDS.hpa) as RawK8sHpa[];

  const viewOf = (id: string): TargetView | null => {
    const c = comps.get(id);
    if (input.rendered) {
      const w = renderedBy.get(id);
      const injected = (((c?.props as Obj | undefined)?.sidecars ?? []) as Obj[]).filter((x) => x.injected).length;
      return w ? viewFromRender(w, injected) : null;
    }
    return c ? viewFromSpec(c.props as Obj) : null;
  };

  for (const it of items) {
    if (it.kind === K8S_RAW_KINDS.deployment || it.kind === K8S_RAW_KINDS.cronjob) {
      const isJob = it.kind === K8S_RAW_KINDS.cronjob;
      const dep = it as RawK8sDeployment, cj = it as RawK8sCronJob;
      const meta = it.metadata as { name: string; namespace?: string };
      const id = idOf(it.kind, meta.namespace, meta.name);
      if (!id) continue;   // 부품으로 안 올라간 것(unmapped)은 정확도 대상이 아니다 (unmapped 목록이 따로 말한다)
      // G3b-6: 앱 묶음·경계 밖으로 뺀 워크로드(ids 에는 있고 명세에는 없음)는 대상이 아니다 (outOfBoundary 목록이 따로 말한다)
      if (!comps.has(id)) continue;
      const pod = isJob ? cj.spec.jobTemplate.spec.template.spec : dep.spec.template.spec;
      const c = pod.containers[0];
      if (!c) continue;
      const t = viewOf(id);
      if (!t) { add(id, "workload", "mismatch", "원본에 있는데 도착 렌더 결과에 없음"); continue; }

      const srcDigest = it.imageDigest ?? (c.image.includes("@") ? c.image.slice(c.image.indexOf("@") + 1) : null);
      if (!srcDigest) add(id, "image.digest", "unverifiable", "원본에서 이미지 digest 를 못 읽음");
      else cmp(id, "image.digest", t.digest === srcDigest, t.digest ? "이미지 digest 가 원본과 다름" : "도착에 이미지 digest 없음");

      const envNames = (c.env ?? []).map((e) => e.name);
      if (envNames.length) {
        const missing = envNames.filter((n) => !t.envNames.includes(n));
        cmp(id, "env.names", missing.length === 0, `도착에 없는 환경변수 이름: ${list(missing)}`);
      }
      const req = c.resources?.requests;
      if (req?.cpu != null) {
        const s = cpuMilliOf(req.cpu);
        if (s == null) add(id, "resources.cpu", "unverifiable", "원본 cpu 수량을 못 읽음");
        else cmp(id, "resources.cpu", t.cpuMilli === s, `cpu requests 원본 ${s}m / 도착 ${t.cpuMilli ?? "없음"}`);
      }
      if (req?.memory != null) {
        const s = mibOf(req.memory);
        if (s == null) add(id, "resources.memory", "unverifiable", "원본 memory 수량을 못 읽음");
        else cmp(id, "resources.memory", t.memMiB === s, `memory requests 원본 ${s}Mi / 도착 ${t.memMiB ?? "없음"}`);
      }
      if (c.command?.length) cmp(id, "command", same(t.command, c.command), "시작 명령이 원본과 다름");
      // G3b-6: 인자·limits·보조/초기화 컨테이너 수
      if (c.args?.length) cmp(id, "args", same(t.args, c.args), "인자(args)가 원본과 다름 (평문 비밀 자리표시·주소 템플릿으로 바뀐 칸 포함)");
      const lim = c.resources?.limits;
      if (lim?.cpu != null) {
        const s = cpuMilliOf(lim.cpu);
        if (s == null) add(id, "resources.cpuLimit", "unverifiable", "원본 cpu limits 수량을 못 읽음");
        else cmp(id, "resources.cpuLimit", t.cpuLimit === s, `cpu limits 원본 ${s}m / 도착 ${t.cpuLimit ?? "없음"}`);
      }
      if (lim?.memory != null) {
        const s = mibOf(lim.memory);
        if (s == null) add(id, "resources.memoryLimit", "unverifiable", "원본 memory limits 수량을 못 읽음");
        else cmp(id, "resources.memoryLimit", t.memLimit === s, `memory limits 원본 ${s}Mi / 도착 ${t.memLimit ?? "없음"}`);
      }
      const extra = pod.containers.length - 1 + ((pod as { initContainers?: unknown[] }).initContainers?.length ?? 0);
      if (extra > 0 || t.extraContainers > 0) cmp(id, "containers.extra", t.extraContainers === extra, `보조·초기화 컨테이너 수 원본 ${extra} / 도착 ${t.extraContainers}`);

      if (isJob) {
        // G3-1: 줄임말(@hourly)은 같은 뜻의 cron 5필드로 바뀌므로 바꾼 값과 맞춘다
        const want = cronOf(String(cj.spec.schedule ?? ""))?.cron ?? cj.spec.schedule;
        cmp(id, "schedule", t.schedule === want, `스케줄 원본 ${cj.spec.schedule} / 도착 ${t.schedule ?? "없음"}`);
        continue;
      }
      const ports = [...new Set((c.ports ?? []).map((p) => p.containerPort))].sort((a, b) => a - b);
      if (ports.length) cmp(id, "ports", same(ports, [...new Set(t.ports)].sort((a, b) => a - b)), `포트 원본 ${list(ports)} / 도착 ${list(t.ports)}`);
      // 복제 수: 이 Deployment 를 가리키는 HPA 가 있으면 그 최소·최대, 없으면 spec.replicas (기본 1)
      const hpa = hpas.find((h) => h.metadata.namespace === meta.namespace && h.spec.scaleTargetRef.name === meta.name);
      const rep = hpa ? { min: hpa.spec.minReplicas ?? 1, max: hpa.spec.maxReplicas } : { min: dep.spec.replicas ?? 1, max: dep.spec.replicas ?? 1 };
      cmp(id, "replicas", t.replicas != null && t.replicas.min === rep.min && t.replicas.max === rep.max,
        `복제 수 원본 ${rep.min}~${rep.max} / 도착 ${t.replicas ? `${t.replicas.min}~${t.replicas.max}` : "없음"}`);
      for (const [name, raw] of [["readiness", c.readinessProbe], ["liveness", c.livenessProbe], ["startup", c.startupProbe]] as const) {
        if (!raw) continue;
        const sp = probeOf(raw) as Obj | undefined;
        if (!sp) { add(id, `probes.${name}`, "unverifiable", "원본 프로브 모양을 못 읽음"); continue; }
        const tp = t.probes[name];
        const want = probeView(sp)!;
        // G3b-6: 시간 칸(주기·실패 문턱·첫 지연)도 같이
        const ok = !!tp && tp.type === want.type && tp.path === want.path && tp.port === want.port
          && tp.periodSec === want.periodSec && tp.failureThreshold === want.failureThreshold && tp.initialDelaySec === want.initialDelaySec;
        cmp(id, `probes.${name}`, ok, tp ? `${name} 프로브(종류·경로·포트·시간)가 원본과 다름` : `${name} 프로브가 도착에 없음`);
      }
      continue;
    }

    // 비k8s 출발: 원본 칸을 따로 다시 읽어 같은 이름 칸으로 맞춘다 (digest·환경변수 이름·포트·복제 수·크기·일정)
    if (it.kind === ECS_RAW_KIND || it.kind === CLOUDRUN_RAW_KINDS.service || it.kind === CLOUDRUN_RAW_KINDS.job || it.kind === VM_RAW_KIND) {
      const w = otherReading(it);
      if (!w) continue;
      const id = idOf(it.kind, undefined, w.name, w.uid);
      if (!id) continue;
      const t = viewOf(id);
      if (!t) { add(id, "workload", "mismatch", "원본에 있는데 도착 렌더 결과에 없음"); continue; }
      if (w.digest !== undefined) {
        if (!w.digest) add(id, "image.digest", "unverifiable", "원본에서 이미지 digest 를 못 읽음");
        else cmp(id, "image.digest", t.digest === w.digest, t.digest ? "이미지 digest 가 원본과 다름" : "도착에 이미지 digest 없음");
      }
      if (w.envNames.length) {
        const missing = w.envNames.filter((n) => !t.envNames.includes(n));
        cmp(id, "env.names", missing.length === 0, `도착에 없는 환경변수 이름: ${list(missing)}`);
      }
      if (w.ports.length) cmp(id, "ports", same(w.ports, [...new Set(t.ports)].sort((a, b) => a - b)), `포트 원본 ${list(w.ports)} / 도착 ${list(t.ports)}`);
      if (w.replicas) cmp(id, "replicas", t.replicas != null && t.replicas.min === w.replicas.min && t.replicas.max === w.replicas.max,
        `복제 수 원본 ${w.replicas.min}~${w.replicas.max} / 도착 ${t.replicas ? `${t.replicas.min}~${t.replicas.max}` : "없음"}`);
      if (w.cpuMilli != null) cmp(id, "resources.cpu", t.cpuMilli === w.cpuMilli, `cpu 원본 ${w.cpuMilli}m / 도착 ${t.cpuMilli ?? "없음"}`);
      if (w.memMiB != null) cmp(id, "resources.memory", t.memMiB === w.memMiB, `memory 원본 ${w.memMiB}Mi / 도착 ${t.memMiB ?? "없음"}`);
      if (w.schedule) cmp(id, "schedule", t.schedule === w.schedule, `스케줄 원본 ${w.schedule} / 도착 ${t.schedule ?? "없음"}`);
      continue;
    }

    // 관리형 Postgres: 원본 버전·용량을 따로 다시 읽어 명세 값과 맞춘다 (매퍼가 나중에 바뀌어도 잡힘)
    const db = dbReading(it);
    if (!db) continue;
    const id = idOf(it.kind, db.ns, db.name, db.uid);
    const comp = id ? comps.get(id) : undefined;
    if (!id || !comp || comp.kind !== "postgres") continue;
    const p = comp.props as Obj;
    if (db.major == null) add(id, "db.version", "unverifiable", "원본 버전을 못 읽음");
    else cmp(id, "db.version", String(p.majorVersion ?? "") === db.major, `DB 주 버전 원본 ${db.major} / 명세 ${p.majorVersion ?? "없음"}`);
    if (db.storageGb == null) add(id, "db.storageGb", "unverifiable", "원본 용량을 못 읽음");
    else cmp(id, "db.storageGb", p.storageGb === db.storageGb, `DB 용량 원본 ${db.storageGb}GiB / 명세 ${p.storageGb ?? "없음"}`);
  }

  const matched = fields.filter((f) => f.result === "match").length;
  const mismatched = fields.filter((f) => f.result === "mismatch").length;
  const comparable = matched + mismatched;
  return {
    schemaVersion: "1", basis, total: fields.length, matched, mismatched, unverifiable: fields.length - comparable, comparable,
    percent: comparable === 0 ? null : Math.round((matched / comparable) * 1000) / 10,
    fields,
    compared: [...ACCURACY_COMPARED], notCompared: [...ACCURACY_NOT_COMPARED],
  };
}

function dbReading(it: Obj): { ns?: string; uid?: string | null; name: string; major: string | null; storageGb: number | null } | null {
  const gb = (v: unknown) => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null; };
  if (it.kind === DB_RAW_KINDS.rds) {
    return { uid: it.DBInstanceArn ?? null, name: String(it.DBInstanceIdentifier ?? ""), major: String(it.EngineVersion ?? "").match(/^(\d{1,2})/)?.[1] ?? null, storageGb: gb(it.AllocatedStorage) };
  }
  if (it.kind === DB_RAW_KINDS.cloudsql) {
    return { uid: it.selfLink ?? null, name: String(it.name ?? ""), major: String(it.databaseVersion ?? "").match(/POSTGRES_(\d+)/)?.[1] ?? null, storageGb: gb(it.settings?.dataDiskSizeGb) };
  }
  if (it.kind === DB_RAW_KINDS.cnpg) {
    const sp = it.spec ?? {};
    const ver = sp.postgresVersion != null ? String(sp.postgresVersion) : sp.imageName ? String(sp.imageName).split(":").pop() ?? "" : "";
    const mib = sp.storage?.size != null ? mibOf(sp.storage.size) : null;
    return { ns: it.metadata?.namespace, name: String(it.metadata?.name ?? ""), major: ver.match(/^(\d{1,2})/)?.[1] ?? null, storageGb: mib == null ? null : Math.ceil(mib / 1024) };
  }
  return null;
}

/** 비k8s 출발 원본에서 비교할 칸만 다시 읽는다. digest: undefined = 비교 안 함(VM 은 이미지가 없음), null = 못 읽음.
 *  cpu·memory 는 도착 명세 requests 와 같은 자리인 출발만 (ECS 예약값·VM 크기). Cloud Run 은 한도(limits)만 있어 안 맞춘다 */
function otherReading(it: Obj): { name: string; uid: string | null; digest?: string | null; envNames: string[]; ports: number[];
  replicas: { min: number; max: number } | null; cpuMilli: number | null; memMiB: number | null; schedule: string | null } | null {
  const atDigest = (img: string) => (img.includes("@sha256:") ? img.slice(img.indexOf("@") + 1) : null);
  const sortedPorts = (xs: Array<number | undefined>) => [...new Set(xs.filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b);
  if (it.kind === ECS_RAW_KIND) {
    const s = it as RawEcsService;
    const c = s.taskDefinition?.containerDefinitions ? mainContainer(s) : undefined;
    if (!c) return null;
    const as = s.autoscaling;
    return { name: s.serviceName, uid: s.serviceArn ?? null, digest: s.imageDigest ?? atDigest(c.image),
      envNames: [...(c.environment ?? []), ...(c.secrets ?? [])].map((e) => e.name), ports: sortedPorts((c.portMappings ?? []).map((p) => p.containerPort)),
      replicas: as ? { min: as.min, max: as.max } : { min: s.desiredCount, max: s.desiredCount }, cpuMilli: null, memMiB: null, schedule: null };
  }
  if (it.kind === CLOUDRUN_RAW_KINDS.service) {
    const s = it as RawCloudRunService;
    const c = s.containers?.find((x) => x.ports?.length) ?? s.containers?.[0];
    if (!c) return null;
    return { name: s.name, uid: s.uid ?? null, digest: s.imageDigest ?? atDigest(c.image), envNames: (c.env ?? []).map((e) => e.name),
      ports: sortedPorts((c.ports ?? []).slice(0, 1).map((p) => p.containerPort)),
      replicas: { min: Math.max(0, s.minScale ?? 0), max: Math.max(s.minScale ?? 0, s.maxScale ?? 100) }, cpuMilli: null, memMiB: null, schedule: null };
  }
  if (it.kind === CLOUDRUN_RAW_KINDS.job) {
    const j = it as RawCloudRunJob;
    const c = j.containers?.[0];
    if (!c || !j.schedule) return null;   // 일정 없는 잡은 부품이 안 됨 (unmapped)
    return { name: j.name, uid: j.uid ?? null, digest: j.imageDigest ?? atDigest(c.image), envNames: (c.env ?? []).map((e) => e.name), ports: [],
      replicas: null, cpuMilli: null, memMiB: null, schedule: j.schedule.cron };
  }
  const g = it as RawVmGroup;
  if (!g.name || !(g.count >= 1)) return null;
  return { name: g.name, uid: null, envNames: [], ports: [], replicas: { min: g.count, max: g.count }, cpuMilli: g.cpuMilli ?? null, memMiB: g.memMiB ?? null, schedule: null };
}
