import type { AppSpecV2, Provider } from "@svc/contracts";
import { resourceTypesV2For } from "../target/index.js";
import { postgresOf, secretNamesOf, workloadsOf } from "../target/shared.js";
import { cachesOf, objectStoresOf, queuesOf } from "../target/data.js";
import { METHOD_LABEL, SERVICE_NAME, STEP, AFTER_SOURCE, CATEGORY_LABEL, type MoveMethod, type PlanStepId, type ServiceCategory } from "./service-map.js";

// MAPV2 DRAFT(ai): 계획/자원 대응표 v2 — v2 명세(실행 방식 runtime·원래 모양 origin)로 만든다. 순수 함수 (클라우드 호출 없음).
//   도착 자원 종류(tfTypes)는 따로 표를 두지 않고 resourceTypesV2For(= v2 Builder 가 실제로 만들 종류)를 분류만 한다.
//   v1 대응표(service-map.ts)는 그대로 둔다. v1 판(spec_v2 없음)은 API 가 v1 로 보낸다.

export type ServiceCategoryV2 = ServiceCategory | "cache" | "queue" | "boundary";
type Runtime = "k8s" | "managedContainer" | "vm";
export interface ServiceMapRowV2 {
  category: ServiceCategoryV2;
  label: string;
  source: { service: string; detail: string | null } | null;
  target: { service: string; detail: string | null; tfTypes: string[] } | null;
  method: MoveMethod;
  methodLabel: string;
  step: PlanStepId | null;
  afterSource: string | null;
  /** 사람이 도착 실행 방식을 출발과 다르게 바꿨을 때만 (예: ECS → k8s). 화면에 "실행 방식 바뀜" 표시 */
  runtimeChange: { from: string; to: Runtime } | null;
}

const LABEL_V2: Record<"cache" | "queue" | "boundary", string> = { cache: "캐시", queue: "큐·토픽", boundary: "경계 밖 자원" };
const TARGET_RUNTIME_NAME: Record<Provider, Record<Runtime, string>> = {
  aws: { k8s: "EKS Deployment (Helm)", managedContainer: "Amazon ECS 서비스 (Fargate)", vm: "Amazon EC2 인스턴스" },
  gcp: { k8s: "GKE Deployment (Helm)", managedContainer: "Cloud Run 서비스", vm: "Compute Engine VM" },
  onprem: { k8s: "k3s Deployment (Helm)", managedContainer: "지원 안 함 (온프레는 k8s 만)", vm: "지원 안 함 (온프레는 k8s 만)" },
  azure_mock: { k8s: "AKS Deployment (Mock)", managedContainer: "Container Apps (Mock)", vm: "가상 머신 (Mock)" },
};
const TARGET_JOB_NAME: Record<Provider, Record<Runtime, string>> = {
  aws: { k8s: "EKS CronJob (Helm)", managedContainer: "ECS 예약 작업 (EventBridge Scheduler)", vm: "지원 안 함" },
  gcp: { k8s: "GKE CronJob (Helm)", managedContainer: "Cloud Run 잡 (Cloud Scheduler)", vm: "지원 안 함" },
  onprem: { k8s: "k3s CronJob (Helm)", managedContainer: "지원 안 함", vm: "지원 안 함" },
  azure_mock: { k8s: "AKS CronJob (Mock)", managedContainer: "지원 안 함", vm: "지원 안 함" },
};
// 출발 이름: origin.product 가 정한다. k8s 는 출발 프로바이더가 EKS·GKE·k3s 중 무엇인지 정한다
const SOURCE_BY_PRODUCT: Record<string, string> = { ecs: "Amazon ECS 서비스", cloudRun: "Cloud Run 서비스", ec2: "Amazon EC2 인스턴스", gce: "Compute Engine VM" };
const SOURCE_K8S: Record<Provider, [string, string]> = {
  aws: ["EKS Deployment", "EKS CronJob"], gcp: ["GKE Deployment", "GKE CronJob"], onprem: ["k3s Deployment", "k3s CronJob"], azure_mock: ["AKS Deployment (Mock)", "AKS CronJob (Mock)"],
};
const CLUSTER_SOURCE: Record<string, string> = { ecs: "Amazon ECS 클러스터", cloudRun: "Cloud Run (클러스터 없음)", ec2: "VPC 안 인스턴스 (클러스터 없음)", gce: "VPC 안 VM (클러스터 없음)" };
const CLUSTER_TARGET: Record<Provider, Record<Runtime, { service: string; detail: string | null; method: MoveMethod } | null>> = {
  aws: { k8s: { service: SERVICE_NAME.aws.cluster, detail: "앱 네임스페이스만 새로 만듦", method: "reuse_existing" },
    managedContainer: { service: "Amazon ECS 클러스터", detail: "클러스터·서비스 디스커버리 새로 만듦", method: "create_new" }, vm: null },
  gcp: { k8s: { service: SERVICE_NAME.gcp.cluster, detail: "앱 네임스페이스만 새로 만듦", method: "reuse_existing" }, managedContainer: null, vm: null },
  onprem: { k8s: { service: SERVICE_NAME.onprem.cluster, detail: "앱 네임스페이스만 새로 만듦", method: "reuse_existing" }, managedContainer: null, vm: null },
  azure_mock: { k8s: { service: SERVICE_NAME.azure_mock.cluster, detail: "앱 네임스페이스만 새로 만듦", method: "reuse_existing" }, managedContainer: null, vm: null },
};
const IDENTITY_SOURCE: Record<string, string> = { ecs: "IAM 태스크 역할 (ECS)", cloudRun: "서비스 계정 (Cloud Run)", ec2: "IAM 역할 + 인스턴스 프로파일", gce: "서비스 계정 (VM)" };
const IDENTITY_TARGET: Partial<Record<Provider, Partial<Record<Runtime, string>>>> = {
  aws: { managedContainer: "IAM 역할 (ECS 태스크 실행·앱)", vm: "IAM 역할 + 인스턴스 프로파일" },
  gcp: { managedContainer: "서비스 계정 (Cloud Run)", vm: "서비스 계정 (VM)" },
};
const DATA_NAME = {
  cache: { aws: "Amazon ElastiCache", gcp: "Memorystore for Redis", onprem: "Valkey", azure_mock: "Cache for Redis (Mock)" },
  queue: { aws: "Amazon SQS / SNS", gcp: "Cloud Pub/Sub", onprem: "클러스터 안 큐 (미정)", azure_mock: "Service Bus (Mock)" },
} as const;

// 진입: 아키텍처 v0.4 = Cloudflare LB(풀 2개: 출발·도착, 가중치 10→50→100). ALB·Cloud Load Balancing 은 안 씀.
//   도착 원점: k8s = cloudflared 터널(클러스터 안), Cloud Run = run.app 주소. ECS·VM 원점 연결은 아직 없음(managed.ts·vm.ts warnings: TODO(human))
const INGRESS_SOURCE = "Cloudflare LB 출발 풀";
const INGRESS_TARGET = "Cloudflare LB 도착 풀 (풀 2개, 가중치 10→50→100)";
function originOf(to: Provider, rt: Runtime): string {
  if (rt === "k8s") return "원점: cloudflared 터널 (클러스터 안)";
  if (rt === "managedContainer" && to === "gcp") return "원점: Cloud Run 주소 (run.app)";
  return "원점 연결은 아직 없음 (TODO(human): 사람이 정한 뒤 전환)";
}
const TF_RULES: Array<[ServiceCategoryV2, RegExp]> = [
  ["cache", /elasticache|redis_instance/], ["queue", /sqs|sns_|pubsub/], ["storage", /s3_bucket|storage_bucket/],
  ["database", /db_instance|db_parameter_group|sql_database|sql_user|postgresql|cnpg/], ["network", /subnet_group|security_group|networkpolicies/],
  ["secret", /secret|random_password|key_vault|externalsecrets/], ["identity", /iam|service_account|identity|serviceaccounts/],
  ["cluster", /ecs_cluster|service_discovery|namespace|resourcequotas/],
  ["workload", /deployments|cronjobs|ecs_task_definition|ecs_service|appautoscaling|cloud_run_v2|compute_instance|aws_instance|scheduler/],
];
export const categoryOfTypeV2 = (type: string): ServiceCategoryV2 | null => type.startsWith("data.") ? null : (TF_RULES.find(([, re]) => re.test(type))?.[0] ?? null);

export function serviceMapV2(from: Provider, to: Provider, spec: AppSpecV2, opts: { outOfBoundary?: number } = {}): ServiceMapRowV2[] {
  const tf = resourceTypesV2For(to, spec);
  const ws = workloadsOf(spec);
  // k8s 워크로드가 없으면 Builder 목록에 늘 끼는 k8s 네임스페이스는 이 앱 줄에서 뺀다 (ECS·Cloud Run·VM 줄에 k8s 이름이 보이지 않게)
  const hasK8s = ws.some((w) => (w.kind === "service" ? w.props.runtime : ws.some((x) => x.kind === "service" && x.props.runtime === "managedContainer") ? "managedContainer" : "k8s") === "k8s");
  const typesOf = (c: ServiceCategoryV2) => tf.filter((t) => categoryOfTypeV2(t) === c && (hasK8s || !/^(kubernetes_namespace_v1|core\/namespaces)$/.test(t)));
  const services = ws.filter((w) => w.kind === "service");
  const hasManaged = services.some((s) => s.props.runtime === "managedContainer");
  const effRuntime = (w: (typeof ws)[number]): Runtime => (w.kind === "service" ? w.props.runtime : hasManaged ? "managedContainer" : "k8s");
  const originOf0 = (w: (typeof ws)[number]) => (w.kind === "service" ? w.props.origin : (services[0]?.props.origin ?? { runtime: "k8s" as const, product: "k8s" }));
  const nameCat = (c: ServiceCategory) => SERVICE_NAME[to][c];
  const mk = (category: ServiceCategoryV2, method: MoveMethod, o: { src?: string | null; srcName?: string | null; dst?: string | null; dstName?: string | null; label?: string;
    methodLabel?: string; runtimeChange?: ServiceMapRowV2["runtimeChange"]; step?: PlanStepId | null; after?: string | null } = {}): ServiceMapRowV2 => ({
    category, label: o.label ?? (category in LABEL_V2 ? LABEL_V2[category as keyof typeof LABEL_V2] : CATEGORY_LABEL[category as ServiceCategory]),
    source: o.srcName === null ? null : { service: o.srcName ?? SERVICE_NAME[from][category as ServiceCategory], detail: o.src ?? null },
    target: o.dstName === null ? null : { service: o.dstName ?? nameCat(category as ServiceCategory), detail: o.dst ?? null, tfTypes: typesOf(category) },
    method, methodLabel: o.methodLabel ?? METHOD_LABEL[method],
    step: o.step !== undefined ? o.step : method === "out_of_scope" || method === "reuse_existing" ? null : STEP[category as ServiceCategory] ?? null,
    afterSource: o.after !== undefined ? o.after : AFTER_SOURCE[category as ServiceCategory] ?? null,
    runtimeChange: o.runtimeChange ?? null,
  });
  const rows: ServiceMapRowV2[] = [];

  // 클러스터: 도착 실행 방식 종류별 (보통 하나)
  const rts = [...new Set(ws.map(effRuntime))].sort();
  const srcProducts = [...new Set(ws.map((w) => originOf0(w).product))].sort();
  const ct = rts.map((r) => CLUSTER_TARGET[to][r]).filter((x): x is NonNullable<typeof x> => !!x);
  rows.push(mk("cluster", ct.every((x) => x.method === "reuse_existing") ? "reuse_existing" : "create_new", {
    srcName: srcProducts.map((p) => CLUSTER_SOURCE[p] ?? SERVICE_NAME[from].cluster).join(" + ") || SERVICE_NAME[from].cluster,
    ...(ct.length ? { dstName: ct.map((x) => x.service).join(" + "), dst: ct.map((x) => x.detail).filter(Boolean).join(" · ") || null } : { dstName: null }),
  }));

  // 앱: 서비스·잡 하나에 한 줄 (이름 순)
  for (const w of [...ws].sort((a, b) => a.id.localeCompare(b.id))) {
    const rt = effRuntime(w), org = originOf0(w);
    const isJob = w.kind === "job";
    const srcName = org.runtime === "k8s" || org.product === "k8s" ? SOURCE_K8S[from][isJob ? 1 : 0] : (SOURCE_BY_PRODUCT[org.product] ?? org.product) + (isJob ? " (예약 작업)" : "");
    const changed = !isJob && org.runtime !== rt;
    const res = w.props.resources;
    const reqs = res?.request ? `${res.request.cpuMilli ?? "?"}m · ${res.request.memMiB ?? "?"}MiB` : "요청 값 없음";
    rows.push(mk("workload", "redeploy", {
      label: `앱(${isJob ? "예약 잡" : "컨테이너"}) · ${w.id}`,
      srcName, src: w.kind === "service" ? `컨테이너 ${w.props.replicas.min}~${w.props.replicas.max}개 · ${reqs}` : reqs,
      dstName: (isJob ? TARGET_JOB_NAME : TARGET_RUNTIME_NAME)[to][rt],
      dst: changed ? `실행 방식 바뀜 (${org.runtime} → ${rt}) · 같은 이미지` : "같은 종류로 · 같은 이미지",
      methodLabel: rt === "k8s" ? METHOD_LABEL.redeploy : `앱 재배포 (같은 이미지 digest, Terraform → ${rt === "vm" ? "VM" : "관리형 컨테이너"})`,
      runtimeChange: changed ? { from: org.runtime, to: rt } : null,
    }));
  }
  if (!ws.length) rows.push(mk("workload", "out_of_scope", { srcName: null, dstName: null }));

  // DB (postgres 마다)
  const dbs = postgresOf(spec);
  if (!dbs.length) rows.push(mk("database", "out_of_scope", { srcName: null, dstName: null }));
  for (const d of dbs) rows.push(mk("database", "logical_replication", {
    label: dbs.length > 1 ? `DB · ${d.id}` : undefined,
    src: `PostgreSQL ${d.props.majorVersion ?? "?"} · ${d.props.storageGb ?? "?"}GB`, dst: `PostgreSQL ${d.props.majorVersion ?? "?"} (도착 크기는 Builder 가 정함)`,
  }));
  // 데이터 자원 (캐시·버킷·큐): 도착에 새로 만든다
  for (const c of cachesOf(spec)) rows.push(mk("cache", "create_new", { label: `캐시 · ${c.id}`, srcName: DATA_NAME.cache[from], dstName: DATA_NAME.cache[to], step: "provision", after: "그대로 둠 (출발 것을 지우지 않음)" }));
  for (const c of objectStoresOf(spec)) rows.push(mk("storage", "create_new", { label: `객체 저장소 · ${c.id}`, step: "provision", after: "그대로 둠 (출발 것을 지우지 않음)" }));
  for (const c of queuesOf(spec)) rows.push(mk("queue", "create_new", { label: `큐·토픽 · ${c.id}`, srcName: DATA_NAME.queue[from], dstName: DATA_NAME.queue[to], step: "provision", after: "그대로 둠 (출발 것을 지우지 않음)" }));
  if (!objectStoresOf(spec).length) rows.push(mk("storage", "out_of_scope", { srcName: null, dstName: null }));

  // 진입: Cloudflare LB 풀 2개
  const host = spec.entry?.hosts[0]?.hostnames[0] ?? null;
  const origins = [...new Set(rts.map((r) => originOf(to, r)))].join(" / ") || originOf(to, "k8s");
  rows.push(mk("ingress", "traffic_shift", { label: "진입(Cloudflare LB)", srcName: INGRESS_SOURCE, src: host, dstName: INGRESS_TARGET,
    dst: `${host ? `${host} · ` : ""}${origins}. 이 앱은 ALB·Cloud Load Balancing 을 안 씀`,
    methodLabel: "Cloudflare LB 가중치를 단계별로 옮김 (출발 풀 → 도착 풀: 10 → 50 → 100)", after: "가중치 0 으로 (Cloudflare LB 풀에서 빠짐)" }));

  const img = services[0]?.props.image;
  rows.push(mk("registry", "image_copy", { src: img ? `${img.repository}${img.digest ? `@${img.digest.slice(0, 19)}…` : ""}` : null, dst: "digest 그대로" }));
  const secrets = [...new Set(ws.flatMap(secretNamesOf))].sort();
  rows.push(secrets.length || dbs.length
    ? mk("secret", "create_new", { src: secrets.length ? `비밀 ${secrets.length}개` : null, dst: secrets.length ? "이름만 만들고 값은 연결" : "DB 비밀번호 보관" })
    : mk("secret", "out_of_scope", { srcName: null, dstName: null }));
  rows.push(mk("identity", "create_new", { srcName: srcProducts.map((p) => IDENTITY_SOURCE[p] ?? SERVICE_NAME[from].identity).filter((x, i, a) => a.indexOf(x) === i).join(" + "), dstName: rts.map((r) => IDENTITY_TARGET[to]?.[r] ?? nameCat("identity")).filter((x, i, a) => a.indexOf(x) === i).join(" + "), dst: "앱 전용 최소 권한" }));
  rows.push(mk("network", "reuse_existing", { dst: "기존 VPC/서브넷 사용" }));

  // 경계 밖 자원 개수 (BOUNDARY: 이 앱의 서비스·잡이 근거로 닿지 않는 데이터 자원. 이전 대상 아님, 출발에 그대로)
  if (opts.outOfBoundary) rows.push(mk("boundary", "out_of_scope", { label: `경계 밖 자원 ${opts.outOfBoundary}개`, srcName: `출발 계정의 다른 자원 ${opts.outOfBoundary}개`, src: "이 앱의 서비스·잡이 닿지 않음", dstName: null, step: null, after: "출발에 그대로 (건드리지 않음)" }));
  return rows;
}
