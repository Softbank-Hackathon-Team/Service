import type { Provider } from "@svc/contracts";

// Z86: 클라우드 서비스 대응표 = "출발에서 X 를 쓰던 것이 도착에서는 Y 가 된다" (예: AWS RDS → GCP Cloud SQL).
// 표 본체는 service-map-v2.ts (도착 Builder 규칙에서 줄을 만든다). 여기는 이름표만 모았다 (화면·API 가 같은 글자를 쓰게)
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

export const CATEGORY_LABEL: Record<ServiceCategory, string> = {
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
export const STEP: Record<ServiceCategory, PlanStepId | null> = {
  cluster: null, network: null, registry: "deploy", identity: "provision", secret: "provision",
  database: "sync", workload: "deploy", ingress: "shift", storage: null,
};

// 출발 쪽이 이전 뒤 어떻게 되나 (워커 cleanup.ts: 복제 객체 걷기 + 출발 앱 0 으로. 출발 DB 는 쓰기 회수 상태로 남김 — 지울지는 TODO(human))
export const AFTER_SOURCE: Partial<Record<ServiceCategory, string>> = {
  workload: "정리 단계에서 0 개로 줄임 (지우지 않음)",
  database: "컷오버 때 쓰기를 막고 남김. 롤백 창 동안 역방향 복제로 받음",
  ingress: "가중치 0 으로 (Cloudflare LB 풀에서 빠짐)",
  secret: "그대로 둠 (출발 것을 지우지 않음)",
  identity: "그대로 둠",
};

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
