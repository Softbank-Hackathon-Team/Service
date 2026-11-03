import type { AppSpecV2, ComponentV2 } from "@svc/contracts";
import { boundedName } from "../common/names.js";
import { nameSeed, type Target } from "../common/target.js";
import { connectIdentities, kindJson } from "./shared.js";

// TA12 DRAFT(ai): 데이터 자원(cache·objectStore·queue) → 도착 Terraform 종류 변수 (tf-kinds.ts A0b 계약). aws·gcp 가 같이 쓰는 순수 함수.
//   원칙: IR 에 있는 칸은 그대로 옮기고, 없는(null·생략) 칸은 null 로 보내 모듈 기본값이 정하게 한다 (어댑터가 값을 지어내지 않음).
//   이름은 전역/재사용 충돌을 피하려고 boundedName(해시6, seed = 환경·앱·id·이전) — v1 DB 이름과 같은 방식.
type Cache = Extract<ComponentV2, { kind: "cache" }>;
type ObjectStore = Extract<ComponentV2, { kind: "objectStore" }>;
type Queue = Extract<ComponentV2, { kind: "queue" }>;

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
export const cachesOf = (s: AppSpecV2): Cache[] => byId(s.components.filter((c): c is Cache => c.kind === "cache"));
export const objectStoresOf = (s: AppSpecV2): ObjectStore[] => byId(s.components.filter((c): c is ObjectStore => c.kind === "objectStore"));
export const queuesOf = (s: AppSpecV2): Queue[] => byId(s.components.filter((c): c is Queue => c.kind === "queue"));

// TA12b DRAFT(ai): 이름 접두어 "app-" — 실행 역할 정책이 "app-*" 이름의 자원에만 쓰기 권한을 주려면 이름이 접두어로 시작해야 함 (IAM 역할·SA 와 같은 규칙)
const nm = (spec: AppSpecV2, id: string, t: Target, max: number, app = id) =>
  boundedName({ prefix: "app-", app, seed: [nameSeed(t), spec.app.name, id, t.migrationId ?? t.envId], max });
// VTA12 DRAFT(ai): 버킷 이름 금지어. GCS = "goog" 로 시작·"google" 포함 불가, S3 = "sthree-" 로 시작 불가. 해당 id 만 앞부분을 바꾼다
//   (다른 id 의 이름은 그대로 → planHash 안 흔들림). seed 는 원래 id 라 해시는 같다
export const bucketApp = (id: string) => {
  let a = id.replace(/[^a-z0-9]/g, "").replace(/google/g, "ggl");
  if (a.startsWith("goog")) a = `gog${a.slice(4)}`;
  if (a === "sthree") a = "s3";   // 잘린 이름 + "-해시" 라 "sthree-" 는 id 가 정확히 sthree 일 때만
  return a;
};

// DRAFT(ai): 이름 길이 — 캐시 40(ElastiCache 복제 그룹·Memorystore 인스턴스 한도), 버킷 63, 큐·토픽 60(SQS .fifo 접미어 여유)
export function cacheVars(spec: AppSpecV2, t: Target) {
  return kindJson("cache", cachesOf(spec).map((c) => ({
    id: c.id, name: nm(spec, c.id, t, 40), engine: c.props.engine, version: c.props.version ?? null, memory_mib: c.props.memoryMiB ?? null,
    cluster_mode: c.props.clusterMode ?? null, shards: c.props.shards ?? null, tls: c.props.tls ?? null, auth: c.props.auth ?? null, ha: c.props.ha ?? null,
    allow_from_json: JSON.stringify(connectIdentities(spec, c.id)),
  })));
}

export function objectStoreVars(spec: AppSpecV2, t: Target) {
  return kindJson("objectStore", objectStoresOf(spec).map((c) => ({
    id: c.id, name: nm(spec, c.id, t, 63, bucketApp(c.id)), versioning: c.props.versioning,
    public: c.props.public,   // null 은 null 그대로 (모듈이 비공개로 만들고 사람에게 묻는다 — 공개로 열지 않음)
    size_gb: c.props.sizeGb,
    lifecycle_json: JSON.stringify([...(c.props.lifecycle ?? [])].sort((a, b) => a.prefix.localeCompare(b.prefix))),
    cors_json: JSON.stringify(c.props.cors ?? []),
    allow_from_json: JSON.stringify(connectIdentities(spec, c.id)),
    // DRAFT(ai): IR 에 없는 플랫폼 값. 기본 false(데이터 보호). 데모 정리(disposable)는 withDbNetworkV2 같은 함수가 켬 (TODO(human): 지금 데모 정리 연결 없음)
    force_destroy: false,
  })));
}

export function queueVars(spec: AppSpecV2, t: Target) {
  return kindJson("queue", queuesOf(spec).map((c) => ({
    id: c.id, name: nm(spec, c.id, t, 60), model: c.props.model, ordered: c.props.ordered ?? null, retention_sec: c.props.retentionSec ?? null,
    ack_timeout_sec: c.props.ackTimeoutSec ?? null,
    dead_letter_to: c.props.deadLetter?.to ?? null,   // 같은 명세 안 다른 queue id 그대로 (참조 유지). 대상 검증은 v2Blockers
    dead_letter_max_receive: c.props.deadLetter?.maxReceive ?? null,
    allow_from_json: JSON.stringify(connectIdentities(spec, c.id)),
  })));
}

/** 데이터 자원이 있으면 켜지는 Terraform 자원 종류 (권한표·"생길 자원" 목록용) */
export const DATA_TYPES = {
  aws: { cache: ["aws_elasticache_replication_group", "aws_elasticache_subnet_group", "aws_security_group"],
    objectStore: ["aws_s3_bucket", "aws_s3_bucket_public_access_block", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_versioning",
      "aws_s3_bucket_lifecycle_configuration", "aws_s3_bucket_cors_configuration"],
    queue: ["aws_sqs_queue", "aws_sns_topic"] },
  gcp: { cache: ["google_redis_instance"], objectStore: ["google_storage_bucket"], queue: ["google_pubsub_topic", "google_pubsub_subscription"] },
} as const;

export function dataTypesOf(p: "aws" | "gcp", spec: AppSpecV2): string[] {
  const t = new Set<string>();
  if (cachesOf(spec).length) DATA_TYPES[p].cache.forEach((x) => t.add(x));
  if (objectStoresOf(spec).length) DATA_TYPES[p].objectStore.forEach((x) => t.add(x));
  if (queuesOf(spec).length) DATA_TYPES[p].queue.forEach((x) => t.add(x));
  return [...t];
}
