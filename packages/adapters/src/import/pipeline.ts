import type { FieldMetaV2, ImportResultV2, RawInventory, SourceDbFacts, UnmappedV2 } from "@svc/contracts";
import { assignIds, slug } from "./ids.js";
import { addressesOf, inferLinks } from "./links.js";
import { flagSourceDataHosts, maskPlainSecrets, rewriteEnv, rewritePortEnv } from "./env-rewrite.js";
import { inferDbIdentity } from "./db-identity.js";
import { attachEndpoints, buildEntry, mergeRoutes } from "./entry.js";
import { mergeGatewayRoutes } from "./gateway-api.js";
import { attachDns, DNS_RECORD_KIND, DNS_UNREAD_KIND } from "./dns-records.js";
import { buildPosture } from "./posture.js";
import { applyBoundary } from "./boundary.js";
import { selectAppGroup } from "./app-group.js";
import { sourceDbFactsOf } from "./security-facts.js";
import { detectInCluster, inClusterComponent, linkInCluster } from "./in-cluster-data.js";
import { PICK_KIND, UNREAD_KIND, type RawPick, type RawUnread } from "../common/unread.js";
import { K8S_RAW_KINDS, type RawK8sConfigMapKeys, type RawK8sCrdObject, type RawK8sHpa, type RawK8sIngress, type RawK8sJob, type RawK8sNamespace, type RawK8sNetworkPolicy, type RawK8sPdb, type RawK8sPvc, type RawK8sRole, type RawK8sRoleBinding, type RawK8sService, type RawK8sUnread,
  type RawK8sGateway, type RawK8sHttpRoute, type RawK8sGrpcRoute, type RawK8sExternalSecret, type RawK8sSecretStore } from "./raw-k8s.js";
import { buildSecrets } from "./secrets.js";
import { attachConfigs, attachExternalSecrets, attachPdbs, attachPvcs, buildRbac, crdUnmapped } from "./k8s-extras.js";
import { k8sDeploymentMapper } from "./mappers/k8s-deployment.js";
import { k8sCronJobMapper } from "./mappers/k8s-cronjob.js";
import { k8sDaemonSetMapper, k8sStatefulSetMapper } from "./mappers/k8s-statefulset.js";
import { rdsMapper } from "./mappers/rds.js";
import { cloudSqlMapper } from "./mappers/cloudsql.js";
import { cnpgMapper } from "./mappers/cnpg.js";
import type { RawDnsRecord, RawEgress } from "../discover/net.js";
import { gcpBindingToPolicy, type RawAwsIamPolicy, type RawGcpIamBindingLike } from "./mappers/iam-grants.js";
import { s3Mapper } from "./mappers/s3.js";
import { sqsMapper } from "./mappers/sqs.js";
import { snsMapper } from "./mappers/sns.js";
import { elasticacheMapper } from "./mappers/elasticache.js";
import { gcsMapper } from "./mappers/gcs.js";
import { pubsubMapper } from "./mappers/pubsub.js";
import { memorystoreMapper } from "./mappers/memorystore.js";
import { ecsServiceMapper } from "./mappers/ecs-service.js";
import { vmInstanceMapper } from "./mappers/vm-instance.js";
import { cloudRunJobMapper, cloudRunServiceMapper } from "./mappers/cloudrun-service.js";
import type { KindMapper, MappedComponent, NormalizeV2Options, NormalizeV2Output, RawItem } from "./types.js";

// DRAFT(ai): 원본(RawInventory) → 공통 명세 v2 (설계 20번 5.1~5.5장, 24번 I3a). 순수 함수, 네트워크·환경변수 안 읽음.
//   1) 종류 붙이기(매퍼)  2) id 정하기  3) Service·HPA 접기  4) 평문 비밀 가리기  5) 의존성 추론 + env 다시 쓰기
//   5b) 앱 경계(BOUNDARY: 서비스가 근거로 닿는 데이터 자원만)  6) 라우팅  7) 보안 기준선. 같은 원본이면 글자 하나까지 같은 결과(목록 정렬).
//   검증(checkV2)·저장은 부르는 쪽(import.ts, I3b) 몫.

// I9: ECS 서비스 매퍼 (관리형 컨테이너 출발 갈래)
export const KIND_MAPPERS: KindMapper[] = [k8sDeploymentMapper, k8sCronJobMapper,
  k8sStatefulSetMapper, k8sDaemonSetMapper,   // D6: 도착에서도 같은 종류
  rdsMapper, cloudSqlMapper, cnpgMapper,
  s3Mapper, sqsMapper, snsMapper, elasticacheMapper, gcsMapper, pubsubMapper, memorystoreMapper,   // I6: 객체 저장소·큐·캐시
  ecsServiceMapper,
  vmInstanceMapper,   // VMIMPORT: VM 출발 갈래(EC2·GCE)
  cloudRunServiceMapper, cloudRunJobMapper];   // CRIMPORT: Cloud Run 서비스·잡 (관리형 컨테이너 출발 갈래, GCP)
const MAPPER_BY_TYPE = new Map(KIND_MAPPERS.flatMap((m) => m.nativeTypes.map((t) => [t, m] as const)));

// 앱 리소스는 아니지만 아는 것: 근거(다른 리소스에 접힘) / 환경(도착에서 env 층이 다시 만듦)
// R5: serviceAccount·configMapKeys 는 근거·환경 종류로 등록 (unmapped C 로 안 셈)
export const EVIDENCE_TYPES = new Set<string>([K8S_RAW_KINDS.service, K8S_RAW_KINDS.ingress, K8S_RAW_KINDS.hpa, K8S_RAW_KINDS.networkPolicy, K8S_RAW_KINDS.serviceAccount, K8S_RAW_KINDS.configMapKeys, K8S_RAW_KINDS.namespace, "aws.iamPolicy", "gcp.iamBinding", "net.egress", "dns.record",
  // N4·N5·T3·N12: 다른 리소스에 접히거나(PVC·PDB·RBAC) 목록으로만 남는(CRD) 종류
  K8S_RAW_KINDS.pvc, K8S_RAW_KINDS.pdb, K8S_RAW_KINDS.role, K8S_RAW_KINDS.roleBinding, K8S_RAW_KINDS.clusterRoleBinding, K8S_RAW_KINDS.crdObject,
  // GW-1·GW-2: 라우팅(entry)으로 접히는 Gateway API·공개 DNS 레코드. SS-V: 비밀 출처(워크로드 secretSources 로 접힘)
  K8S_RAW_KINDS.gateway, K8S_RAW_KINDS.httpRoute, K8S_RAW_KINDS.grpcRoute, K8S_RAW_KINDS.externalSecret, K8S_RAW_KINDS.secretStore, DNS_RECORD_KIND, DNS_UNREAD_KIND]);
export const ENVIRONMENT_TYPES = new Set<string>(["eks.cluster", "gke.cluster", "k8s.node", "aws.vpc", "gcp.network", "aws.ecr", "gcp.artifactRepo", "aws.alb", "gcp.forwardingRule", "aws.secret", "gcp.secret", "import.note", "ecs.cluster"]);

// D6: HPA scaleTargetRef.kind → 원본 종류
const HPA_TARGET: Record<string, string> = { Deployment: K8S_RAW_KINDS.deployment, StatefulSet: K8S_RAW_KINDS.statefulset };

/** NS-1·M-1: 워크로드 네임스페이스 → IR namespaces (이름순). 라벨은 discover 가 허용 목록으로 이미 거름 */
function namespacesOf(components: MappedComponent[], objs: RawK8sNamespace[], fieldMeta: FieldMetaV2): NonNullable<ImportResultV2["spec"]["namespaces"]> {
  const names = [...new Set(components.filter((c) => (c.kind === "service" || c.kind === "job") && c.native.type.startsWith("k8s.") && c.native.namespace).map((c) => c.native.namespace!))].sort();
  return names.map((name) => {
    const o = objs.find((x) => x.metadata.name === name);
    if (!o) fieldMeta[`namespaces.${name}`] = { source: `k8s:namespace/${name}`, confidence: 0.6, needs_review: true,
      rationale: "네임스페이스 객체를 못 읽음 → 라벨(파드 보안 수준·메시 주입)이 있었는지 모름. 도착은 라벨 없이 만듦" };
    else fieldMeta[`namespaces.${name}`] = { source: `k8s:namespace/${name}`, confidence: 1, needs_review: false };
    const labels = o?.metadata.labels, annotations = o?.metadata.annotations;
    return { name, ...(labels && Object.keys(labels).length ? { labels } : {}), ...(annotations && Object.keys(annotations).length ? { annotations } : {}) };
  });
}

const resName = (it: RawItem): string => {
  const md = it.metadata as { name?: string } | undefined;
  const n = md?.name ?? it.name ?? it.Name ?? it.DBInstanceIdentifier ?? it.serviceName ?? "?";
  return `${it.kind}:${String(n)}`;
};

export function normalizeV2(raw: RawInventory, opts: NormalizeV2Options = {}): NormalizeV2Output {
  const items = (raw.items as RawItem[]).filter((x) => x && typeof x === "object" && typeof x.kind === "string");
  const mapped: MappedComponent[] = [];
  const fieldMeta: FieldMetaV2 = {};
  const unmapped: UnmappedV2[] = [];
  const environment: string[] = [];
  const twinOf = new Map<MappedComponent, MappedComponent>();   // INCL: 클러스터 안 데이터 자원 → 그 워크로드
  const dbFacts = new Map<MappedComponent, SourceDbFacts>();   // 출발 DB 보안 사실 (id 가 붙기 전이라 구성요소로 잇는다)

  // 1) 종류 붙이기. 매퍼 하나가 터져도 그 자원만 unmapped
  for (const it of items) {
    // RF-1: discover 가 못 읽은 종류 → 검토 줄 (사람이 PATCH confirm 으로 확인). "없음"으로 넘어가지 않게
    if (it.kind === UNREAD_KIND || it.kind === PICK_KIND) {
      const u = it as unknown as RawUnread | RawPick;
      const head = u.kind === PICK_KIND ? "check.pick" : "check.unread";
      let key = `${head}.${u.what}`;
      for (let n = 2; fieldMeta[key]; n++) key = `${head}.${u.what}#${n}`;
      fieldMeta[key] = { source: `discover:${u.what}`, confidence: 0.6, needs_review: true,
        rationale: u.kind === PICK_KIND ? `${u.reason} → 이전의 출발 범위(sourceScope)를 안 정해 자동으로 고름. 맞는지 사람이 확인` : `${u.reason} → "없음"이 아니라 못 읽음. 출발에 있는지 사람이 확인` };
      continue;
    }
    const mapper = MAPPER_BY_TYPE.get(it.kind);
    if (mapper) {
      try {
        const c = mapper.map(it);
        if ("skip" in c) unmapped.push({ resource: resName(it), grade: c.grade ?? "C", reason: c.skip });
        else {
          mapped.push(c);
          // INCL: 클러스터 안 데이터 서비스(이미지·라벨·포트)면 같은 출발을 가리키는 데이터 자원을 하나 더
          const d = (it.kind === K8S_RAW_KINDS.deployment || it.kind === K8S_RAW_KINDS.statefulset) && c.kind === "service" ? detectInCluster(it) : null;
          if (d) { const t = inClusterComponent(c, d); mapped.push(t); twinOf.set(t, c); }
          // N4: 일부 칸을 못 옮긴 리소스 (모르는 볼륨 종류 등) → 숨기지 않고 unmapped B
          for (const p of c.partial ?? []) unmapped.push({ resource: `${resName(it)}.${p.resource}`, grade: "B", reason: p.reason });
          const f = c.kind === "postgres" ? sourceDbFactsOf(it) : null;
          if (f) dbFacts.set(c, f);
        }
      } catch (err) {
        unmapped.push({ resource: resName(it), grade: "C", reason: `매퍼 오류: ${err instanceof Error ? err.message : String(err)}` });
      }
      continue;
    }
    // F-1: 목록을 못 읽은 종류 → "못 읽음" 검토 줄. "비어 있음"과 구별 (값 없음, 이유만)
    if (it.kind === K8S_RAW_KINDS.unread) {
      const u = it as unknown as RawK8sUnread;
      // PF-A11 DRAFT(ai): 키에 빈칸이 들어가면(CRD <종류>, Gateway <ns>/<이름>) PATCH confirm 경로 모양(\S)에 안 맞아 400 → 확인 못 해 spec_review 에서 못 나감.
      //   빈칸은 ':' 로 바꾼다 (이유 글의 이름은 그대로)
      fieldMeta[`unread.${u.resource.trim().replace(/\s+/g, ":")}`] = { source: u.source ?? `k8s:list ${u.resource}`, confidence: 0.6, needs_review: true,
        rationale: u.source === "aws:iam" ? `앱 신원 권한(${u.resource})을 못 읽음 (${String(u.reason).slice(0, 120)}) → 도착 앱 권한이 비어 403 일 수 있음. 관찰 역할에 IAM 읽기를 더해 다시 가져오거나 grants 를 직접 적을 것`
          : `${u.resource} 목록을 못 읽음 (${String(u.reason).slice(0, 120)}) → 이 종류가 명세에서 빠졌을 수 있음. 권한을 고쳐 다시 가져오거나 없어도 되는지 확인` };
      continue;
    }
    // JB-1 DRAFT(ai): 일회성 Job 은 도착에서 다시 돌리면 해로울 수 있어(마이그레이션·일괄 처리) 옮기지 않는다. 도는 중이면 사람이 확인
    if (it.kind === K8S_RAW_KINDS.job) {
      const j = it as unknown as RawK8sJob;
      unmapped.push(j.status?.active
        ? { resource: resName(it), grade: "B", reason: `일회성 Job 이 아직 도는 중(파드 ${j.status.active}개) → 도착에서 다시 돌릴지·끝날 때까지 기다릴지 사람이 정함` }
        : { resource: resName(it), grade: "C", reason: "일회성 Job 은 안 옮김 (끝난 Job 을 도착에서 다시 돌리면 위험)" });
      continue;
    }
    if (EVIDENCE_TYPES.has(it.kind)) continue;
    if (ENVIRONMENT_TYPES.has(it.kind)) { environment.push(it.kind); continue; }
    unmapped.push({ resource: resName(it), grade: "C", reason: "카탈로그에 종류 없음 → 출발에 두고 연결 유지가 기본(6.10장)" });
  }
  // AN-1: 허용 목록 밖이라 안 읽은 annotation → 키 이름만 unmapped B (숨기지 않음. 동작 키면 사람이 허용 목록에 더하거나 도착에서 다시 정함)
  for (const it of items) {
    const md = it.metadata as { name?: string; namespace?: string; droppedAnnotations?: string[] } | undefined;
    if (!md?.droppedAnnotations?.length) continue;
    unmapped.push({ resource: `${it.kind}:${md.namespace ? `${md.namespace}/` : ""}${md.name ?? "?"}.annotations`, grade: "B",
      reason: `허용 목록 밖 annotation(${md.droppedAnnotations.join(",")})은 값을 안 읽어 도착에 안 옮김. 동작을 바꾸는 키면 사람이 확인` });
  }
  const evidence = <T>(kind: string) => items.filter((i) => i.kind === kind) as unknown as T[];
  const svcObjs = evidence<RawK8sService>(K8S_RAW_KINDS.service).filter((s) => s.metadata && s.spec);
  const ingresses = evidence<RawK8sIngress>(K8S_RAW_KINDS.ingress).filter((s) => s.metadata && s.spec);
  const hpas = evidence<RawK8sHpa>(K8S_RAW_KINDS.hpa).filter((s) => s.metadata && s.spec?.scaleTargetRef);
  const policies = evidence<RawK8sNetworkPolicy>(K8S_RAW_KINDS.networkPolicy).filter((s) => s.metadata);

  // 2) id
  const ids = assignIds(mapped, opts.previousIds ?? {});
  for (const [t, w] of twinOf) (t.props.inCluster as { workload: string }).workload = w.id!;
  let components = mapped.sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0));
  // I6: 큐의 DLQ 참조(ARN·토픽 이름) → 같은 가져오기 안의 큐 id. 못 찾으면(다른 계정·리전) to 를 비우고 검토 표시
  for (const q of components) {
    if (!q.deadLetterRef) continue;
    const dl = q.props.deadLetter as { to?: string; maxReceive?: number };
    // VI6: 이름만 같은 다른 계정·프로젝트의 큐를 잇지 않는다. ARN·전체 이름(uid)이 있으면 uid 로만, uid 를 못 읽은 큐일 때만 이름으로
    const ref = q.deadLetterRef;
    const queues = components.filter((o) => o !== q && o.kind === "queue");
    const target = queues.find((o) => o.native.uid === ref.arn) ?? queues.find((o) => !o.native.uid && o.native.name === ref.name);
    if (target) {
      dl.to = target.id;
      // E2EDATA2 DRAFT(ai): Pub/Sub 의 DLQ 는 늘 다른 토픽이다. 도착 검증(v2Blockers)은 DLQ 대상이 model=queue 여야 해서 이대로면 Pub/Sub 출발 + DLQ 는 전부 막힘.
      //   DLQ 로 쓰이는 토픽은 모아 두고 꺼내 읽는 큐이므로 model 을 queue 로 올리고 검토 표시 (팀 검토 대상)
      // PS-1: 구독이 여럿인 토픽(subscriptions 목록)은 올리지 않는다 (v2Blockers 가 "topic 이라 DLQ 가 될 수 없음"으로 막음)
      if (target.props.model === "topic" && !Array.isArray(target.props.subscriptions)) {
        target.props.model = "queue";
        target.meta.model = [target.meta.model?.[0] ?? "dlq", 0.9, `${q.id} 의 DLQ 대상으로 쓰이는 토픽 → 꺼내 읽는 queue 로 둠. 사람 확인 필요`];
      }
    }
    else q.meta.deadLetter = [q.meta.deadLetter?.[0] ?? "dlq", 0.6, `DLQ ${q.deadLetterRef.name} 를 이 가져오기에서 못 찾음 (다른 계정·리전일 수 있음)`];
  }
  // B-1b·B-2: 버킷 알림·토픽 구독 대상 → 같은 가져오기 안의 큐 id (uid = ARN·토픽 전체 이름). 못 찾으면 to 없이 검토
  for (const c of components) for (const r of c.notifyRefs ?? []) {
    const list = c.props[r.field] as Array<{ to?: string }> | undefined;
    const t = components.find((o) => o !== c && o.kind === "queue" && o.native.uid === r.uid);
    if (t && list?.[r.index]) list[r.index]!.to = t.id;
    else c.meta[r.field] = [c.meta[r.field]?.[0] ?? r.field, 0.6, `대상 ${r.uid.split(/[:/]/).pop()} 를 이 가져오기에서 못 찾음 (다른 계정·리전일 수 있음) → 사람이 확인`];
  }
  for (const c of components)
    for (const [k, [source, confidence, rationale]] of Object.entries(c.meta))
      fieldMeta[`components.${c.id}.${k}`] = { source, confidence, needs_review: confidence < 1, ...(rationale ? { rationale } : {}) };

  // 3) k8s Service 객체 → endpoints, HPA → replicas 범위 + scale (따로 종류를 두지 않는다)
  const serviceAliases = attachEndpoints(components, [...svcObjs].sort((a, b) => `${a.metadata.namespace ?? ""}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace ?? ""}/${b.metadata.name}`)), unmapped, fieldMeta);
  for (const h of hpas) {
    // D6: 대상 종류까지 맞춘다 (같은 이름의 Deployment·StatefulSet 이 있을 수 있음). kind 가 없으면 이름만 (옛 원본)
    const tk = h.spec.scaleTargetRef.kind;
    const s = components.find((c) => c.kind === "service" && c.native.name === h.spec.scaleTargetRef.name && (!h.metadata.namespace || h.metadata.namespace === c.native.namespace)
      && (!tk || c.native.type === HPA_TARGET[tk]));
    if (!s) { unmapped.push({ resource: `k8s.hpa:${h.metadata.name}`, grade: "C", reason: `대상 ${tk ?? "워크로드"} 를 못 찾음` }); continue; }
    const metrics = (h.spec.metrics ?? []) as Array<{ type?: string; resource?: { name?: string; target?: { type?: string; averageUtilization?: number } } }>;
    const cpu = metrics.find((x) => x.resource?.name === "cpu" && (x.resource.target?.type ?? "Utilization") === "Utilization")?.resource?.target?.averageUtilization;
    s.props.replicas = { min: h.spec.minReplicas ?? 1, max: h.spec.maxReplicas };
    fieldMeta[`components.${s.id}.replicas`] = { source: `k8s:hpa/${h.metadata.name}.spec.min/maxReplicas`, confidence: 1, needs_review: false };
    // N7 DRAFT(ai): 지표·확장 속도(behavior)를 원문 그대로. CPU 사용률 하나뿐이어도 metrics 를 같이 담아 도착이 같은 HPA 를 그림
    const scale: Record<string, unknown> = {};
    if (typeof cpu === "number") scale.targetCpuPct = cpu;
    if (metrics.length) scale.metrics = metrics;
    if (h.spec.behavior) scale.behavior = h.spec.behavior;
    if (Object.keys(scale).length) {
      s.props.scale = scale;
      fieldMeta[`components.${s.id}.scale`] = { source: `k8s:hpa/${h.metadata.name}.metrics${h.spec.behavior ? "·behavior" : ""}`, confidence: 1, needs_review: false };
    } else {
      fieldMeta[`components.${s.id}.scale`] = { source: `k8s:hpa/${h.metadata.name}`, confidence: 0.9, needs_review: true, rationale: "HPA 에 지표가 없음 = k8s 기본(CPU 80%) → 도착도 지표 없이 같은 HPA" };
    }
  }

  // 3b) PARTOF: 앱 묶음 라벨(part-of 등)이 있으면 그 묶음 워크로드만. 데이터 자원 경계(5b)는 남은 워크로드 기준
  const grouped = selectAppGroup(components, fieldMeta, opts.partOf);
  components = grouped.components;
  // INCL: 워크로드가 앱 묶음 밖으로 빠졌으면 그 데이터 자원도 뺀다 (가리킬 워크로드가 없음)
  const dropped = [...twinOf].filter(([t, w]) => components.includes(t) && !components.includes(w)).map(([t]) => t);
  if (dropped.length) {
    components = components.filter((c) => !dropped.includes(c));
    for (const t of dropped) for (const k of Object.keys(fieldMeta)) if (k.startsWith(`components.${t.id}.`)) delete fieldMeta[k];
  }

  // 3c) N3·N4·N5: ConfigMap 값·PVC 크기·PDB 를 워크로드에 붙인다 (경계 안 워크로드만)
  const cmMasked = attachConfigs(components, evidence<RawK8sConfigMapKeys>(K8S_RAW_KINDS.configMapKeys).filter((x) => x.metadata), fieldMeta, unmapped);
  attachPvcs(components, evidence<RawK8sPvc>(K8S_RAW_KINDS.pvc).filter((x) => x.metadata && x.spec), fieldMeta);
  attachPdbs(components, evidence<RawK8sPdb>(K8S_RAW_KINDS.pdb).filter((x) => x.metadata && x.spec), fieldMeta, unmapped);
  attachExternalSecrets(components, evidence<RawK8sExternalSecret>(K8S_RAW_KINDS.externalSecret).filter((x) => x.metadata && x.spec),
    evidence<RawK8sSecretStore>(K8S_RAW_KINDS.secretStore).filter((x) => x.metadata), fieldMeta, unmapped);   // SS-V

  // 3d) E-2: 출발 사설 DNS 이름 → 그 이름이 가리키는 데이터 자원의 별칭 (앱이 db.internal.example 처럼 적어도 링크가 이어짐, 다시 쓰기는 host)
  //   CNAME 이 다른 사설 이름을 가리키면 한 번 더 따라간다. 워크로드(서비스)는 이 길로 안 잇는다 (k8s 서비스 이름 규칙이 따로 있음)
  const dnsRecords = evidence<RawDnsRecord>("dns.record").filter((r) => typeof r.name === "string" && Array.isArray(r.values))
    .sort((a, b) => (`${a.name}/${a.type}` < `${b.name}/${b.type}` ? -1 : 1));
  const dnsTo = new Map<RawDnsRecord, MappedComponent>();
  const dataTargets = components.filter((c) => c.kind !== "service" && c.kind !== "job");
  for (let pass = 0; pass < 2; pass++) for (const r of dnsRecords) {
    if (dnsTo.has(r)) continue;
    const t = dataTargets.find((c) => addressesOf(c).some((a) => r.values.includes(a.toLowerCase().replace(/\.$/, ""))));
    if (!t) continue;
    dnsTo.set(r, t);
    t.native.aliases = [...new Set([...(t.native.aliases ?? []), r.name])];
    t.native.aliasOutputs = { ...(t.native.aliasOutputs ?? {}), [r.name]: "host" };
  }

  // 4) 평문 비밀 → 명세에서 뺌 (의존성 추론 전에: 비밀 값이 근거가 되지 않게). N3: ConfigMap 안 평문 비밀도 근거로만
  const masked = [...maskPlainSecrets(components, fieldMeta, unmapped), ...cmMasked];

  // 5) 의존성 + env 다시 쓰기
  // I4: 앱 신원의 IAM 정책 (discover 가 IAM 읽기를 켰을 때만 원본에 있음. 없으면 지금 그대로)
  // WI-1: GKE Workload Identity 바인딩도 같은 길 (역할 → 공통 동작 이름)
  const iamPolicies = [...evidence<RawAwsIamPolicy>("aws.iamPolicy"),
    ...evidence<RawGcpIamBindingLike>("gcp.iamBinding").filter((b) => typeof b.gsa === "string" && Array.isArray(b.roles)).map(gcpBindingToPolicy)]
    .filter((p) => typeof p.roleName === "string" && typeof p.serviceAccount === "string");
  const { links: allLinks, meta, envHits, permissions, unmapped: iamUnmapped } = inferLinks(components, masked, iamPolicies);
  unmapped.push(...iamUnmapped);
  Object.assign(fieldMeta, meta);
  linkInCluster(components, allLinks, fieldMeta);   // INCL: 앱 → 클러스터 안 데이터 자원
  // 5b) BOUNDARY: 계정 전체를 읽은 데이터 자원 중 이 앱이 근거로 닿는 것만. 나머지는 outOfBoundary (이름·종류만)
  const bounded = applyBoundary(components, allLinks, fieldMeta);
  // G3b-3: 출발에 Postgres 가 있었는데 경계 안에 하나도 없으면(근거를 못 찾음) 조용히 DB 없는 명세가 되지 않게 검토 줄
  const pgOut = bounded.outOfBoundary.filter((o) => o.kind === "postgres");
  if (pgOut.length && !bounded.components.some((c) => c.kind === "postgres") && bounded.components.some((c) => c.kind === "service" || c.kind === "job"))
    fieldMeta["check.boundary.postgres"] = { source: "boundary", confidence: 0.6, needs_review: true,
      rationale: `출발에 Postgres ${pgOut.length}개(${pgOut.map((o) => o.resource.split(":").pop()).slice(0, 5).join(", ")}${pgOut.length > 5 ? " …" : ""})가 있지만 이 앱이 닿는 근거(env·비밀·IAM)를 못 찾아 명세에 DB 가 없음. 앱 DB 가 있으면 경계 밖 목록에서 끌어옴` };
  components = bounded.components;
  const links = bounded.links;
  inferDbIdentity(components, envHits, masked, links, fieldMeta);   // DBN-1·E10-2: 앱이 붙는 DB 이름·계정 (주소 다시 쓰기 전 글자에서)
  rewriteEnv(components, envHits, fieldMeta);
  rewritePortEnv(components, links, fieldMeta);   // DM-7: 따로 적힌 포트 env
  flagSourceDataHosts(components, fieldMeta);      // FM-IR-C07: 명세에 없는 출발 DB·캐시 주소가 글자 그대로 남으면 검토 줄
  // 5c) T1·SC-1·CA-1: 비밀 표 (이름·type·키 이름·짝). env 다시 쓰기 뒤라 대상 주소 env 가 fromLink·template 으로 보인다
  const secrets = buildSecrets(components, links, ingresses, fieldMeta);

  // 6) 라우팅, 7) 보안 기준선
  // I9: ECS ALB 규칙은 k8s Ingress 뒤에 합친다 (k8s 만이면 그대로)
  const entry = mergeGatewayRoutes(mergeRoutes(buildEntry(components, svcObjs, ingresses, fieldMeta, unmapped), components, fieldMeta), components, svcObjs, {
    gateways: evidence<RawK8sGateway>(K8S_RAW_KINDS.gateway).filter((x) => x.metadata && x.spec),
    httpRoutes: evidence<RawK8sHttpRoute>(K8S_RAW_KINDS.httpRoute).filter((x) => x.metadata && x.spec),
    grpcRoutes: evidence<RawK8sGrpcRoute>(K8S_RAW_KINDS.grpcRoute).filter((x) => x.metadata && x.spec),
  }, fieldMeta, unmapped);
  attachDns(entry, items as Record<string, unknown>[], fieldMeta);   // GW-2
  const posture = buildPosture(components, policies);
  // T3·N12
  const rbac = buildRbac(evidence<RawK8sRole>(K8S_RAW_KINDS.role).filter((x) => x.metadata && Array.isArray(x.rules)),
    [...evidence<RawK8sRoleBinding>(K8S_RAW_KINDS.roleBinding), ...evidence<RawK8sRoleBinding>(K8S_RAW_KINDS.clusterRoleBinding)].filter((x) => x.metadata && x.roleRef && Array.isArray(x.subjects)),
    fieldMeta, unmapped);
  unmapped.push(...crdUnmapped(evidence<RawK8sCrdObject>(K8S_RAW_KINDS.crdObject).filter((x) => x.metadata)));
  // NS-1·M-1: 경계 안 워크로드가 쓰는 네임스페이스 (허용 목록 라벨·annotation). 객체를 못 읽었으면 이름만 + 검토
  const namespaces = namespacesOf(components, evidence<RawK8sNamespace>(K8S_RAW_KINDS.namespace).filter((n) => n.metadata?.name), fieldMeta);
  posture.permissions.push(...permissions);
  // E-1: 출발 나가는 IP. 여러 NAT 이면 합친다. 계획 줄(PC-V2-EGRESS)로 "파트너 허용 목록 바꿔야 함"을 띄운다
  const egress = evidence<RawEgress>("net.egress").filter((e) => Array.isArray(e.ips));
  if (egress.length) {
    posture.egress = { source: [...new Set(egress.map((e) => e.source))].sort().join("+").slice(0, 64),
      ips: [...new Set(egress.flatMap((e) => e.ips))].sort().slice(0, 20),
      fixed: egress.some((e) => e.fixed === false) ? false : egress.some((e) => e.fixed === true) ? true : null };
    fieldMeta["posture.egress"] = { source: posture.egress.source, confidence: 1, needs_review: false,
      rationale: "출발 나가는 IP. 도착은 다른 IP 라 파트너 허용 목록을 바꿔야 할 수 있음 (계획 승인 줄)" };
  }
  // E-2: 경계 안 자원을 가리키는 사설 DNS 레코드만 IR 에 (값은 출발 주소라 안 담음)
  const kept = new Set(components.map((c) => c.id!));
  const privateDns = [...dnsTo].filter(([, t]) => kept.has(t.id!)).slice(0, 100)
    .map(([r, t]) => ({ zone: r.zone, name: r.name, type: r.type as "A" | "AAAA" | "CNAME", to: t.id! }));
  if (privateDns.length) fieldMeta.privateDns = { source: "dns:private-zone", confidence: 1, needs_review: false,
    rationale: "출발 사설 DNS 이름. 도착에 같은 이름이 없으면 설정 파일 속 이름은 안 풀림 (계획 승인 줄)" };

  // 경계 안 postgres 만. 경계 밖에서 끌어온 것(BOUNDPULL)은 사실 없음 = 판정에서 모름
  const securityFacts = Object.fromEntries(components.flatMap((c) => { const f = dbFacts.get(c); return f ? [[c.id!, f] as const] : []; }));
  const firstService = components.find((c) => c.kind === "service") ?? components[0];
  // G3b-5 DRAFT(ai): 앱 이름 = 도착 네임스페이스·DB·비밀 이름의 뿌리라 근거가 센 것부터. 첫 서비스 id 는 다시 가져올 때 바뀔 수 있어 마지막 + 검토
  const prev = opts.previousApp;
  const [appName, appMeta]: [string, FieldMetaV2[string]] =
    prev?.meta?.source === "human" ? [prev.name, prev.meta]
    : opts.appName ? [opts.appName, { source: "input:appName", confidence: 1, needs_review: false }]
    // 앞 판 이름을 이어받는다. 앞 판에서 아직 검토 전이었으면 검토 표시도 그대로 (이어받았다고 확신으로 바뀌지 않게)
    : prev ? [prev.name, prev.meta?.needs_review ? { ...prev.meta, rationale: (prev.meta.rationale ?? "").startsWith("앞 판 이름을 이어받음.") ? prev.meta.rationale : `앞 판 이름을 이어받음. ${prev.meta.rationale ?? ""}`.trim() }   // 통합: 다시 가져올 때마다 앞말이 쌓이지 않게 (멱등)
        : { source: "previous:app.name", confidence: 1, needs_review: false, rationale: "앞 판 이름을 이어받음 (다시 가져와도 안 바뀜)" }]
    : grouped.chosen ? [grouped.chosen, { source: "label:part-of", confidence: 0.9, needs_review: true, rationale: `앱 묶음 라벨 값 ${grouped.chosen} 을 앱 이름으로 둠. 도착 네임스페이스·자원 이름에 들어가니 확인` }]
    : [firstService?.id ?? "app", { source: "heuristic:first-service", confidence: 0.6, needs_review: true,
        rationale: `이름순 첫 서비스 ${firstService?.id ?? "app"} 를 앱 이름으로 둠 (다른 앱과 겹치기 쉬움). 이전 만들 때 sourceScope.appName 으로 정하거나 app.name 을 고침` }];
  fieldMeta["app.name"] = appMeta;
  const result: ImportResultV2 = {
    spec: {
      schemaVersion: "2",
      app: { name: slug(appName) },
      components: components.map(({ id, kind, props }) => ({ id: id!, kind, props }) as unknown as ImportResultV2["spec"]["components"][number]),
      links,
      ...(entry ? { entry } : {}),
      posture,
      ...(rbac ? { rbac } : {}),
      ...(secrets.length ? { secrets } : {}),
      ...(privateDns.length ? { privateDns } : {}),
      ...(namespaces.length ? { namespaces } : {}),
      ...(serviceAliases.length ? { serviceAliases } : {}),
    },
    fieldMeta: Object.fromEntries(Object.entries(fieldMeta).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))),
    unmapped: unmapped.sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    ...(grouped.outOfBoundary.length + bounded.outOfBoundary.length
      ? { outOfBoundary: [...grouped.outOfBoundary, ...bounded.outOfBoundary].sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0)) } : {}),
    ...(Object.keys(bounded.pool).length ? { boundaryPool: Object.fromEntries(Object.entries(bounded.pool).sort((a, b) => (a[0] < b[0] ? -1 : 1))) } : {}),
    ids,
    environment: environment.sort(),
    ...(Object.keys(securityFacts).length ? { securityFacts } : {}),
  };
  return { result };
}
