import type { AppSpec, Provider } from "@svc/contracts";
import * as aws from "../aws/index.js";
import * as gcp from "../gcp/index.js";
import * as onprem from "../onprem/index.js";
import * as azure from "../azure-mock/index.js";

// Z86: 클라우드 서비스 대응표 = "출발에서 X 를 쓰던 것이 도착에서는 Y 가 된다" (예: AWS RDS → GCP Cloud SQL).
// 근거는 어댑터 번역 규칙 한 곳: 도착 Terraform 자원 종류는 각 어댑터 resourceTypes(spec), Helm 값(ingressClass·secretStore)은 toHelmValues,
// 이미지 주소는 imageRef(ECR / Artifact Registry / 온프레 레지스트리 / ACR). 이름표만 여기 모았다 (화면·API 가 같은 글자를 쓰게)
// 이전 방식은 아키텍처 결정 그대로: 앱 = 이미지 digest 그대로 재배포(Helm→Argo CD), DB = 논리 복제(CDC) 뒤 컷오버, 진입 = Cloudflare LB 가중치 전환

export type ServiceCategory = "cluster" | "workload" | "database" | "ingress" | "registry" | "secret" | "identity" | "network" | "storage";
export type MoveMethod = "redeploy" | "logical_replication" | "traffic_shift" | "create_new" | "image_copy" | "reuse_existing" | "out_of_scope";
export type PlanStepId = "provision" | "deploy" | "sync" | "shift" | "cutover" | "cleanup";

export const SERVICE_NAME: Record<Provider, Record<ServiceCategory, string>> = {
  aws: {
    cluster: "Amazon EKS", workload: "EKS Deployment (Helm)", database: "Amazon RDS for PostgreSQL", ingress: "Application Load Balancer",
    registry: "Amazon ECR", secret: "AWS Secrets Manager", identity: "IAM 역할 + EKS Pod Identity", network: "Amazon VPC", storage: "Amazon S3",
  },
  gcp: {
    cluster: "Google Kubernetes Engine", workload: "GKE Deployment (Helm)", database: "Cloud SQL for PostgreSQL", ingress: "Cloud Load Balancing",
    registry: "Artifact Registry", secret: "Secret Manager", identity: "서비스 계정 + Workload Identity", network: "VPC 네트워크", storage: "Cloud Storage",
  },
  onprem: {
    cluster: "k3s (온프레)", workload: "k3s Deployment (Helm)", database: "CloudNativePG (CNPG)", ingress: "k8s Service + cloudflared",
    registry: "온프레 레지스트리", secret: "Vault + External Secrets", identity: "k8s 서비스 계정", network: "온프레 노드 네트워크", storage: "MinIO",
  },
  azure_mock: {
    cluster: "AKS (Mock)", workload: "AKS Deployment (Mock)", database: "Azure Database for PostgreSQL Flexible (Mock)", ingress: "Application Gateway (Mock)",
    registry: "Azure Container Registry (Mock)", secret: "Key Vault (Mock)", identity: "관리 ID + 페더레이션 (Mock)", network: "가상 네트워크 (Mock)", storage: "Blob Storage (Mock)",
  },
};

// 출발 쪽에서 "지금 앱이 돌던 곳" 이름표. 가져오기 원본 종류(adapters common/fixtures.ts) 기준: AWS 출발은 ECS 서비스로 돈다
export const SOURCE_WORKLOAD: Record<Provider, string> = {
  aws: "Amazon ECS 서비스", gcp: "GKE Deployment", onprem: "k3s Deployment", azure_mock: "Container Apps (Mock)",
};

const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  cluster: "컨테이너 클러스터", workload: "앱(컨테이너)", database: "DB", ingress: "진입(로드 밸런서)", registry: "이미지 저장소",
  secret: "비밀 저장소", identity: "앱 권한(ID)", network: "네트워크", storage: "객체 저장소",
};

export const METHOD_LABEL: Record<MoveMethod, string> = {
  redeploy: "앱 재배포 (같은 이미지 digest, Helm → Argo CD)",
  logical_replication: "논리 복제(CDC)로 따라잡은 뒤 컷오버, 역방향 복제로 되돌림 대비",
  traffic_shift: "Cloudflare LB 가중치를 단계별로 옮김 (출발 100 → 도착 100)",
  create_new: "도착에 새로 만듦 (Terraform)",
  image_copy: "이미지를 도착 저장소로 복사 (digest 그대로)",
  reuse_existing: "환경 연결 때 받은 기존 것을 씀 (새로 안 만듦)",
  out_of_scope: "명세에 없음 → 이번 이전 대상 아님",
};

// 각 줄이 계획서 어느 단계에서 일어나나 (contracts PlanStep id)
const STEP: Record<ServiceCategory, PlanStepId | null> = {
  cluster: null, network: null, registry: "deploy", identity: "provision", secret: "provision",
  database: "sync", workload: "deploy", ingress: "shift", storage: null,
};

// 출발 쪽이 이전 뒤 어떻게 되나 (워커 cleanup.ts: 복제 객체 걷기 + 출발 앱 0 으로. 출발 DB 는 쓰기 회수 상태로 남김 — 지울지는 TODO(human))
const AFTER_SOURCE: Partial<Record<ServiceCategory, string>> = {
  workload: "정리 단계에서 0 개로 줄임 (지우지 않음)",
  database: "컷오버 때 쓰기를 막고 남김. 롤백 창 동안 역방향 복제로 받음",
  ingress: "가중치 0 으로 (Cloudflare LB 풀에서 빠짐)",
  secret: "그대로 둠 (출발 것을 지우지 않음)",
  identity: "그대로 둠",
};

const TYPES: Record<Provider, (s: AppSpec) => string[]> = {
  aws: aws.resourceTypes, gcp: gcp.resourceTypes, onprem: onprem.resourceTypes, azure_mock: azure.resourceTypes,
};

// Terraform/k8s 자원 종류 → 대응표 분류 (도착 자원을 줄에 붙이는 데 씀)
export function categoryOfType(type: string): ServiceCategory | null {
  if (type.startsWith("data.")) return null;
  if (/db_instance|db_parameter_group|sql_database|sql_user|postgresql|cnpg/.test(type)) return "database";
  if (/subnet_group|security_group|networkpolicies/.test(type)) return "network";
  if (/secret|random_password|key_vault|externalsecrets/.test(type)) return "secret";
  if (/iam|service_account|identity|serviceaccounts/.test(type)) return "identity";
  if (/namespace|deployments|resourcequotas/.test(type)) return "workload";
  if (/core\/services/.test(type)) return "ingress";
  return null;
}

export interface ServiceMapRow {
  category: ServiceCategory;
  label: string;
  source: { service: string; detail: string | null } | null;
  target: { service: string; detail: string | null; tfTypes: string[] } | null;
  method: MoveMethod;
  methodLabel: string;
  step: PlanStepId | null;
  afterSource: string | null;
}

const dbDetail = (s: AppSpec) => (s.database ? `PostgreSQL ${s.database.majorVersion} · ${s.database.storageGb}GB` : null);
// 도착 DB 크기 = 어댑터 toTerraform 기본값 (데모 최소 크기, DRAFT(ai))
const TARGET_DB_SIZE: Record<Provider, (s: AppSpec) => string> = {
  aws: (s) => `db.t4g.micro · ${Math.max(20, s.database?.storageGb ?? 20)}GB`,
  gcp: (s) => `db-f1-micro · ${Math.max(10, s.database?.storageGb ?? 10)}GB`,
  onprem: (s) => `CNPG 클러스터 · ${s.database?.storageGb ?? 0}Gi`,
  azure_mock: (s) => `Flexible Server · ${Math.max(32, s.database?.storageGb ?? 32)}GB`,
};

/** 출발·도착 종류와 명세로 대응표를 만든다. 순수 함수 (클라우드 호출 없음) */
export function serviceMap(from: Provider, to: Provider, spec: AppSpec | null): ServiceMapRow[] {
  const tf = spec ? TYPES[to](spec) : [];
  const typesOf = (c: ServiceCategory) => tf.filter((t) => categoryOfType(t) === c);
  const row = (category: ServiceCategory, method: MoveMethod, o: { src?: string | null; dst?: string | null; srcName?: string; dstOff?: boolean; srcOff?: boolean } = {}): ServiceMapRow => ({
    category, label: CATEGORY_LABEL[category],
    source: o.srcOff ? null : { service: o.srcName ?? SERVICE_NAME[from][category], detail: o.src ?? null },
    target: o.dstOff ? null : { service: SERVICE_NAME[to][category], detail: o.dst ?? null, tfTypes: typesOf(category) },
    method, methodLabel: METHOD_LABEL[method], step: method === "out_of_scope" || method === "reuse_existing" ? null : STEP[category],
    afterSource: AFTER_SOURCE[category] ?? null,
  });
  const rows: ServiceMapRow[] = [
    row("cluster", "reuse_existing", { src: null, dst: "앱 네임스페이스만 새로 만듦" }),
    row("workload", "redeploy", { srcName: SOURCE_WORKLOAD[from],
      src: spec ? `컨테이너 ${spec.service.replicas}개 · ${spec.service.cpu} CPU · ${spec.service.memory}` : null,
      dst: spec ? `컨테이너 ${spec.service.replicas}개 · 같은 이미지` : null }),
    spec?.database
      ? row("database", "logical_replication", { src: dbDetail(spec), dst: TARGET_DB_SIZE[to](spec) })
      : row("database", "out_of_scope", { src: null, dstOff: true }),
    row("ingress", "traffic_shift", { src: spec?.ingress.hostname ?? null, dst: spec ? `${spec.ingress.hostname} · 앞단 Cloudflare LB 가중치 → cloudflared (주소 그대로)` : null }),
    row("registry", "image_copy", { src: spec ? spec.service.image.replace(/@sha256:([a-f0-9]{12}).*/, "@sha256:$1…") : null, dst: "digest 그대로" }),
    spec && spec.service.secretRefs.length
      ? row("secret", "create_new", { src: `비밀 ${spec.service.secretRefs.length}개`, dst: "이름만 만들고 값은 연결(ESO)" })
      : row("secret", spec?.database ? "create_new" : "out_of_scope", { src: null, dst: spec?.database ? "DB 비밀번호 보관" : null, ...(spec?.database ? {} : { dstOff: true }) }),
    row("identity", "create_new", { src: null, dst: "앱 전용 최소 권한" }),
    row("network", "reuse_existing", { src: null, dst: "기존 VPC/서브넷 사용" }),
    row("storage", "out_of_scope", { src: null, dstOff: true }),
  ];
  return rows;
}
