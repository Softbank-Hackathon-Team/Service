import { createHash } from "node:crypto";
import type { FieldMetaV2, RbacV2, UnmappedV2 } from "@svc/contracts";
import type { RawK8sExternalSecret, RawK8sSecretStore, RawK8sConfigMapKeys, RawK8sCrdObject, RawK8sPdb, RawK8sPvc, RawK8sRole, RawK8sRoleBinding } from "./raw-k8s.js";
import { isPlainSecret, type MaskedEnv } from "./env-rewrite.js";
import { mibOf } from "./mappers/k8s-deployment.js";
import type { MappedComponent } from "./types.js";

// DRAFT(ai): k8s 네임스페이스 안의 "워크로드 밖" 객체를 IR 로 (그대로 이식). 파이프라인이 id 가 정해진 뒤 부른다. 순수 함수.
//   N3 ConfigMap 값 → 그 ConfigMap 을 쓰는 워크로드의 configs[] (평문 비밀처럼 보이는 키는 값 빼고 검토)
//   N4 PVC 객체 → volumes[].claimName 의 크기·접근
//   N5 PodDisruptionBudget → service.disruption
//   T3 Role·RoleBinding·ClusterRoleBinding → spec.rbac
//   N12 다른 CRD 객체 → unmapped C ("있지만 안 옮김")

type Obj = Record<string, unknown>;
const workloadsOf = (cs: MappedComponent[]) => cs.filter((c) => c.kind === "service" || c.kind === "job");
const sameNs = (c: MappedComponent, ns: string | undefined) => (c.native.namespace ?? "") === (ns ?? "");
const meta = (fm: FieldMetaV2, key: string, source: string, confidence: 1 | 0.9 | 0.6, rationale?: string) =>
  { fm[key] = { source, confidence, needs_review: confidence < 1, ...(rationale ? { rationale } : {}) }; };

/** 워크로드가 쓰는 ConfigMap 이름 (env·envFrom·볼륨·projected) + 그 ConfigMap 을 마운트한 주 컨테이너 경로 */
function configRefsOf(c: MappedComponent): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const add = (n: unknown, mp?: string) => { if (typeof n === "string" && n) out.set(n, out.get(n) ?? mp); };
  const p = c.props as Obj;
  const envs = [p.env, ...((p.sidecars as Obj[] | undefined) ?? []).map((x) => x.env), ...((p.initContainers as Obj[] | undefined) ?? []).map((x) => x.env)];
  for (const list of envs) for (const e of (Array.isArray(list) ? list : []) as Obj[]) add((e.fromConfig as Obj | undefined)?.config);
  for (const f of ((p.envFrom as Obj[] | undefined) ?? [])) add(f.config);
  const mounts = ((p.volumeMounts as Array<{ name: string; mountPath: string }> | undefined) ?? []);
  for (const v of ((p.podVolumes as Array<{ name: string; type: string; source: Obj }> | undefined) ?? [])) {
    if (v.type === "configMap") add(v.source.name, mounts.find((m) => m.name === v.name)?.mountPath);
    if (v.type === "projected") for (const s of (Array.isArray(v.source.sources) ? v.source.sources : []) as Obj[]) add((s.configMap as Obj | undefined)?.name);
  }
  return out;
}

const sha = (data: Record<string, string>, bin: string[]) =>
  createHash("sha256").update(JSON.stringify([Object.entries(data).sort(([a], [b]) => a.localeCompare(b)), [...bin].sort()])).digest("hex");

/** N3: ConfigMap 값 → configs[] (제자리). 평문 비밀 값은 masked 로 돌려준다 (의존성 근거로만 쓰고 안 남김) */
export function attachConfigs(components: MappedComponent[], cms: RawK8sConfigMapKeys[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): MaskedEnv[] {
  const masked: MaskedEnv[] = [];
  for (const c of workloadsOf(components)) {
    const refs = configRefsOf(c);
    if (!refs.size) continue;
    const configs: Array<Record<string, unknown>> = [];
    for (const [name, mountPath] of [...refs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const cm = cms.find((x) => x.metadata.name === name && sameNs(c, x.metadata.namespace));
      const key = `components.${c.id}.configs.${name}`;
      if (!cm) { meta(fieldMeta, key, `k8s:configmap/${name}`, 0.6, "참조하는 ConfigMap 이 출발에 없음(optional 이거나 못 읽음) → 도착에도 안 만듦. 사람이 확인"); continue; }
      const data: Record<string, string> = {};
      const hidden: string[] = [];
      for (const [k, v] of Object.entries(cm.data ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (isPlainSecret(k, v)) { hidden.push(k); masked.push({ from: c.id!, env: `configmap:${name}.${k}`, value: v }); continue; }
        data[k] = v;
      }
      // PF-A12 DRAFT(ai): ConfigMap 키 "__proto__" 는 k8s 에선 맞는 이름이지만 JS 객체·Zod record 가 조용히 버린다(읽을 때 이미 빠짐) → 못 옮김을 검토 줄로
      if ((cm.keys ?? []).includes("__proto__"))
        meta(fieldMeta, `${key}.protoKey`, `k8s:configmap/${name}`, 0.6, "키 __proto__ 는 명세에 담을 수 없음 → 도착 ConfigMap 에서 빠짐. 이 키를 쓰는 앱이면 사람이 직접 옮길 것");
      const bin = cm.binaryKeys ?? [];
      configs.push({ name, data, sha256: sha(data, bin), ...(mountPath ? { mountPath } : {}), ...(bin.length ? { binaryKeys: bin } : {}) });
      if (hidden.length) {
        meta(fieldMeta, key, `k8s:configmap/${name}`, 0.6, `평문 비밀처럼 보이는 키(${hidden.join(",")})는 값을 빼고 옮김 → 비밀 저장소로 옮겨야 함`);
        for (const k of hidden) unmapped.push({ resource: `k8s.configMap:${name}.${k}`, grade: "B", reason: "ConfigMap 안 평문 비밀로 보이는 값 → 명세에 안 넣음. 비밀(Secret)로 옮겨야 함" });
      } else if (bin.length) meta(fieldMeta, key, `k8s:configmap/${name}.binaryData`, 0.6, `binaryData 키(${bin.join(",")})는 값을 안 읽음 → 도착에 못 만듦. 사람이 확인`);
      else meta(fieldMeta, key, `k8s:configmap/${name}.data`, 1);
    }
    if (configs.length) c.props.configs = configs;
  }
  return masked;
}

const ACCESS: Record<string, "RWO" | "RWX" | "ROX"> = { ReadWriteOnce: "RWO", ReadWriteMany: "RWX", ReadOnlyMany: "ROX", ReadWriteOncePod: "RWO" };

/** N4: volumes[].claimName → PVC 객체의 크기·접근 (제자리). 못 찾으면 검토 */
export function attachPvcs(components: MappedComponent[], pvcs: RawK8sPvc[], fieldMeta: FieldMetaV2): void {
  for (const c of workloadsOf(components)) {
    const vols = (c.props.volumes as Array<Record<string, unknown>> | undefined) ?? [];
    for (const v of vols) {
      if (typeof v.claimName !== "string") continue;
      const pvc = pvcs.find((x) => x.metadata.name === v.claimName && sameNs(c, x.metadata.namespace));
      if (!pvc) { meta(fieldMeta, `components.${c.id}.volumes.${String(v.name)}`, `k8s:pvc/${v.claimName}`, 0.6, "PVC 객체를 못 읽어 크기·접근을 모름 → 사람이 확인"); continue; }
      const mib = mibOf(pvc.spec.resources?.requests?.storage);
      if (mib != null) v.sizeGb = Math.ceil(mib / 1024);
      const a = ACCESS[pvc.spec.accessModes?.[0] ?? ""];
      if (a) v.access = a;
    }
  }
}

// PD-1: 빈 matchLabels({}) = 네임스페이스 파드 전부 (k8s policy/v1 규칙). 셀렉터 칸이 아예 없으면 아무것도 안 고름
const selects = (sel: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!sel && Object.entries(sel).every(([k, v]) => labels?.[k] === v);

/** N5: PDB → service.disruption (제자리). 하나의 PDB 가 여럿을 고르거나 서비스 하나에 여럿이면 검토 */
export function attachPdbs(components: MappedComponent[], pdbs: RawK8sPdb[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): void {
  for (const p of [...pdbs].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    if (p.spec.selector?.hasExpressions) { unmapped.push({ resource: `k8s.pdb:${p.metadata.name}`, grade: "B", reason: "matchExpressions 셀렉터는 아직 못 읽음 → 사람이 확인" }); continue; }
    const owners = components.filter((c) => c.kind === "service" && sameNs(c, p.metadata.namespace) && selects(p.spec.selector?.matchLabels, c.native.labels));
    if (!owners.length) { unmapped.push({ resource: `k8s.pdb:${p.metadata.name}`, grade: "B", reason: "셀렉터에 맞는 Deployment 없음 (matchExpressions 셀렉터는 아직 못 읽음)" }); continue; }
    for (const o of owners) {
      if (o.props.disruption) { meta(fieldMeta, `components.${o.id}.disruption`, `k8s:pdb/${p.metadata.name}`, 0.6, "PDB 가 둘 이상 이 서비스를 고름 → 첫 번째만 옮김. 사람이 확인"); continue; }
      o.props.disruption = { name: p.metadata.name, ...(p.spec.minAvailable !== undefined ? { minAvailable: p.spec.minAvailable } : {}), ...(p.spec.maxUnavailable !== undefined ? { maxUnavailable: p.spec.maxUnavailable } : {}),
        ...(p.spec.unhealthyPodEvictionPolicy === "IfHealthyBudget" || p.spec.unhealthyPodEvictionPolicy === "AlwaysAllow" ? { unhealthyPodEvictionPolicy: p.spec.unhealthyPodEvictionPolicy } : {}) };
      meta(fieldMeta, `components.${o.id}.disruption`, `k8s:pdb/${p.metadata.name}`, owners.length > 1 ? 0.6 : 1, owners.length > 1 ? "PDB 하나가 Deployment 여럿을 고름 → 도착에서도 같은 셀렉터인지 사람이 확인" : undefined);
    }
  }
}

const SUBJECT_KINDS = new Set(["ServiceAccount", "User", "Group"]);
// 출발 클러스터에 기본으로 있는 ClusterRole (도착에도 같은 이름으로 있음)
const BUILTIN_CLUSTER_ROLES = new Set(["view", "edit", "admin", "cluster-admin"]);

/** T3: Role·RoleBinding·ClusterRoleBinding → spec.rbac. 이 앱 SA 와 상관없는 바인딩도 네임스페이스 것이면 그대로 (출발에 있던 것 = 도착에도) */
export function buildRbac(roles: RawK8sRole[], bindings: RawK8sRoleBinding[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): RbacV2 | undefined {
  const rb = bindings.filter((b) => b.kind === "k8s.roleBinding");
  const crb = bindings.filter((b) => b.kind === "k8s.clusterRoleBinding");
  if (!roles.length && !rb.length && !crb.length) return undefined;
  const subj = (b: RawK8sRoleBinding) => b.subjects.filter((s) => SUBJECT_KINDS.has(s.kind)).map((s) => ({ kind: s.kind as "ServiceAccount" | "User" | "Group", name: s.name, ...(s.namespace ? { namespace: s.namespace } : {}) }));
  const ref = (b: RawK8sRoleBinding) => ({ kind: b.roleRef.kind === "ClusterRole" ? "ClusterRole" as const : "Role" as const, name: b.roleRef.name });
  const byName = (a: { name: string; namespace?: string }, b: { name: string; namespace?: string }) => `${a.namespace ?? ""}/${a.name}`.localeCompare(`${b.namespace ?? ""}/${b.name}`);
  const out: RbacV2 = {
    roles: roles.map((r) => ({ name: r.metadata.name, ...(r.metadata.namespace ? { namespace: r.metadata.namespace } : {}), rules: r.rules })).sort(byName),
    roleBindings: rb.map((b) => ({ name: b.metadata.name, ...(b.metadata.namespace ? { namespace: b.metadata.namespace } : {}), roleRef: ref(b), subjects: subj(b) })).sort(byName),
    ...(crb.length ? { clusterBindings: crb.map((b) => ({ name: b.metadata.name, roleRef: ref(b), subjects: subj(b) })).sort(byName) } : {}),
  };
  meta(fieldMeta, "rbac.roles", "k8s:roles", 1);
  meta(fieldMeta, "rbac.roleBindings", "k8s:rolebindings", 1);
  for (const b of out.roleBindings)
    if (b.roleRef.kind === "ClusterRole" && !BUILTIN_CLUSTER_ROLES.has(b.roleRef.name))
      meta(fieldMeta, `rbac.roleBindings.${b.name}`, `k8s:rolebinding/${b.name}`, 0.6, `사용자 ClusterRole ${b.roleRef.name} 을 가리킴 → 도착 클러스터에 같은 ClusterRole 이 있어야 함. 사람이 확인`);
  for (const b of out.clusterBindings ?? []) {
    meta(fieldMeta, `rbac.clusterBindings.${b.name}`, `k8s:clusterrolebinding/${b.name}`, 0.6, "클러스터 단위 권한 → 도착에 자동으로 안 만듦. 사람이 확인");
    unmapped.push({ resource: `k8s.clusterRoleBinding:${b.name}`, grade: "B", reason: `클러스터 단위 권한(${b.roleRef.kind} ${b.roleRef.name}) → 도착 클러스터 관리자가 정함` });
  }
  for (const b of bindings) for (const s of b.subjects) if (!SUBJECT_KINDS.has(s.kind))
    unmapped.push({ resource: `${b.kind}:${b.metadata.name}.subject:${s.kind}/${s.name}`, grade: "C", reason: "모르는 주체 종류" });
  return out;
}

/** N12: 다른 CRD 객체 → unmapped C (이름만) */
export function crdUnmapped(objs: RawK8sCrdObject[]): UnmappedV2[] {
  return objs.map((o) => ({ resource: `crd:${o.resource}:${o.metadata.namespace ? `${o.metadata.namespace}/` : ""}${o.metadata.name}`, grade: "C" as const,
    reason: "앱 쪽 사용자 정의 자원(CRD) → 이번 이전에서 안 옮김. 도착에 같은 CRD·컨트롤러가 있는지 사람이 확인" }));
}

/** SS-V: ExternalSecret 이 만드는 k8s Secret 을 쓰는 워크로드 → secretSources (제자리). 값·인증 칸은 없음 */
export function attachExternalSecrets(components: MappedComponent[], ess: RawK8sExternalSecret[], stores: RawK8sSecretStore[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): void {
  const used = new Set<RawK8sExternalSecret>();
  for (const c of workloadsOf(components)) {
    const p = c.props as Obj;
    const names = new Set<string>();
    const envs = [p.env, ...((p.sidecars as Obj[] | undefined) ?? []).map((x) => x.env), ...((p.initContainers as Obj[] | undefined) ?? []).map((x) => x.env)];
    for (const list of envs) for (const e of (Array.isArray(list) ? list : []) as Obj[]) { const s = (e.fromSecret as Obj | undefined)?.secret; if (typeof s === "string") names.add(s); }
    for (const f of ((p.envFrom as Obj[] | undefined) ?? [])) if (typeof f.secret === "string") names.add(f.secret);
    for (const m of ((p.secretMounts as Obj[] | undefined) ?? [])) if (typeof m.secret === "string") names.add(m.secret);
    const srcs = [...((p.secretSources as Obj[] | undefined) ?? [])];
    for (const es of ess.filter((x) => sameNs(c, x.metadata.namespace) && names.has(x.spec.target)).sort((a, b) => a.spec.target.localeCompare(b.spec.target))) {
      used.add(es);
      const st = es.spec.store.kind === "SecretStore" ? stores.find((x) => x.metadata.name === es.spec.store.name && sameNs(c, x.metadata.namespace)) : undefined;
      srcs.push({ via: "eso", secret: es.spec.target, store: `${es.spec.store.kind}/${es.spec.store.name}`, ...(st ? { provider: st.provider } : {}),
        refs: [...es.spec.data.map((d) => ({ key: d.key, remote: d.remote, ...(d.property ? { property: d.property } : {}) })), ...es.spec.dataFrom.map((k) => ({ key: "*", remote: k }))].slice(0, 100) });
      meta(fieldMeta, `components.${c.id}.secretSources.${es.spec.target}`, `k8s:externalsecret/${es.metadata.name}`, 0.6,
        `비밀 ${es.spec.target} 는 ${es.spec.store.kind}/${es.spec.store.name}${st ? `(${st.provider})` : ""} 에서 옴 → 도착 저장소로 값 복사·같은 원격 키를 사람이 확인`);
    }
    if (srcs.length) c.props.secretSources = srcs;
  }
  for (const es of ess) if (!used.has(es))
    unmapped.push({ resource: `k8s.externalSecret:${es.metadata.namespace ?? ""}/${es.metadata.name}`, grade: "B", reason: `만드는 Secret ${es.spec.target} 를 쓰는 워크로드가 없음 → 안 옮김` });
}
