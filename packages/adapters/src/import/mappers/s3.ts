import { DATA_RAW_KINDS, type RawS3Bucket } from "../raw-data.js";
import { s3Notifications } from "./notify.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): AWS S3 버킷 → objectStore (설계 20번 6.6장). id 는 버킷 이름(이름 충돌은 도착 모듈이 접미사).
//   public 은 세 값: 확실한 공개 신호만 true, 확실한 차단만 false, 나머지 null + 검토 (잘못된 true 는 공개 버킷을 새로 연다)
//   못 읽은 값은 null·생략 + 신뢰도 0.6 (지어내지 않음)
type Pab = NonNullable<RawS3Bucket["PublicAccessBlock"]>;
const allBlocked = (p: Pab | null | undefined) => !!p && p.BlockPublicAcls === true && p.IgnorePublicAcls === true && p.BlockPublicPolicy === true && p.RestrictPublicBuckets === true;

export function s3Public(b: RawS3Bucket): { value: boolean | null; why: string } {
  if (b.PolicyStatusIsPublic === true) return { value: true, why: "버킷 정책이 공개 (PolicyStatus.IsPublic)" };
  if (b.AclPublic === true) return { value: true, why: "ACL 이 AllUsers·AuthenticatedUsers 에 열려 있음" };
  if (allBlocked(b.PublicAccessBlock)) return { value: false, why: "퍼블릭 액세스 차단 4개 전부 켜짐" };
  if (b.PolicyStatusIsPublic === false && b.AclPublic === false) return { value: false, why: "정책·ACL 둘 다 비공개 확인" };
  return { value: null, why: "공개 여부를 확인 못 함 (차단 설정·정책·ACL 중 못 읽은 것이 있음)" };
}

// DM-1·TF4-1 DRAFT(ai): S3 CORSRules(AllowedOrigins·AllowedMethods·AllowedHeaders·ExposeHeaders·MaxAgeSeconds) → IR CorsRuleV2.
//   칸 이름만 바꾸고 값은 그대로. 출처·메서드가 없는 규칙(깨진 원본)은 빼고 개수를 검토 표시로 (지어내서 "*"·GET 으로 채우지 않음)
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined);
export function corsRuleOf(r: Record<string, unknown>, k: { origins: string[]; methods: string[]; allowed?: string[]; expose: string[]; maxAge: string[] }) {
  const pick = (names: string[]) => names.map((n) => r[n]).find((v) => v !== undefined);
  const origins = strs(pick(k.origins)), methods = strs(pick(k.methods));
  if (!origins?.length || !methods?.length) return null;
  const allowedHeaders = k.allowed ? strs(pick(k.allowed)) : undefined, exposeHeaders = strs(pick(k.expose));
  const age = Number(pick(k.maxAge));
  const maxAge = pick(k.maxAge) !== undefined && Number.isInteger(age) && age >= 0 ? age : undefined;
  return { origins, methods, ...(allowedHeaders?.length ? { allowedHeaders } : {}), ...(exposeHeaders?.length ? { exposeHeaders } : {}),
    ...(maxAge !== undefined ? { maxAgeSec: maxAge } : {}) };
}
type CorsOut = NonNullable<ReturnType<typeof corsRuleOf>>;
export function corsOf(raw: unknown, k: Parameters<typeof corsRuleOf>[1]): { rules: CorsOut[]; dropped: number } {
  const rules: CorsOut[] = [];
  let dropped = 0;
  for (const r of Array.isArray(raw) ? raw : []) {
    const x = r && typeof r === "object" ? corsRuleOf(r as Record<string, unknown>, k) : null;
    if (x) rules.push(x); else dropped++;
  }
  return { rules, dropped };
}
const S3_CORS = { origins: ["AllowedOrigins"], methods: ["AllowedMethods"], allowed: ["AllowedHeaders"], expose: ["ExposeHeaders"], maxAge: ["MaxAgeSeconds"] };

export const s3Mapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.s3],
  kind: "objectStore",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const b = item as unknown as RawS3Bucket;
    if (!b.Name) return { skip: "버킷 이름 없음 (깨진 원본)", grade: "C" };
    const id = b.Name;
    const pub = s3Public(b);
    // DM-2·RF-2: 못 읽은 칸(Unread)은 "꺼짐/없음"이 아니다 → versioning null, 수명 주기·CORS 는 칸 생략, 셋 다 신뢰도 0.6 + 이유
    const unread = new Set(b.Unread ?? []);
    const versioning = unread.has("Versioning") ? null : b.Versioning === "Enabled";   // Suspended·한 번도 안 켬 = false
    const sizeGb = typeof b.SizeBytes === "number" && b.SizeBytes >= 0 ? Math.round((b.SizeBytes / 1024 ** 3) * 1000) / 1000 : null;
    // 수명 주기: 켜진 규칙만. 접두어·만료일·저장 등급 이동일만 담고, 태그 필터 같은 못 담는 조건이 있는 규칙은 뺀다(0.6)
    const rules = Array.isArray(b.Lifecycle) ? b.Lifecycle.filter((r) => r && r.Status !== "Disabled") : [];
    let dropped = 0, partial = 0;
    const lifecycle: Array<{ prefix: string; expireDays?: number; toColdAfterDays?: number }> = [];
    for (const r of rules) {
      // VI6: 접두어 말고 다른 필터(태그·And·크기 ObjectSize*)가 하나라도 있으면 못 담는다 (빼먹으면 규칙이 버킷 전체에 걸림)
      if (r.Filter && Object.keys(r.Filter).some((k) => k !== "Prefix")) { dropped++; continue; }
      const prefix = r.Filter?.Prefix ?? r.Prefix ?? "";
      const expireDays = r.Expiration?.Days;
      const cold = r.Transitions?.map((t) => t.Days).filter((d): d is number => typeof d === "number").sort((x, y) => x - y)[0];
      // DM-8: 날짜 지정 만료·옛 버전 만료·지운 표시 정리·멀티파트 정리는 IR 에 칸이 없다 → 규칙의 그 부분이 빠짐을 검토 표시
      const lost = !!(r.Expiration?.Date || r.Expiration?.ExpiredObjectDeleteMarker || r.NoncurrentVersionExpiration || r.NoncurrentVersionTransitions
        || r.AbortIncompleteMultipartUpload || r.Transitions?.some((t) => typeof t.Days !== "number"));
      if (expireDays === undefined && cold === undefined) { dropped++; continue; }
      if (lost) partial++;
      lifecycle.push({ prefix, ...(typeof expireDays === "number" ? { expireDays } : {}), ...(cold !== undefined ? { toColdAfterDays: cold } : {}) });
    }
    lifecycle.sort((x, y) => (x.prefix < y.prefix ? -1 : x.prefix > y.prefix ? 1 : 0));
    const props: Record<string, unknown> = { versioning, public: pub.value, sizeGb };
    if (lifecycle.length) props.lifecycle = lifecycle;
    const cors = corsOf(b.Cors, S3_CORS);
    if (cors.rules.length && !unread.has("Cors")) props.cors = cors.rules;
    const src = (k: string) => `s3:${id}.${k}`;
    const meta: Record<string, MetaTuple> = {
      versioning: versioning === null ? [src("Versioning"), 0.6, "버전 관리 설정을 못 읽음 (꺼짐과 다름). 출발 값을 사람이 확인"] : [src("Versioning"), 1],
      public: pub.value === null ? [src("PublicAccess"), 0.6, pub.why] : [src("PublicAccess"), 1, pub.why],
      // DM-8: 등급 목록을 못 읽었으면(SizeStorageTypes null) StandardStorage 만 센 값 → 작을 수 있어 검토. 필드가 아예 없으면 옛 원본(그대로 0.9)
      sizeGb: sizeGb === null ? [src("BucketSizeBytes"), 0.6, "크기 못 읽음 (복사 시간을 못 셈)"]
        : b.SizeStorageTypes === null ? [src("BucketSizeBytes"), 0.6, "StandardStorage 만 셈 (다른 저장 등급 목록을 못 읽음, cloudwatch:ListMetrics) → 실제보다 작을 수 있음"]
        : [src("BucketSizeBytes"), 0.9, `CloudWatch 하루 1번 값${b.SizeStorageTypes?.length ? ` (등급 ${b.SizeStorageTypes.join("·")} 합)` : ""}`],
    };
    const nf = s3Notifications(b, src("Notification"));
    if (nf?.items.length) props.notifications = nf.items;
    if (nf?.meta) meta.notifications = nf.meta;
    if (unread.has("Lifecycle")) meta.lifecycle = [src("Lifecycle"), 0.6, "수명 주기 설정을 못 읽음 (규칙 없음과 다름) → 도착에 규칙을 안 만듦. 출발 규칙을 사람이 확인"];
    else if (dropped || partial) meta.lifecycle = [src("Lifecycle"), 0.6, [dropped ? `태그·크기 필터 등 못 담는 규칙 ${dropped}개를 뺌` : "",
      partial ? `규칙 ${partial}개는 날짜 만료·옛 버전 만료·멀티파트 정리 부분이 빠짐 (IR 에 칸 없음)` : ""].filter(Boolean).join("; ")];
    else if (lifecycle.length) meta.lifecycle = [src("Lifecycle"), 1];
    if (unread.has("Cors")) meta.cors = [src("Cors"), 0.6, "CORS 설정을 못 읽음 (없음과 다름) → 도착에 CORS 를 안 만듦. 출발 규칙을 사람이 확인"];
    else if (cors.dropped) meta.cors = [src("CORSRules"), 0.6, `출처·메서드가 없는 CORS 규칙 ${cors.dropped}개를 뺌`];
    else if (cors.rules.length) meta.cors = [src("CORSRules"), 1];
    // G3b-4: ARN·가상 호스트·경로 주소. 리전이 든 주소(bkt.s3.<리전>.amazonaws.com, s3.<리전>.amazonaws.com/bkt)는 tokensOf 가 리전 없는 꼴로도 뽑는다
    const aliases = [b.Arn ?? `arn:aws:s3:::${id}`, `${id}.s3.amazonaws.com`, `s3.amazonaws.com/${id}`];
    return { name: id, kind: "objectStore", native: { type: DATA_RAW_KINDS.s3, name: id, endpoint: id, aliases, uid: b.Arn ?? null }, props, meta,
      ...(nf?.refs.length ? { notifyRefs: nf.refs.map((r) => ({ field: "notifications" as const, ...r })) } : {}) };
  },
};
