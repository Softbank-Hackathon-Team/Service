import type { AppSpecV2, ApprovalRowV2, ComponentV2, Provider } from "@svc/contracts";

// DRAFT(ai): 클라우드 → 클라우드 대체 상품표 (AWS ↔ GCP). 출발 관리형 데이터 상품이 도착에서 다른 상품이 될 때 무엇이 안 따라가고 앱 코드를 고쳐야 하나.
//   DB 도 넣었다 (RDS ↔ Cloud SQL 도 상품이 바뀌므로 대응 카드에 나와야 함, 앱 코드는 그대로).
//   표에 없는 방향(같은 클라우드, 온프레·azure_mock 출발) = 0줄. 클러스터 안 데이터는 view(renderViewV2)가 먼저 뺀다.
//   계획 전에 막히는 것(캐시 클러스터 모드, 버킷 알림, 구독 여럿·push·filter·retainAcked, AWS 도착 캐시 AUTH)은 v2Blockers 몫이라 여기 없다
type Cloud = "aws" | "gcp";
type DataKind = Exclude<ComponentV2["kind"], "service" | "job">;
type Of<K extends DataKind> = Extract<ComponentV2, { kind: K }>;
type Direction = "aws>gcp" | "gcp>aws";

// when 이 없으면 늘 잃음. when 이 있으면 출발 명세가 그 설정을 쓸 때만 잃음
interface Loss<K extends DataKind> { what: string; when?: (c: Of<K>) => boolean }
// appChange = 앱 코드를 고쳐야 하는 까닭 (없으면 코드 그대로 붙음)
interface Move<K extends DataKind> { lost: Loss<K>[]; appChange?: string }

export const CLOUD_PRODUCT: { [C in Cloud]: { [K in DataKind]: (c: Of<K>) => string } } = {
  aws: {
    postgres: () => "RDS for PostgreSQL",
    cache: (c) => `ElastiCache (${c.props.engine})`,
    queue: (c) => `${c.props.model === "topic" ? "SNS" : "SQS"}${c.props.ordered ? " FIFO" : ""}`,
    objectStore: () => "S3",
  },
  gcp: {
    postgres: () => "Cloud SQL for PostgreSQL",
    cache: () => "Memorystore (redis)",   // valkey 도 Redis 로 만든다 (data-fit cacheVersionFor)
    queue: (c) => (c.props.model === "topic" ? "Pub/Sub topic" : "Pub/Sub topic + subscription"),
    objectStore: () => "Cloud Storage",
  },
};

const hasCold = (c: Of<"objectStore">) => (c.props.lifecycle ?? []).some((r) => r.toColdAfterDays !== undefined);

const MOVES: { [K in DataKind]: Record<Direction, Move<K>> } = {
  postgres: {
    "aws>gcp": { lost: [
      { what: "Port (Cloud SQL is fixed at 5432)", when: (c) => c.props.port !== undefined && c.props.port !== 5432 },
      { what: "Maintenance window minutes (Cloud SQL takes day and hour only)", when: (c) => !!c.props.maintenanceWindow && !/:00-/.test(c.props.maintenanceWindow) },
    ] },
    "gcp>aws": { lost: [] },
  },
  cache: {
    "aws>gcp": { lost: [
      { what: "Valkey engine (Memorystore is created as Redis)", when: (c) => c.props.engine === "valkey" },
      { what: "Port (Memorystore uses 6379, or 6378 with TLS)", when: (c) => c.props.port !== undefined && c.props.port !== 6379 },
      { what: "AUTH password (a new one is created in app-<app>-<id>-cache-auth but not passed to the app)", when: (c) => c.props.auth === true },
      // DRAFT(ai): Memorystore 서버 인증서는 공개 CA 가 서명하지 않아 인증서를 검증하는 앱은 CA 가 있어야 붙는다 (상품 문서 기억, 실계정 미확인)
      { what: "TLS server CA certificate (module output only, not passed to the app)", when: (c) => c.props.tls !== false },
      { what: "Cached data (starts empty)" },
    ] },
    "gcp>aws": { lost: [{ what: "Cached data (starts empty)" }] },
  },
  queue: {
    "aws>gcp": { appChange: "Pub/Sub SDK instead of SQS/SNS SDK (the queue env gets a Pub/Sub subscription/topic name instead of an SQS URL or SNS ARN)", lost: [
      // DRAFT(ai): Pub/Sub 순서 키는 순서만 지키고 SQS FIFO 의 중복 제거(중복 제거 ID·5분 창)는 없다 (상품 문서 기억)
      { what: "FIFO deduplication (Pub/Sub has ordering keys only)", when: (c) => c.props.ordered === true },
      { what: "Pending messages (not moved from the source queue)" },
    ] },
    "gcp>aws": { appChange: "SQS/SNS SDK instead of Pub/Sub SDK (the queue env gets an SQS URL or SNS ARN instead of a Pub/Sub name)", lost: [
      // DRAFT(ai): 내용 기반 중복 제거를 끈 SQS FIFO 는 보낼 때마다 중복 제거 ID 가 있어야 받는다 (상품 문서 기억)
      { what: "Sends that relied on ordering keys only (FIFO content-based dedup is off, so a dedup ID is required)", when: (c) => c.props.ordered === true },
      { what: "Auto-delete of idle subscriptions (SQS does not delete)", when: (c) => c.props.idleExpirySec !== undefined },
      { what: "Pending messages (not moved from the source subscription)" },
    ] },
  },
  objectStore: {
    "aws>gcp": { appChange: "Cloud Storage SDK instead of S3 SDK (or the S3-compatible XML API with HMAC keys)", lost: [
      { what: "Bucket policy body (only public/private is carried)" },
      { what: "Cold storage class (target uses COLDLINE)", when: hasCold },
      { what: "Objects (not copied, bucket starts empty)" },
    ] },
    "gcp>aws": { appChange: "S3 SDK instead of Cloud Storage SDK", lost: [
      { what: "Bucket IAM policy (only public/private is carried)" },
      { what: "Cold storage class (target uses GLACIER_IR)", when: hasCold },
      { what: "Objects (not copied, bucket starts empty)" },
    ] },
  },
};

function moveOf<K extends DataKind>(kind: K, c: Of<K>, source: Cloud, target: Cloud): Omit<ApprovalRowV2, "kind" | "subject"> {
  const move = MOVES[kind][`${source}>${target}` as Direction];
  return { from: CLOUD_PRODUCT[source][kind](c), to: CLOUD_PRODUCT[target][kind](c),
    lost: move.lost.filter((l) => !l.when || l.when(c)).map((l) => l.what),
    appChange: move.appChange !== undefined, ...(move.appChange ? { detail: move.appChange } : {}) };
}

/** 도착 target 의 substitutionsV2. 출발이 다른 클라우드일 때만, 데이터 자원마다 한 줄 (id 순) */
export function cloudSubstitutes(target: Cloud, spec: AppSpecV2, source: Provider): ApprovalRowV2[] {
  if ((source !== "aws" && source !== "gcp") || source === target) return [];
  return spec.components.flatMap((c): ApprovalRowV2[] => (c.kind === "service" || c.kind === "job" ? []
    : [{ kind: "substitute", subject: c.id, ...moveOf(c.kind, c, source, target) }]))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}
