import type { AppSpec, AppSpecV2, ComponentV2, FieldMeta, FieldMetaV2, ImportResultV2 } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { cpuFromMilli, memFromMiB } from "../common/normalize.js";
import { DB_RAW_KINDS } from "./raw-k8s.js";
import type { ProjectionEnv } from "./types.js";

// DRAFT(ai): v2 → v1 투영 (설계 24번 3.4 표 + R11~R13). 교살자 방식: v2 를 만들어도 계획·적용은 지금 v1 을 쓴다.
//   원칙: v1 투영은 지금 normalizeInventory 결과와 같은 값·같은 확신을 낸다 → T04 가 지금보다 더 막지 않음.
//   v2 의 "모름"은 spec_v2.fieldMeta 에만 남는다. 순수 함수.

type Svc = Extract<ComponentV2, { kind: "service" }>;
type Pg = Extract<ComponentV2, { kind: "postgres" }>;
type V1 = { spec: Partial<AppSpec>; fieldMeta: FieldMeta };

const V1_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const services = (s: AppSpecV2) => s.components.filter((c): c is Svc => c.kind === "service");
const postgresOf = (s: AppSpecV2, mainId: string): Pg | undefined => {
  const pgs = s.components.filter((c): c is Pg => c.kind === "postgres");
  const linked = s.links.find((l) => l.from === mainId && typeof l.to === "string" && pgs.some((p) => p.id === l.to));
  return (linked ? pgs.find((p) => p.id === linked.to) : undefined) ?? pgs[0];
};
// v1 normalize.ts 의 major() 와 같은 규칙·코드
const v1Major = (v: string): "15" | "16" | "17" => {
  const m = String(v).split(".")[0]!;
  if (m !== "15" && m !== "16" && m !== "17") throw new AdapterError("PG_VERSION_UNSUPPORTED", `지원하지 않는 Postgres 버전: ${v}`);
  return m;
};
const routeHost = (s: AppSpecV2, id: string) =>
  s.entry?.hosts.find((h) => h.routes.some((r) => r.backends.some((b) => b.to === id)))?.hostnames[0];

/**
 * normalizeV2 결과 → v1 명세 + v1 field_meta.
 * 주 서비스(H-4): opts.mainApp(IMPORT_APP, 원래 이름) → 없으면 지금 v1 과 같은 "네임스페이스/이름" 순 첫 서비스.
 */
export function projectV1(result: ImportResultV2, env: ProjectionEnv, opts: { mainApp?: string } = {}): V1 {
  const spec = result.spec;
  const meta: FieldMeta = {};
  const set = (path: string, source: string, exact = true) => {
    meta[path] = exact ? { source, confidence: 1, needs_review: false }
      : { source, confidence: 0.9, needs_review: true, rationale: "명세 단계로 올림" };
  };
  const cands = services(spec).filter((c) => env.workloads[c.id]);
  const order = (c: Svc) => `${env.workloads[c.id]!.namespace ?? ""}/${env.workloads[c.id]!.name}`;
  const main = opts.mainApp ? cands.find((c) => env.workloads[c.id]!.name === opts.mainApp)
    : [...cands].sort((a, b) => order(a).localeCompare(order(b)))[0];
  if (!main) throw new AdapterError("SOURCE_INCOMPLETE", opts.mainApp ? `Deployment ${opts.mainApp} 없음` : "앱 Deployment 가 없음 (가져온 서비스 0개)");
  const p = env.workloads[main.id]!;
  if (!V1_NAME.test(p.name)) throw new AdapterError("SPEC_V2_INVALID", `앱 이름 ${p.name} 이 v1 이름 규칙(^[a-z][a-z0-9-]{1,30}$) 밖`);
  if (p.port == null) throw new AdapterError("SOURCE_INCOMPLETE", `${p.namespace ?? ""}/${p.name} 의 포트를 모름 (컨테이너 ports·서비스 둘 다 없음)`);
  if (main.props.image.source !== "registry" || !main.props.image.digest)
    throw new AdapterError("SOURCE_INCOMPLETE", `${p.name} 이미지가 빌드 대상이라 v1 경로로 못 감`);

  const src = `k8s:${p.namespace ?? ""}/${p.name}`;
  const req = main.props.resources.request;
  const cpu = cpuFromMilli(req?.cpuMilli ?? 500);
  const mem = memFromMiB(req?.memMiB ?? 1024);
  set("app.name", `${src}.metadata.name`);
  const service: AppSpec["service"] = {
    image: p.image.includes("@sha256:") ? p.image : `${p.image.split(":")[0]}@${p.imageDigest ?? main.props.image.digest}`,
    port: p.port,
    healthPath: p.healthPath ?? "/healthz",
    replicas: Math.min(10, Math.max(1, p.specReplicas)),   // v1 범위 1~10 (0으로 줄인 서비스는 1로 올리고 검토 표시)
    cpu: cpu.v, memory: mem.v,
    env: p.env.map((e) => ({ name: e.name, value: e.value })),
    secretRefs: p.secretRefs.map((r) => ({ name: r.name, key: r.key })),
  };
  set("service.image", `${src}.containers[0].image`);
  set("service.port", `${src}.containers[0].ports[0]`);
  set("service.replicas", `${src}.spec.replicas`, p.specReplicas >= 1 && p.specReplicas <= 10);
  set("service.cpu", `${src}.resources.requests.cpu`, cpu.exact);
  set("service.memory", `${src}.resources.requests.memory`, mem.exact);
  set("service.healthPath", `${src}.readinessProbe`, Boolean(p.healthPath));
  set("ingress.hostname", `${src}.ingress.host`);
  for (const e of service.env) set(`service.env.${e.name}`, "source.env");
  for (const n of p.plainSecretNames) meta[`service.env.${n}`] = { source: "source.env", confidence: 0.6, needs_review: true,
    rationale: "평문 비밀로 보여 명세에서 뺐다. 도착 비밀 저장소에 등록 후 secretRefs 로 연결" };

  const out: Partial<AppSpec> = {
    schemaVersion: "1",
    app: { name: p.name },
    service,
    ingress: { hostname: p.hostname ?? `${p.name}.${p.namespace ?? ""}.svc.cluster.local`, entry: "cloudflare-lb" },
  };
  const pg = postgresOf(spec, main.id);
  if (pg) {
    const nt = env.postgres[pg.id]?.nativeType;
    // R3: v2 가 못 읽은 값(null)은 지금 v1 discover 가 채우던 기본값으로 (cloudsql "10", cnpg "1Gi"·"16")
    const storage = pg.props.storageGb ?? (nt === DB_RAW_KINDS.cnpg ? 1 : 10);
    out.database = { engine: "postgres", majorVersion: v1Major(pg.props.majorVersion ?? "16"), storageGb: Math.min(100, storage) };
    const name = result.ids ? Object.entries(result.ids).find(([, v]) => v === pg.id)?.[0] : undefined;
    const label = nt === DB_RAW_KINDS.rds ? "rds" : nt === DB_RAW_KINDS.cloudsql ? "cloudsql" : nt === DB_RAW_KINDS.cnpg ? "cnpg" : "postgres";
    // R13: 지금과 같은 확신 — RDS 만 100 넘으면 0.9, Cloud SQL·CNPG 는 넘어도 1
    set("database", `${label}:${name?.split("/").pop() ?? pg.id}`, nt === DB_RAW_KINDS.rds ? storage <= 100 : true);
  }
  return { spec: out, fieldMeta: meta };
}

/**
 * 사람이 고친 v2(PATCH) → v1 다시 뽑기. 투영 재료(원래 env 값)는 저장하지 않으므로 env·secretRefs 는 앞 판 v1 에서 복사 (R15).
 * 나머지는 v2 값 → 비면 앞 판 v1 값. field_meta 는 v2 fieldMeta 의 같은 리소스 필드 확신을 따른다.
 */
export function rebuildFromV2(v2: ImportResultV2 | AppSpecV2, prevV1: AppSpec): V1 {
  const spec: AppSpecV2 = "spec" in v2 ? v2.spec : v2;
  const v2meta: FieldMetaV2 = "spec" in v2 ? v2.fieldMeta : {};
  const meta: FieldMeta = {};
  const svcs = services(spec);
  const main = svcs.find((c) => c.id === prevV1.app.name) ?? [...svcs].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!main) throw new AdapterError("SPEC_V2_INVALID", "v2 명세에 서비스가 없음");
  const img = main.props.image;
  if (img.source !== "registry" || !img.digest) throw new AdapterError("SPEC_V2_INVALID", `${main.id} 이미지가 빌드 대상이라 v1 로 못 뽑음`);
  const from = (field: string, source: string, exact = true) => {
    const m = v2meta[`components.${main.id}.${field}`];
    meta[`service.${field}`] = !exact ? { source, confidence: 0.9, needs_review: true, rationale: "명세 단계로 올림" }
      : m ? { source, confidence: m.confidence, needs_review: m.needs_review, ...(m.rationale ? { rationale: m.rationale } : {}) }
      : { source, confidence: 1, needs_review: false };
  };
  const req = main.props.resources.request;
  const cpu = req?.cpuMilli != null ? cpuFromMilli(req.cpuMilli) : { v: prevV1.service.cpu, exact: true };
  const mem = req?.memMiB != null ? memFromMiB(req.memMiB) : { v: prevV1.service.memory, exact: true };
  const tp = main.props.endpoints?.flatMap((e) => e.ports.map((x) => x.targetPort)).find((x): x is number => typeof x === "number");
  const readiness = main.props.probes?.readiness;
  const r = main.props.replicas;
  const service: AppSpec["service"] = {
    image: `${img.repository}@${img.digest}`,
    port: main.props.ports?.[0]?.port ?? tp ?? prevV1.service.port,
    healthPath: readiness?.type === "http" && readiness.path ? readiness.path : prevV1.service.healthPath,
    replicas: prevV1.service.replicas >= r.min && prevV1.service.replicas <= r.max ? prevV1.service.replicas : Math.max(1, r.min),
    cpu: cpu.v, memory: mem.v,
    env: prevV1.service.env.map((e) => ({ ...e })),
    secretRefs: prevV1.service.secretRefs.map((e) => ({ ...e })),
  };
  meta["app.name"] = { source: "spec_v1.prev", confidence: 1, needs_review: false };
  from("image", "spec_v2.image");
  from("ports", "spec_v2.ports"); meta["service.port"] = meta["service.ports"]!; delete meta["service.ports"];
  from("probes", "spec_v2.probes"); meta["service.healthPath"] = meta["service.probes"]!; delete meta["service.probes"];
  from("replicas", "spec_v2.replicas");
  from("resources", "spec_v2.resources.cpu", cpu.exact); meta["service.cpu"] = meta["service.resources"]!; delete meta["service.resources"];
  from("resources", "spec_v2.resources.memory", mem.exact); meta["service.memory"] = meta["service.resources"]!; delete meta["service.resources"];
  for (const e of service.env) meta[`service.env.${e.name}`] = { source: "spec_v1.prev", confidence: 1, needs_review: false };
  const out: Partial<AppSpec> = {
    schemaVersion: "1",
    app: { name: prevV1.app.name },
    service,
    ingress: { hostname: routeHost(spec, main.id) ?? prevV1.ingress.hostname, entry: "cloudflare-lb" },
  };
  meta["ingress.hostname"] = { source: routeHost(spec, main.id) ? "spec_v2.entry" : "spec_v1.prev", confidence: 1, needs_review: false };
  const pg = postgresOf(spec, main.id);
  if (pg) {
    const storage = pg.props.storageGb ?? prevV1.database?.storageGb ?? 10;
    out.database = { engine: "postgres", majorVersion: v1Major(pg.props.majorVersion ?? prevV1.database?.majorVersion ?? "16"), storageGb: Math.min(100, storage) };
    meta.database = storage <= 100 ? { source: `spec_v2:${pg.id}`, confidence: 1, needs_review: false }
      : { source: `spec_v2:${pg.id}`, confidence: 0.9, needs_review: true, rationale: "명세 단계로 올림" };
  }
  return { spec: out, fieldMeta: meta };
}
