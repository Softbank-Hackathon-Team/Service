import type { AccuracyField, ImportAccuracy, ImportResultV2, RawInventory } from "@svc/contracts";
import { cpuMilliOf, mibOf, probeOf } from "./mappers/k8s-deployment.js";
import { DB_RAW_KINDS, K8S_RAW_KINDS, type RawK8sCronJob, type RawK8sDeployment, type RawK8sHpa } from "./raw-k8s.js";

// DRAFT(ai): 가져오기 정확도 % (ALIGN-v2 IR-10, 설계 20번 5.6장 "되돌려 그리기"의 숫자 버전).
//   순수 함수: 네트워크·환경변수·시계를 안 쓴다. 같은 입력이면 같은 출력.
//   "원본에서 읽은 것만" 비교한다: 원본에 칸이 없으면 칸 자체를 안 만들고, 읽었지만 값이 모호하면 비교 불가(분모에서 뺌).
//   환경변수는 이름만 비교한다 (값은 어디에도 안 담음). 비밀은 이름이 있는지만 본다.
//   STUB: ECS·Cloud Run·VM 원본은 아직 비교 칸이 없다 (k8s 워크로드·CronJob·관리형 Postgres 만). 늘릴 때 collect* 함수를 더한다.

type Rendered = { workloads?: unknown[] } | null | undefined;
export interface MeasureInput { inventory: RawInventory; result: ImportResultV2; rendered?: Rendered }

/** 도착 쪽에서 본 한 워크로드 (렌더 결과 또는 공통 명세 props 에서 뽑는다) */
interface TargetView {
  digest: string | null; ports: number[]; envNames: string[]; replicas: { min: number; max: number } | null;
  cpuMilli: number | null; memMiB: number | null;
  probes: Record<string, { type?: string; path?: string; port?: string } | undefined>;
  command: string[] | null; schedule: string | null;
}
type Obj = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const probeView = (p: Obj | undefined) => (p ? { type: p.type, path: p.path, port: p.port == null ? undefined : String(p.port) } : undefined);
const digestOfRef = (ref: unknown): string | null => { const s = typeof ref === "string" ? ref : ""; const at = s.indexOf("@"); return at >= 0 ? s.slice(at + 1) : null; };

function viewFromRender(w: Obj): TargetView {
  const req = w.resources?.requests ?? {};
  return {
    digest: digestOfRef(w.image?.ref),
    ports: ((w.ports ?? []) as Obj[]).map((p) => num(p.port)).filter((x): x is number => x != null),
    envNames: ((w.env ?? []) as Obj[]).map((e) => String(e.name)),
    replicas: w.replicas ? { min: w.replicas.min, max: w.replicas.max } : null,
    cpuMilli: req.cpu != null ? cpuMilliOf(req.cpu) : null, memMiB: req.memory != null ? mibOf(req.memory) : null,
    probes: { readiness: probeView(w.probes?.readiness), liveness: probeView(w.probes?.liveness), startup: probeView(w.probes?.startup) },
    command: strArr(w.command), schedule: typeof w.schedule === "string" ? w.schedule : null,
  };
}
function viewFromSpec(p: Obj): TargetView {
  const req = p.resources?.request ?? {};
  return {
    digest: typeof p.image?.digest === "string" ? p.image.digest : null,
    ports: ((p.ports ?? []) as Obj[]).map((x) => num(x.port)).filter((x): x is number => x != null),
    envNames: ((p.env ?? []) as Obj[]).map((e) => String(e.name)),
    replicas: p.replicas ? { min: p.replicas.min, max: p.replicas.max } : null,
    cpuMilli: num(req.cpuMilli), memMiB: num(req.memMiB),
    probes: { readiness: probeView(p.probes?.readiness), liveness: probeView(p.probes?.liveness), startup: probeView(p.probes?.startup) },
    command: strArr(p.command), schedule: typeof p.schedule === "string" ? p.schedule : null,
  };
}

const list = (a: Array<string | number>) => (a.length ? a.join(",") : "없음");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function measureImportAccuracy(input: MeasureInput): ImportAccuracy {
  const { inventory, result } = input;
  const items = inventory.items as Obj[];
  const comps = new Map(result.spec.components.map((c) => [c.id, c as Obj]));
  const basis: ImportAccuracy["basis"] = input.rendered ? "render" : "spec";
  const renderedBy = new Map<string, Obj>(((input.rendered?.workloads ?? []) as Obj[]).map((w) => [String(w.id), w]));
  const fields: AccuracyField[] = [];
  const add = (component: string, field: string, result: AccuracyField["result"], detail?: string) =>
    fields.push({ component, field, result, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  const cmp = (component: string, field: string, ok: boolean, detail: string) => add(component, field, ok ? "match" : "mismatch", ok ? undefined : detail);

  const idOf = (kind: string, ns: string | undefined, name: string): string | null => {
    const keys = Object.keys(result.ids);
    const exact = `${kind}//${ns ?? ""}/${name}`;
    const k = keys.includes(exact) ? exact : keys.find((x) => x.startsWith(`${kind}/`) && x.endsWith(`/${ns ?? ""}/${name}`)) ?? keys.find((x) => x.startsWith(`${kind}/`) && x.endsWith(`/${name}`));
    return k ? result.ids[k] ?? null : null;
  };
  const hpas = items.filter((i) => i.kind === K8S_RAW_KINDS.hpa) as RawK8sHpa[];

  const viewOf = (id: string): TargetView | null => {
    if (input.rendered) { const w = renderedBy.get(id); return w ? viewFromRender(w) : null; }
    const c = comps.get(id);
    return c ? viewFromSpec(c.props as Obj) : null;
  };

  for (const it of items) {
    if (it.kind === K8S_RAW_KINDS.deployment || it.kind === K8S_RAW_KINDS.cronjob) {
      const isJob = it.kind === K8S_RAW_KINDS.cronjob;
      const dep = it as RawK8sDeployment, cj = it as RawK8sCronJob;
      const meta = it.metadata as { name: string; namespace?: string };
      const id = idOf(it.kind, meta.namespace, meta.name);
      if (!id) continue;   // 부품으로 안 올라간 것(unmapped)은 정확도 대상이 아니다 (unmapped 목록이 따로 말한다)
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

      if (isJob) {
        cmp(id, "schedule", t.schedule === cj.spec.schedule, `스케줄 원본 ${cj.spec.schedule} / 도착 ${t.schedule ?? "없음"}`);
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
        const ok = !!tp && tp.type === sp.type && tp.path === sp.path && tp.port === (sp.port == null ? undefined : String(sp.port));
        cmp(id, `probes.${name}`, ok, tp ? `${name} 프로브(종류·경로·포트)가 원본과 다름` : `${name} 프로브가 도착에 없음`);
      }
      continue;
    }

    // 관리형 Postgres: 원본 버전·용량을 따로 다시 읽어 명세 값과 맞춘다 (매퍼가 나중에 바뀌어도 잡힘)
    const db = dbReading(it);
    if (!db) continue;
    const id = idOf(it.kind, db.ns, db.name);
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
  };
}

function dbReading(it: Obj): { ns?: string; name: string; major: string | null; storageGb: number | null } | null {
  const gb = (v: unknown) => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null; };
  if (it.kind === DB_RAW_KINDS.rds) {
    return { name: String(it.DBInstanceIdentifier ?? ""), major: String(it.EngineVersion ?? "").match(/^(\d{1,2})/)?.[1] ?? null, storageGb: gb(it.AllocatedStorage) };
  }
  if (it.kind === DB_RAW_KINDS.cloudsql) {
    return { name: String(it.name ?? ""), major: String(it.databaseVersion ?? "").match(/POSTGRES_(\d+)/)?.[1] ?? null, storageGb: gb(it.settings?.dataDiskSizeGb) };
  }
  if (it.kind === DB_RAW_KINDS.cnpg) {
    const sp = it.spec ?? {};
    const ver = sp.postgresVersion != null ? String(sp.postgresVersion) : sp.imageName ? String(sp.imageName).split(":").pop() ?? "" : "";
    const mib = sp.storage?.size != null ? mibOf(sp.storage.size) : null;
    return { ns: it.metadata?.namespace, name: String(it.metadata?.name ?? ""), major: ver.match(/^(\d{1,2})/)?.[1] ?? null, storageGb: mib == null ? null : Math.ceil(mib / 1024) };
  }
  return null;
}
