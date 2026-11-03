import type { FieldMetaV2, ImportResultV2, RawInventory, SourceDbFacts, UnmappedV2 } from "@svc/contracts";
import { assignIds, slug } from "./ids.js";
import { inferLinks } from "./links.js";
import { maskPlainSecrets, rewriteEnv } from "./env-rewrite.js";
import { attachEndpoints, buildEntry, fillProjection, mergeRoutes } from "./entry.js";
import { buildPosture } from "./posture.js";
import { applyBoundary } from "./boundary.js";
import { selectAppGroup } from "./app-group.js";
import { sourceDbFactsOf } from "./security-facts.js";
import { K8S_RAW_KINDS, type RawK8sHpa, type RawK8sIngress, type RawK8sNetworkPolicy, type RawK8sService } from "./raw-k8s.js";
import { k8sDeploymentMapper } from "./mappers/k8s-deployment.js";
import { k8sCronJobMapper } from "./mappers/k8s-cronjob.js";
import { rdsMapper } from "./mappers/rds.js";
import { cloudSqlMapper } from "./mappers/cloudsql.js";
import { cnpgMapper } from "./mappers/cnpg.js";
import type { RawAwsIamPolicy } from "./mappers/iam-grants.js";
import { s3Mapper } from "./mappers/s3.js";
import { sqsMapper } from "./mappers/sqs.js";
import { elasticacheMapper } from "./mappers/elasticache.js";
import { gcsMapper } from "./mappers/gcs.js";
import { pubsubMapper } from "./mappers/pubsub.js";
import { memorystoreMapper } from "./mappers/memorystore.js";
import { ecsServiceMapper } from "./mappers/ecs-service.js";
import { vmInstanceMapper } from "./mappers/vm-instance.js";
import { cloudRunJobMapper, cloudRunServiceMapper } from "./mappers/cloudrun-service.js";
import type { KindMapper, MappedComponent, NormalizeV2Options, NormalizeV2Output, ProjectionEnv, RawItem } from "./types.js";

// DRAFT(ai): 원본(RawInventory) → 공통 명세 v2 (설계 20번 5.1~5.5장, 24번 I3a). 순수 함수, 네트워크·환경변수 안 읽음.
//   1) 종류 붙이기(매퍼)  2) id 정하기  3) Service·HPA 접기  4) 평문 비밀 가리기  5) 의존성 추론 + env 다시 쓰기
//   5b) 앱 경계(BOUNDARY: 서비스가 근거로 닿는 데이터 자원만)  6) 라우팅  7) 보안 기준선. 같은 원본이면 글자 하나까지 같은 결과(목록 정렬).
//   검증(checkV2)·저장은 부르는 쪽(import.ts, I3b) 몫.

// I9: ECS 서비스 매퍼 (관리형 컨테이너 출발 갈래)
export const KIND_MAPPERS: KindMapper[] = [k8sDeploymentMapper, k8sCronJobMapper, rdsMapper, cloudSqlMapper, cnpgMapper,
  s3Mapper, sqsMapper, elasticacheMapper, gcsMapper, pubsubMapper, memorystoreMapper,   // I6: 객체 저장소·큐·캐시
  ecsServiceMapper,
  vmInstanceMapper,   // VMIMPORT: VM 출발 갈래(EC2·GCE)
  cloudRunServiceMapper, cloudRunJobMapper];   // CRIMPORT: Cloud Run 서비스·잡 (관리형 컨테이너 출발 갈래, GCP)
const MAPPER_BY_TYPE = new Map(KIND_MAPPERS.flatMap((m) => m.nativeTypes.map((t) => [t, m] as const)));

// 앱 리소스는 아니지만 아는 것: 근거(다른 리소스에 접힘) / 환경(도착에서 env 층이 다시 만듦)
// R5: serviceAccount·configMapKeys 는 근거·환경 종류로 등록 (unmapped C 로 안 셈)
export const EVIDENCE_TYPES = new Set<string>([K8S_RAW_KINDS.service, K8S_RAW_KINDS.ingress, K8S_RAW_KINDS.hpa, K8S_RAW_KINDS.networkPolicy, K8S_RAW_KINDS.serviceAccount, K8S_RAW_KINDS.configMapKeys, "aws.iamPolicy"]);
export const ENVIRONMENT_TYPES = new Set<string>(["eks.cluster", "gke.cluster", "k8s.node", "aws.vpc", "gcp.network", "aws.ecr", "gcp.artifactRepo", "aws.alb", "gcp.forwardingRule", "aws.secret", "gcp.secret", "import.note", "ecs.cluster"]);

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
  const dbFacts = new Map<MappedComponent, SourceDbFacts>();   // 출발 DB 보안 사실 (id 가 붙기 전이라 구성요소로 잇는다)

  // 1) 종류 붙이기. 매퍼 하나가 터져도 그 자원만 unmapped
  for (const it of items) {
    const mapper = MAPPER_BY_TYPE.get(it.kind);
    if (mapper) {
      try {
        const c = mapper.map(it);
        if ("skip" in c) unmapped.push({ resource: resName(it), grade: c.grade ?? "C", reason: c.skip });
        else {
          mapped.push(c);
          const f = c.kind === "postgres" ? sourceDbFactsOf(it) : null;
          if (f) dbFacts.set(c, f);
        }
      } catch (err) {
        unmapped.push({ resource: resName(it), grade: "C", reason: `매퍼 오류: ${err instanceof Error ? err.message : String(err)}` });
      }
      continue;
    }
    if (EVIDENCE_TYPES.has(it.kind)) continue;
    if (ENVIRONMENT_TYPES.has(it.kind)) { environment.push(it.kind); continue; }
    unmapped.push({ resource: resName(it), grade: "C", reason: "카탈로그에 종류 없음 → 출발에 두고 연결 유지가 기본(6.10장)" });
  }
  const evidence = <T>(kind: string) => items.filter((i) => i.kind === kind) as unknown as T[];
  const svcObjs = evidence<RawK8sService>(K8S_RAW_KINDS.service).filter((s) => s.metadata && s.spec);
  const ingresses = evidence<RawK8sIngress>(K8S_RAW_KINDS.ingress).filter((s) => s.metadata && s.spec);
  const hpas = evidence<RawK8sHpa>(K8S_RAW_KINDS.hpa).filter((s) => s.metadata && s.spec?.scaleTargetRef);
  const policies = evidence<RawK8sNetworkPolicy>(K8S_RAW_KINDS.networkPolicy).filter((s) => s.metadata);

  // 2) id
  const ids = assignIds(mapped, opts.previousIds ?? {});
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
      if (target.props.model === "topic") {
        target.props.model = "queue";
        target.meta.model = [target.meta.model?.[0] ?? "dlq", 0.9, `${q.id} 의 DLQ 대상으로 쓰이는 토픽 → 꺼내 읽는 queue 로 둠. 사람 확인 필요`];
      }
    }
    else q.meta.deadLetter = [q.meta.deadLetter?.[0] ?? "dlq", 0.6, `DLQ ${q.deadLetterRef.name} 를 이 가져오기에서 못 찾음 (다른 계정·리전일 수 있음)`];
  }
  for (const c of components)
    for (const [k, [source, confidence, rationale]] of Object.entries(c.meta))
      fieldMeta[`components.${c.id}.${k}`] = { source, confidence, needs_review: confidence < 1, ...(rationale ? { rationale } : {}) };

  // 3) k8s Service 객체 → endpoints, HPA → replicas 범위 + scale (따로 종류를 두지 않는다)
  attachEndpoints(components, [...svcObjs].sort((a, b) => `${a.metadata.namespace ?? ""}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace ?? ""}/${b.metadata.name}`)), unmapped);
  for (const h of hpas) {
    const s = components.find((c) => c.kind === "service" && c.native.name === h.spec.scaleTargetRef.name && (!h.metadata.namespace || h.metadata.namespace === c.native.namespace));
    if (!s) { unmapped.push({ resource: `k8s.hpa:${h.metadata.name}`, grade: "C", reason: "대상 Deployment 를 못 찾음" }); continue; }
    const metrics = (h.spec.metrics ?? []) as Array<{ resource?: { name?: string; target?: { averageUtilization?: number } } }>;
    const cpu = metrics.find((x) => x.resource?.name === "cpu")?.resource?.target?.averageUtilization;
    s.props.replicas = { min: h.spec.minReplicas ?? 1, max: h.spec.maxReplicas };
    fieldMeta[`components.${s.id}.replicas`] = { source: `k8s:hpa/${h.metadata.name}.spec.min/maxReplicas`, confidence: 1, needs_review: false };
    if (typeof cpu === "number") {
      s.props.scale = { targetCpuPct: cpu };
      fieldMeta[`components.${s.id}.scale`] = { source: `k8s:hpa/${h.metadata.name}.metrics.cpu`, confidence: 1, needs_review: false };
    } else {
      fieldMeta[`components.${s.id}.scale`] = { source: `k8s:hpa/${h.metadata.name}`, confidence: 0.6, needs_review: true, rationale: "CPU 말고 다른 지표 → 카탈로그 HPA 모듈은 CPU 만" };
    }
  }

  // 3b) PARTOF: 앱 묶음 라벨(part-of 등)이 있으면 그 묶음 워크로드만. 데이터 자원 경계(5b)는 남은 워크로드 기준
  const grouped = selectAppGroup(components, fieldMeta, opts.partOf);
  components = grouped.components;

  // 4) 평문 비밀 → 명세에서 뺌 (의존성 추론 전에: 비밀 값이 근거가 되지 않게)
  const masked = maskPlainSecrets(components, fieldMeta, unmapped);

  // 5) 의존성 + env 다시 쓰기
  // I4: 앱 신원의 IAM 정책 (discover 가 IAM 읽기를 켰을 때만 원본에 있음. 없으면 지금 그대로)
  const iamPolicies = evidence<RawAwsIamPolicy>("aws.iamPolicy").filter((p) => typeof p.roleName === "string" && typeof p.serviceAccount === "string");
  const { links: allLinks, meta, envHits, permissions, unmapped: iamUnmapped } = inferLinks(components, masked, iamPolicies);
  unmapped.push(...iamUnmapped);
  Object.assign(fieldMeta, meta);
  // 5b) BOUNDARY: 계정 전체를 읽은 데이터 자원 중 이 앱이 근거로 닿는 것만. 나머지는 outOfBoundary (이름·종류만)
  const bounded = applyBoundary(components, allLinks, fieldMeta);
  components = bounded.components;
  const links = bounded.links;
  rewriteEnv(components, envHits, fieldMeta);

  // 6) 라우팅, 7) 보안 기준선
  // I9: ECS ALB 규칙은 k8s Ingress 뒤에 합친다 (k8s 만이면 그대로)
  const entry = mergeRoutes(buildEntry(components, svcObjs, ingresses, fieldMeta, unmapped), components, fieldMeta);
  const posture = buildPosture(components, policies);
  posture.permissions.push(...permissions);
  fillProjection(components, svcObjs, ingresses);

  // 경계 안 postgres 만. 경계 밖에서 끌어온 것(BOUNDPULL)은 사실 없음 = 판정에서 모름
  const securityFacts = Object.fromEntries(components.flatMap((c) => { const f = dbFacts.get(c); return f ? [[c.id!, f] as const] : []; }));
  const firstService = components.find((c) => c.kind === "service") ?? components[0];
  const result: ImportResultV2 = {
    spec: {
      schemaVersion: "2",
      app: { name: slug(opts.appName ?? firstService?.id ?? "app") },
      components: components.map(({ id, kind, props }) => ({ id: id!, kind, props }) as unknown as ImportResultV2["spec"]["components"][number]),
      links,
      ...(entry ? { entry } : {}),
      posture,
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
  const projectionEnv: ProjectionEnv = { workloads: {}, postgres: {} };
  for (const c of components) {
    if (c.projection) projectionEnv.workloads[c.id!] = c.projection;
    if (c.kind === "postgres") projectionEnv.postgres[c.id!] = { nativeType: c.native.type };
  }
  return { result, projectionEnv };
}
