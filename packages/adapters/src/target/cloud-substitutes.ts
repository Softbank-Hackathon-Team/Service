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

const PRODUCT: { [C in Cloud]: { [K in DataKind]: (c: Of<K>) => string } } = {
  aws: {
    postgres: () => "RDS for PostgreSQL",
    cache: (c) => `ElastiCache (${c.props.engine})`,
    queue: (c) => `${c.props.model === "topic" ? "SNS" : "SQS"}${c.props.ordered ? " FIFO" : ""}`,
    objectStore: () => "S3",
  },
  gcp: {
    postgres: () => "Cloud SQL for PostgreSQL",
    cache: () => "Memorystore (redis)",   // valkey 도 Redis 로 만든다 (data-fit cacheVersionFor)
    queue: (c) => (c.props.model === "topic" ? "Pub/Sub 토픽" : "Pub/Sub 토픽 + 구독"),
    objectStore: () => "Cloud Storage",
  },
};

const hasCold = (c: Of<"objectStore">) => (c.props.lifecycle ?? []).some((r) => r.toColdAfterDays !== undefined);

const MOVES: { [K in DataKind]: Record<Direction, Move<K>> } = {
  postgres: {
    "aws>gcp": { lost: [
      { what: "포트 (Cloud SQL 은 5432 고정)", when: (c) => c.props.port !== undefined && c.props.port !== 5432 },
      { what: "유지보수 창의 분 (Cloud SQL 은 요일·시만 받음)", when: (c) => !!c.props.maintenanceWindow && !/:00-/.test(c.props.maintenanceWindow) },
    ] },
    "gcp>aws": { lost: [] },
  },
  cache: {
    "aws>gcp": { lost: [
      { what: "Valkey 엔진 (Memorystore 는 Redis 로 만듦)", when: (c) => c.props.engine === "valkey" },
      { what: "포트 (Memorystore 가 6379, TLS 면 6378 로 정함)", when: (c) => c.props.port !== undefined && c.props.port !== 6379 },
      { what: "AUTH 비밀번호 (도착이 새 비밀 app-<앱>-<id>-cache-auth 에 만들지만 앱에 넘기지 않음)", when: (c) => c.props.auth === true },
      // DRAFT(ai): Memorystore 서버 인증서는 공개 CA 가 서명하지 않아 인증서를 검증하는 앱은 CA 가 있어야 붙는다 (상품 문서 기억, 실계정 미확인)
      { what: "TLS 서버 CA 인증서 (모듈 출력에만 있고 앱에 넘기지 않음)", when: (c) => c.props.tls !== false },
      { what: "캐시 데이터 (빈 캐시로 시작)" },
    ] },
    "gcp>aws": { lost: [{ what: "캐시 데이터 (빈 캐시로 시작)" }] },
  },
  queue: {
    "aws>gcp": { appChange: "SQS·SNS SDK 대신 Pub/Sub SDK (큐 주소 env 가 SQS URL·SNS ARN 대신 Pub/Sub 구독·토픽 이름을 받음)", lost: [
      // DRAFT(ai): Pub/Sub 순서 키는 순서만 지키고 SQS FIFO 의 중복 제거(중복 제거 ID·5분 창)는 없다 (상품 문서 기억)
      { what: "FIFO 중복 제거 (Pub/Sub 은 순서 키만)", when: (c) => c.props.ordered === true },
      { what: "남은 메시지 (출발 큐에서 옮기지 않음)" },
    ] },
    "gcp>aws": { appChange: "Pub/Sub SDK 대신 SQS·SNS SDK (큐 주소 env 가 Pub/Sub 이름 대신 SQS URL·SNS ARN 을 받음)", lost: [
      // DRAFT(ai): 내용 기반 중복 제거를 끈 SQS FIFO 는 보낼 때마다 중복 제거 ID 가 있어야 받는다 (상품 문서 기억)
      { what: "순서 키만 쓰던 보내기 (FIFO 내용 기반 중복 제거가 꺼져 보낼 때 중복 제거 ID 필요)", when: (c) => c.props.ordered === true },
      { what: "안 쓰는 구독 자동 삭제 (SQS 는 안 지움)", when: (c) => c.props.idleExpirySec !== undefined },
      { what: "남은 메시지 (출발 구독에서 옮기지 않음)" },
    ] },
  },
  objectStore: {
    "aws>gcp": { appChange: "S3 SDK 대신 Cloud Storage SDK (또는 S3 호환 XML API 와 HMAC 키)", lost: [
      { what: "버킷 정책 본문 (공개 여부만 옮김)" },
      { what: "차가운 저장 등급 (도착은 COLDLINE)", when: hasCold },
      { what: "객체 (복사하지 않음, 빈 버킷)" },
    ] },
    "gcp>aws": { appChange: "Cloud Storage SDK 대신 S3 SDK", lost: [
      { what: "버킷 IAM 정책 (공개 여부만 옮김)" },
      { what: "차가운 저장 등급 (도착은 GLACIER_IR)", when: hasCold },
      { what: "객체 (복사하지 않음, 빈 버킷)" },
    ] },
  },
};

function moveOf<K extends DataKind>(kind: K, c: Of<K>, source: Cloud, target: Cloud): Omit<ApprovalRowV2, "kind" | "subject"> {
  const move = MOVES[kind][`${source}>${target}` as Direction];
  return { from: PRODUCT[source][kind](c), to: PRODUCT[target][kind](c),
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
