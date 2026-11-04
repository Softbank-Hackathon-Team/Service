import { createHash } from "node:crypto";
import { SECRET_TYPE_REQUIRED_KEYS, type FidelityItemId, type RehearsalInput } from "@svc/contracts";

// 리허설 치환 (설계 2.6 + 리드 결정 11/4). 원본 매니페스트는 그대로 dry-run 하고, 적용은 아래 표대로 바꾼 사본으로 한다.
// 표에 없는 바꿈은 없다. 바꾼 자리마다 충실도 항목(FidelityItemId)의 refs 에 "<종류>/<ns>/<이름>[:<경로>]" 를 남긴다
//   → 시험이 원본·사본의 차이 경로를 뽑아 refs 합집합과 같은지 본다 (rehearsal-substitute.test.ts)
// 표에 없는 종류가 묶음에 있으면 unsupported 에 담는다 (닫힌 쪽 실패, REHEARSAL_UNSUPPORTED_KIND)

export type K8sDoc = { apiVersion?: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> } } & Record<string, unknown>;
export interface Manifest { path: string; doc: K8sDoc }

export interface ManagedDb { id: string; host: string; majorVersion: string; database: string; owner: string; secretName: string }
export interface SubstCtx {
  namespace: string;
  images: ReadonlyMap<string, string>;   // 렌더 주소 → 샌드박스 주소 (mirrorImages). 비면 이미지는 그대로
  managedDbs: readonly ManagedDb[];      // EKS RDS · GKE Cloud SQL (값 postgres[] mode external, 채운 실제 주소)
  seed: string;                          // 가짜 비밀 값 씨앗 (묶음 지문). 고객 값은 절대 안 씀
}
export interface Substituted {
  apply: Manifest[];
  refs: Partial<Record<FidelityItemId, string[]>>;
  present: ReadonlySet<Presence>;
  databases: RehearsalInput["databases"];
  edges: RehearsalInput["edges"];
  unsupported: string[];
}
export type Presence = "hpa" | "cronjob" | "daemonset" | "ingress" | "tunnel" | "external_secret" | "cnpg";

// DRAFT(ai): 요청량 상한. 샌드박스 노드(t3.medium 1대)에 3티어가 다 올라가게. 낮추기만 하고 한도(limits)는 그대로라 OOM 판정은 같다
export const REQUEST_CAP = { cpu: "100m", memory: "128Mi" } as const;
const CAP_MILLI = 100, CAP_BYTES = 128 * 2 ** 20;
// 가상 클러스터 안에서 효과가 없는 클라우드 신원 주석 (IRSA, GKE Workload Identity). EKS Pod Identity 는 Terraform 연결이라 주석이 없다
const IAM_ANNOTATIONS = ["eks.amazonaws.com/role-arn", "iam.gke.io/gcp-service-account"];
const SCHEDULING_KEYS = ["nodeSelector", "affinity", "tolerations", "topologySpreadConstraints", "priorityClassName"];
const LB_ONLY_SERVICE_KEYS = ["externalTrafficPolicy", "loadBalancerIP", "loadBalancerSourceRanges", "loadBalancerClass",
  "allocateLoadBalancerNodePorts", "healthCheckNodePort", "externalIPs"];
// CNPG 가 <cluster>-app Secret 에 넣는 키 (operator 1.2x). 앱이 이 중 무엇을 읽어도 있게
const CNPG_APP_KEYS = ["username", "password", "dbname", "host", "port", "uri", "jdbc-uri", "pgpass"];

type Seg = string | number;
export const docIdOf = (d: K8sDoc) => (d.metadata.namespace ? `${d.kind}/${d.metadata.namespace}/${d.metadata.name}` : `${d.kind}/${d.metadata.name}`);
// 경로 글: spec.template.spec.containers[0].image, 점·빗금이 든 키는 ["iam.gke.io/x"]
export function refOf(id: string, segs: readonly Seg[] = []): string {
  const p = segs.map((s, i) => typeof s === "number" ? `[${s}]` : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) ? (i ? `.${s}` : s) : `[${JSON.stringify(s)}]`).join("");
  return (p ? `${id}:${p}` : id).slice(0, 200);
}

type Obj = Record<string, unknown>;
const at = (root: unknown, segs: readonly Seg[]): unknown => segs.reduce<unknown>((x, k) => (x as Record<Seg, unknown> | undefined)?.[k], root);

// 한 문서의 바꿈 기록. 바꾼 자리(없던 칸이면 처음 없는 칸)를 refs 로 남긴다
class Edit {
  constructor(readonly id: string, readonly doc: Obj, private readonly out: Map<FidelityItemId, Set<string>>) {}
  private note(item: FidelityItemId, segs: readonly Seg[]) {
    const s = this.out.get(item) ?? new Set<string>();
    s.add(refOf(this.id, segs));
    this.out.set(item, s);
  }
  set(item: FidelityItemId, segs: readonly Seg[], value: unknown) {
    let cur = this.doc as Record<Seg, unknown>;
    for (let i = 0; i < segs.length - 1; i++) {
      if (cur[segs[i]!] === undefined) {
        cur[segs[i]!] = segs.slice(i + 1).reduceRight<unknown>((v, k) => ({ [k]: v }), value);
        this.note(item, segs.slice(0, i + 1));
        return;
      }
      cur = cur[segs[i]!] as Record<Seg, unknown>;
    }
    const last = segs[segs.length - 1]!;
    if (JSON.stringify(cur[last]) === JSON.stringify(value)) return;
    cur[last] = value;
    this.note(item, segs);
  }
  del(item: FidelityItemId, segs: readonly Seg[]) {
    const parent = at(this.doc, segs.slice(0, -1)) as Record<Seg, unknown> | undefined;
    const last = segs[segs.length - 1]!;
    if (!parent || !(last in parent)) return;
    delete parent[last];
    this.note(item, segs);
  }
  push(item: FidelityItemId, segs: readonly Seg[], el: unknown) {
    const arr = at(this.doc, segs);
    if (!Array.isArray(arr)) return this.set(item, segs, [el]);
    arr.push(el);
    this.note(item, [...segs, arr.length - 1]);
  }
  whole(item: FidelityItemId) { this.note(item, []); }
}

// 수량 글 → 밀리코어 / 바이트. 못 읽으면 null (그 칸은 안 건드림)
const MEM_UNIT: Record<string, number> = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
export function quantity(kind: "cpu" | "memory", v: unknown): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]), u = m[2] ?? "";
  if (kind === "cpu") return u === "m" ? n : u === "" ? n * 1000 : null;
  return u === "m" ? null : n * MEM_UNIT[u]!;
}

const POD_SPEC: Partial<Record<string, readonly Seg[]>> = {
  Deployment: ["spec", "template", "spec"], StatefulSet: ["spec", "template", "spec"], DaemonSet: ["spec", "template", "spec"],
  Job: ["spec", "template", "spec"], CronJob: ["spec", "jobTemplate", "spec", "template", "spec"],
};
type Container = { name?: string; image?: string; env?: Array<{ name?: string; value?: unknown; valueFrom?: { secretKeyRef?: { name?: string; key?: string } } }>; args?: unknown[]; command?: unknown[]; resources?: { requests?: Obj; limits?: Obj } };
const containerLists = (pod: Obj) => (["containers", "initContainers"] as const)
  .flatMap((k) => (Array.isArray(pod[k]) ? (pod[k] as Container[]).map((c, i) => ({ c, segs: [k, i] as Seg[] })) : []));

// ingress.yaml 의 cloudflared 터널. 리허설에서 돌리지 않는다 (토큰·바깥 연결 없음)
const isTunnel = (d: K8sDoc) => d.kind === "Deployment" && d.metadata.name.endsWith("-cloudflared") &&
  containerLists(at(d, POD_SPEC.Deployment!) as Obj ?? {}).some(({ c }) => String(c.image ?? "").startsWith("cloudflare/cloudflared"));
const isCnpg = (d: K8sDoc) => d.kind === "Cluster" && String(d.apiVersion ?? "").startsWith("postgresql.cnpg.io/");
const isEso = (d: K8sDoc) => d.kind === "ExternalSecret" && String(d.apiVersion ?? "").startsWith("external-secrets.io/");

/** 적용할 파드가 받는 이미지 (터널 빼고). mirrorImages 입력 */
export function podImages(docs: readonly Manifest[]): string[] {
  const out = new Set<string>();
  for (const { doc } of docs) {
    const p = POD_SPEC[doc.kind];
    if (!p || isTunnel(doc)) continue;
    for (const { c } of containerLists((at(doc, p) as Obj) ?? {})) if (c.image) out.add(c.image);
  }
  return [...out].sort();
}

// 가짜 값: 묶음 지문·이름·키에서 만든 16진 48글자 (길이 검사를 하는 앱도 받는다). 고객 값과 상관없다
const dummy = (seed: string, name: string, key: string) => createHash("sha256").update(`${seed}\0${name}\0${key}`).digest("hex").slice(0, 48);
const dnsLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
export const sandboxDbService = (id: string) => dnsLabel(`sbx-db-${id}`);

function secretKeyRefs(docs: readonly Manifest[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (name: string | undefined, key: string | undefined) => {
    if (!name || !key) return;
    m.set(name, (m.get(name) ?? new Set()).add(key));
  };
  for (const { doc } of docs) {
    const p = POD_SPEC[doc.kind];
    if (!p) continue;
    const pod = (at(doc, p) as Obj) ?? {};
    for (const { c } of containerLists(pod)) for (const e of c.env ?? []) add(e.valueFrom?.secretKeyRef?.name, e.valueFrom?.secretKeyRef?.key);
    for (const v of (pod.volumes as Array<{ secret?: { secretName?: string; items?: Array<{ key?: string }> } }> | undefined) ?? [])
      for (const it of v.secret?.items ?? []) add(v.secret?.secretName, it.key);
  }
  return m;
}

function plainSecret(ns: string, name: string, type: string | undefined, labels: Record<string, string> | undefined,
  keys: Iterable<string>, value: (k: string) => string): K8sDoc {
  const stringData = Object.fromEntries([...new Set([...keys, ...(SECRET_TYPE_REQUIRED_KEYS[type ?? ""] ?? [])])].sort()
    .map((k) => [k, type === "kubernetes.io/dockerconfigjson" && k === ".dockerconfigjson" ? '{"auths":{}}' : value(k)]));
  return { apiVersion: "v1", kind: "Secret", metadata: { name, namespace: ns, ...(labels ? { labels } : {}) }, ...(type ? { type } : {}), stringData };
}

// 관리형 DB 주소 → 샌드박스 Postgres 주소. 글자 경계(호스트 이름에 못 오는 글자)에서만 바꾼다 (URL 안 @host, //host 포함)
function replaceHosts(s: string, dbs: readonly { host: string; to: string }[]): string {
  let out = s;
  for (const d of dbs) {
    if (!d.host) continue;
    const esc = d.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9.-])${esc}(?=$|[^A-Za-z0-9.-])`, "g"), (_m, pre: string) => `${pre}${d.to}`);
  }
  return out;
}

// 서비스 사이 연결: env 값의 http://<Service>[.<ns>[.svc[.cluster.local]]][:포트] 가 묶음 안 Service 를 가리키면 한 줄 (https 는 평문 검사가 거짓 실패라 뺀다)
function edgesFrom(from: string, values: string[], ns: string, services: ReadonlyMap<string, Set<number>>, out: RehearsalInput["edges"]) {
  for (const v of values) {
    for (const m of v.matchAll(/http:\/\/([a-z0-9-]+)((?:\.[a-z0-9-]+)*)(?::(\d+))?/g)) {
      const [, svc, rest, p] = m;
      if (rest && ![`.${ns}`, `.${ns}.svc`, `.${ns}.svc.cluster.local`].includes(rest)) continue;
      const port = p ? Number(p) : 80;
      if (!services.get(svc!)?.has(port)) continue;
      if (!out.some((e) => e.from === from && e.host === svc && e.port === port)) out.push({ from, host: svc!, port });
    }
  }
}

type Rule = (e: Edit, doc: K8sDoc, s: State) => K8sDoc[] | void;   // 돌려주면 그 문서들로 바꿈 ([] = 적용 안 함)
interface State { ctx: SubstCtx; keyRefs: Map<string, Set<string>>; present: Set<Presence>; databases: RehearsalInput["databases"]; edges: RehearsalInput["edges"]; services: Map<string, Set<number>> }

function podRules(e: Edit, doc: K8sDoc, s: State) {
  const base = POD_SPEC[doc.kind]!;
  const pod = (at(doc, base) as Obj) ?? {};
  for (const k of SCHEDULING_KEYS) e.del("scheduling", [...base, k]);
  const hosts = s.ctx.managedDbs.map((d) => ({ host: d.host, to: `${sandboxDbService(d.id)}.${s.ctx.namespace}.svc.cluster.local` }));
  const values: string[] = [];
  for (const { c, segs } of containerLists(pod)) {
    const cs = [...base, ...segs];
    const img = c.image && s.ctx.images.get(c.image);
    if (img) e.set("images", [...cs, "image"], img);
    for (const r of ["cpu", "memory"] as const) {
      const req = c.resources?.requests?.[r], lim = c.resources?.limits?.[r];
      const eff = quantity(r, req ?? lim);
      if (eff !== null && eff > (r === "cpu" ? CAP_MILLI : CAP_BYTES)) e.set("requests", [...cs, "resources", "requests", r], REQUEST_CAP[r]);
    }
    (c.env ?? []).forEach((v, i) => {
      if (typeof v.value !== "string") return;
      values.push(v.value);
      const to = replaceHosts(v.value, hosts);
      if (to !== v.value) e.set("database", [...cs, "env", i, "value"], to);
    });
    for (const k of ["args", "command"] as const) (c[k] ?? []).forEach((v, i) => {
      if (typeof v !== "string") return;
      const to = replaceHosts(v, hosts);
      if (to !== v) e.set("database", [...cs, k, i], to);
    });
  }
  ((pod.volumes as Obj[] | undefined) ?? []).forEach((v, i) => {
    if (!v.persistentVolumeClaim) return;
    e.del("storage", [...base, "volumes", i, "persistentVolumeClaim"]);
    e.set("storage", [...base, "volumes", i, "emptyDir"], {});
  });
  edgesFrom(doc.metadata.name, values, s.ctx.namespace, s.services, s.edges);
}

const keep: Rule = () => undefined;
const workload = (replicas: boolean): Rule => (e, doc, s) => {
  if (replicas && typeof (doc.spec as Obj | undefined)?.replicas === "number" && ((doc.spec as Obj).replicas as number) > 1) e.set("replicas", ["spec", "replicas"], 1);
  podRules(e, doc, s);
};

// 종류 → 바꿈. 이 표가 리허설이 받는 종류의 닫힌 목록이다
const SUBSTITUTIONS: Record<string, Rule> = {
  ServiceAccount: (e, doc) => {
    for (const a of IAM_ANNOTATIONS) e.del("cloud_identity", ["metadata", "annotations", a]);
    return void doc;
  },
  ConfigMap: (e, doc, s) => {
    const hosts = s.ctx.managedDbs.map((d) => ({ host: d.host, to: `${sandboxDbService(d.id)}.${s.ctx.namespace}.svc.cluster.local` }));
    for (const [k, v] of Object.entries((doc.data as Record<string, unknown> | undefined) ?? {})) {
      if (typeof v !== "string") continue;
      const to = replaceHosts(v, hosts);
      if (to !== v) e.set("database", ["data", k], to);
    }
  },
  Secret: keep,
  PersistentVolumeClaim: (e) => { e.whole("storage"); return []; },
  Deployment: (e, doc, s) => {
    if (!isTunnel(doc)) return workload(true)(e, doc, s);
    s.present.add("tunnel");
    const pod = (at(doc, POD_SPEC.Deployment!) as Obj) ?? {};
    const args = containerLists(pod).flatMap(({ c }) => (c.args ?? []).filter((a): a is string => typeof a === "string"));
    edgesFrom(doc.metadata.name, args, s.ctx.namespace, s.services, s.edges);
    e.whole("tunnel");
    return [];
  },
  StatefulSet: (e, doc, s) => {
    const vct = ((doc.spec as Obj | undefined)?.volumeClaimTemplates as Array<{ metadata?: { name?: string } }> | undefined) ?? [];
    if (vct.length) {
      e.del("storage", ["spec", "volumeClaimTemplates"]);
      for (const t of vct) if (t.metadata?.name) e.push("storage", [...POD_SPEC.StatefulSet!, "volumes"], { name: t.metadata.name, emptyDir: {} });
    }
    workload(true)(e, doc, s);
  },
  DaemonSet: (e, doc, s) => { s.present.add("daemonset"); workload(false)(e, doc, s); },
  Job: workload(false),
  CronJob: (e, doc, s) => { s.present.add("cronjob"); workload(false)(e, doc, s); },
  Service: (e, doc) => {
    const spec = (doc.spec as Obj | undefined) ?? {};
    if (spec.type !== "LoadBalancer" && spec.type !== "NodePort") return;
    e.set("service_type", ["spec", "type"], "ClusterIP");
    for (const k of LB_ONLY_SERVICE_KEYS) e.del("service_type", ["spec", k]);
    ((spec.ports as Obj[] | undefined) ?? []).forEach((_p, i) => e.del("service_type", ["spec", "ports", i, "nodePort"]));
  },
  HorizontalPodAutoscaler: (e, doc, s) => {
    s.present.add("hpa");
    // 지표 서버가 없어도 HPA 는 minReplicas 까지는 늘린다 → 복제 수 1 을 지키려고 1 로
    if (typeof (doc.spec as Obj | undefined)?.minReplicas === "number" && ((doc.spec as Obj).minReplicas as number) > 1) e.set("replicas", ["spec", "minReplicas"], 1);
  },
  PodDisruptionBudget: keep,
  ExternalSecret: (e, doc, s) => {
    if (!isEso(doc)) return;
    s.present.add("external_secret");
    const spec = (doc.spec as { target?: { name?: string; template?: { type?: string } }; data?: Array<{ secretKey?: string }> } | undefined) ?? {};
    const name = spec.target?.name ?? doc.metadata.name;
    const keys = [...(spec.data ?? []).map((d) => d.secretKey).filter((k): k is string => !!k), ...(s.keyRefs.get(name) ?? [])];
    const sec = plainSecret(s.ctx.namespace, name, spec.target?.template?.type, doc.metadata.labels, keys, (k) => dummy(s.ctx.seed, name, k));
    e.whole("secrets");
    return [sec];
  },
  Ingress: (e, doc, s) => {
    s.present.add("ingress");
    const rules = ((doc.spec as Obj | undefined)?.rules as Array<{ http?: { paths?: Array<{ backend?: { service?: { name?: string; port?: { number?: number } } } }> } }> | undefined) ?? [];
    for (const r of rules) for (const p of r.http?.paths ?? []) {
      const svc = p.backend?.service?.name, port = p.backend?.service?.port?.number;
      if (svc && port && s.services.get(svc)?.has(port) && !s.edges.some((x) => x.from === doc.metadata.name && x.host === svc && x.port === port))
        s.edges.push({ from: doc.metadata.name, host: svc, port });
    }
    e.whole("ingress");
    return [];
  },
  Cluster: (e, doc, s) => {
    if (!isCnpg(doc)) return;
    s.present.add("cnpg");
    const spec = (doc.spec as { imageName?: string; bootstrap?: { initdb?: { database?: string; owner?: string } } } | undefined) ?? {};
    const name = doc.metadata.name, svc = `${name}-rw`, secretName = `${name}-app`;
    const database = spec.bootstrap?.initdb?.database ?? "app", owner = spec.bootstrap?.initdb?.owner ?? "app";
    const major = /:(\d+)/.exec(spec.imageName ?? "")?.[1] ?? "16";
    const pw = dummy(s.ctx.seed, secretName, "password");
    const known: Record<string, string> = { username: owner, password: pw, dbname: database, host: svc, port: "5432",
      uri: `postgresql://${owner}:${pw}@${svc}:5432/${database}`, "jdbc-uri": `jdbc:postgresql://${svc}:5432/${database}?password=${pw}&user=${owner}`,
      pgpass: `${svc}:5432:${database}:${owner}:${pw}\n` };
    const keys = [...CNPG_APP_KEYS, ...(s.keyRefs.get(secretName) ?? [])];
    s.databases.push({ service: svc, majorVersion: major, database, owner, secretName, secretKeys: [...new Set(keys)].sort() });
    e.whole("database");
    const sec = plainSecret(s.ctx.namespace, secretName, undefined, doc.metadata.labels, keys, (k) => known[k] ?? dummy(s.ctx.seed, secretName, k));
    return [sec];
  },
};

const supported = (d: K8sDoc) => !!SUBSTITUTIONS[d.kind] && (d.kind !== "Cluster" || isCnpg(d)) && (d.kind !== "ExternalSecret" || isEso(d));
/** 치환 표에 없는 종류 (닫힌 쪽 실패). 이미지 복사 전에 본다 */
export const unsupportedOf = (docs: readonly Manifest[]) => docs.filter((m) => !supported(m.doc)).map((m) => docIdOf(m.doc));

/** 원본 → 적용 사본 + 충실도 refs. 순수 함수 (같은 입력이면 같은 출력) */
export function substitute(docs: readonly Manifest[], ctx: SubstCtx): Substituted {
  const refs = new Map<FidelityItemId, Set<string>>();
  const services = new Map<string, Set<number>>();
  for (const { doc } of docs) if (doc.kind === "Service")
    services.set(doc.metadata.name, new Set((((doc.spec as Obj | undefined)?.ports as Array<{ port?: number }> | undefined) ?? []).map((p) => p.port!).filter(Boolean)));
  const s: State = { ctx, keyRefs: secretKeyRefs(docs), present: new Set(), databases: [], edges: [], services };
  const apply: Manifest[] = [];
  const unsupported: string[] = [];
  const taken = new Set(docs.map((d) => docIdOf(d.doc)));
  for (const m of docs) {
    const rule = SUBSTITUTIONS[m.doc.kind];
    if (!rule || !supported(m.doc)) { unsupported.push(docIdOf(m.doc)); continue; }
    const doc = structuredClone(m.doc);
    const e = new Edit(docIdOf(doc), doc, refs);
    const replaced = rule(e, doc, s);
    if (!replaced) { apply.push({ path: m.path, doc }); continue; }
    for (const r of replaced) {
      const id = docIdOf(r);
      if (taken.has(id)) continue;
      taken.add(id);
      apply.push({ path: `rehearsal/${r.kind.toLowerCase()}-${r.metadata.name}.yaml`, doc: r });
      new Edit(id, r, refs).whole(r.kind === "Secret" && m.doc.kind === "Cluster" ? "database" : "secrets");
    }
  }
  for (const d of ctx.managedDbs)
    s.databases.push({ service: sandboxDbService(d.id), majorVersion: d.majorVersion, database: d.database, owner: d.owner, secretName: d.secretName, secretKeys: ["password"] });
  return { apply, refs: normalize(refs), present: s.present, databases: s.databases, edges: s.edges, unsupported };
}

// 한 문서 안에서 앞 경로가 이미 통째로 바뀐 자리면 그 아래 경로는 뺀다 (차이 경로와 같은 모양)
function normalize(refs: Map<FidelityItemId, Set<string>>): Partial<Record<FidelityItemId, string[]>> {
  const all = [...refs.values()].flatMap((x) => [...x]);
  const covered = (r: string) => all.some((o) => o !== r &&
    (o.includes(":") ? r.startsWith(`${o}.`) || r.startsWith(`${o}[`) : r.startsWith(`${o}:`)));
  const out: Partial<Record<FidelityItemId, string[]>> = {};
  for (const [k, v] of refs) {
    const kept = [...v].filter((r) => !covered(r)).sort();
    if (kept.length) out[k] = kept;
  }
  return out;
}
