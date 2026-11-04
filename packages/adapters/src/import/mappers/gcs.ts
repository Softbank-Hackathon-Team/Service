import { DATA_RAW_KINDS, type RawGcsBucket } from "../raw-data.js";
import { corsOf } from "./s3.js";
import { gcsNotifications } from "./notify.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): Cloud Storage 버킷 → objectStore (설계 20번 6.6장). S3 와 같은 세 값 public:
//   publicAccessPrevention=enforced → false(확실한 차단) / allUsers·allAuthenticatedUsers 바인딩 있음 → true / 바인딩 없음 확인 → false / 못 읽음 → null
// DM-1 DRAFT(ai): GCS cors(origin·method·responseHeader·maxAgeSeconds, gcloud storage 는 snake_case 도) → IR CorsRuleV2.
//   GCS responseHeader 는 preflight 허용 헤더(Access-Control-Allow-Headers)와 응답 노출 헤더 둘 다에 쓰인다 → allowedHeaders·exposeHeaders 둘 다에 넣는다
const GCS_CORS = { origins: ["origin"], methods: ["method"], allowed: ["responseHeader", "response_header"], expose: ["responseHeader", "response_header"],
  maxAge: ["maxAgeSeconds", "max_age_seconds"] };
export const gcsMapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.gcs],
  kind: "objectStore",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const b = item as unknown as RawGcsBucket;
    if (!b.name) return { skip: "버킷 이름 없음 (깨진 원본)", grade: "C" };
    const id = b.name, src = (k: string) => `gcs:${id}.${k}`;
    let pub: boolean | null, why: string;
    if (b.allUsersBinding === true) { pub = true; why = "allUsers·allAuthenticatedUsers 바인딩이 있음"; }
    else if (b.publicAccessPrevention === "enforced") { pub = false; why = "publicAccessPrevention=enforced"; }
    else if (b.allUsersBinding === false) { pub = false; why = "공개 바인딩 없음 확인"; }
    else { pub = null; why = "공개 여부를 확인 못 함 (IAM 정책을 못 읽음)"; }
    const rules = Array.isArray(b.lifecycleRules) ? b.lifecycleRules : [];
    let dropped = 0;
    const lifecycle: Array<{ prefix: string; expireDays?: number; toColdAfterDays?: number }> = [];
    for (const r of rules) {
      const age = r.condition?.age, type = r.action?.type, prefixes = r.condition?.matchesPrefix;
      // 담을 수 있는 규칙: 삭제(Delete) 또는 등급 이동(SetStorageClass), 접두어 0~1개, 나이 조건 있음, 다른 조건(등급 필터)은 없음
      // VI6: age·matchesPrefix 말고 다른 조건(isLive·numNewerVersions·createdBefore·daysSinceNoncurrentTime 등)이 있으면 못 담는다 (빼먹으면 현재 객체까지 지워짐)
      const onlyAgePrefix = Object.keys(r.condition ?? {}).every((k) => k === "age" || k === "matchesPrefix");
      if (typeof age !== "number" || (type !== "Delete" && type !== "SetStorageClass") || (prefixes?.length ?? 0) > 1 || !onlyAgePrefix) { dropped++; continue; }
      lifecycle.push({ prefix: prefixes?.[0] ?? "", ...(type === "Delete" ? { expireDays: age } : { toColdAfterDays: age }) });
    }
    lifecycle.sort((x, y) => (x.prefix < y.prefix ? -1 : x.prefix > y.prefix ? 1 : 0));
    const props: Record<string, unknown> = { versioning: b.versioning === true, public: pub, sizeGb: null };
    if (lifecycle.length) props.lifecycle = lifecycle;
    const cors = corsOf(b.cors, GCS_CORS);
    if (cors.rules.length) props.cors = cors.rules;
    const meta: Record<string, MetaTuple> = {
      versioning: [src("versioning"), 1],
      public: pub === null ? [src("iam"), 0.6, why] : [src("iam"), 1, why],
      sizeGb: [src("storage/total_bytes"), 0.6, "크기 못 읽음 (Monitoring 지표는 이 읽기에 안 넣음)"],
    };
    const nf = gcsNotifications(b, src("notifications"));
    if (nf?.items.length) props.notifications = nf.items;
    if (nf?.meta) meta.notifications = nf.meta;
    if (dropped) meta.lifecycle = [src("lifecycle"), 0.6, `못 담는 규칙 ${dropped}개를 뺌`];
    else if (lifecycle.length) meta.lifecycle = [src("lifecycle"), 1];
    if (cors.dropped) meta.cors = [src("cors"), 0.6, `출처·메서드가 없는 CORS 규칙 ${cors.dropped}개를 뺌`];
    else if (cors.rules.length) meta.cors = [src("cors"), 0.9, "GCS responseHeader 는 요청 허용·응답 노출 헤더를 같이 정함 (S3 도착이면 둘 다로 나눔)"];
    // G3b-4: 경로·가상 호스트 주소, 자원 이름 꼴 (gs://bkt 는 URL 호스트라 이름으로 맞음)
    const aliases = [`storage.googleapis.com/${id}`, `${id}.storage.googleapis.com`, `projects/_/buckets/${id}`];
    return { name: id, kind: "objectStore", native: { type: DATA_RAW_KINDS.gcs, name: id, endpoint: id, aliases, uid: b.selfLink ?? null }, props, meta,
      ...(nf?.refs.length ? { notifyRefs: nf.refs.map((r) => ({ field: "notifications" as const, ...r })) } : {}) };
  },
};
