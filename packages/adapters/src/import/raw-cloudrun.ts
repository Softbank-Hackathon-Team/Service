// CRIMPORT: GCP Cloud Run 원본 모양 (run services list + revisions describe digest + get-iam-policy 공개 여부 + domain-mappings, run jobs list + Cloud Scheduler 일정).
//   reader(readers/gcp-cloudrun.ts)가 이 모양으로 넣고, 매퍼(mappers/cloudrun-service.ts)가 읽는다. ECS(raw-ecs.ts)와 같은 틀.
//   규칙: 비밀 값은 안 읽는다(Secret Manager 는 이름·버전만) · 주석(annotation)·태그는 허용 목록 칸만.

export const CLOUDRUN_RAW_KINDS = { service: "cloudrun.service", job: "cloudrun.job" } as const;

export interface RawCloudRunProbe {
  httpGet?: { path?: string | null; port?: number | null } | null;
  tcpSocket?: { port?: number | null } | null;
  grpc?: { port?: number | null } | null;
  periodSeconds?: number;
  failureThreshold?: number;
  initialDelaySeconds?: number;
  timeoutSeconds?: number;
}

export interface RawCloudRunContainer {
  name?: string;
  image: string;
  command?: string[];
  args?: string[];
  ports?: Array<{ containerPort: number; name?: string }>;   // Cloud Run 은 하나 (name = http1 | h2c)
  env?: Array<{ name: string; value?: string; secret?: { name: string; version: string } }>;
  limits?: { cpu?: string; memory?: string };
  startupProbe?: RawCloudRunProbe | null;
  livenessProbe?: RawCloudRunProbe | null;
}

export interface RawCloudRunService {
  kind: typeof CLOUDRUN_RAW_KINDS.service;
  name: string;
  region: string;
  uid?: string | null;
  labels?: Record<string, string>;
  /** status.url 의 호스트 (…run.app). 다른 서비스가 env 에 적는 주소 → 연결 추론 */
  urlHost?: string | null;
  /** run.googleapis.com/ingress: all | internal | internal-and-cloud-load-balancing */
  ingress?: string | null;
  /** roles/run.invoker 에 allUsers 가 있나 (못 읽으면 null) */
  invokerAllUsers?: boolean | null;
  minScale?: number | null;
  maxScale?: number | null;
  serviceAccount?: string | null;
  imageDigest?: string | null;   // CR-1: 옮길 판(트래픽 가장 큰 판, 없으면 최신 준비 판)의 status.imageDigest (주 컨테이너)
  /** CR-1: 옮길 판 이름. containers·imageDigest 는 이 판에서 같이 읽음 */
  revision?: string | null;
  /** CR-1: 트래픽이 여러 판에 나뉨 (큰 순). 한 판 100% 면 칸 없음 */
  trafficSplit?: Array<{ revision: string; percent: number }>;
  containers: RawCloudRunContainer[];
  /** 이 서비스로 가는 사용자 도메인 (domain-mappings) */
  domains?: string[];
}

export interface RawCloudRunJob {
  kind: typeof CLOUDRUN_RAW_KINDS.job;
  name: string;
  region: string;
  uid?: string | null;
  labels?: Record<string, string>;
  serviceAccount?: string | null;
  imageDigest?: string | null;   // 이미지 참조에 @sha256 이 있을 때만 (실행 기록은 안 읽음)
  containers: RawCloudRunContainer[];
  taskCount?: number | null;
  parallelism?: number | null;
  maxRetries?: number | null;
  timeoutSec?: number | null;
  /** 이 잡을 부르는 Cloud Scheduler 일정 (없으면 수동 실행 잡) */
  schedule?: { cron: string; timeZone?: string | null; paused: boolean } | null;
}
