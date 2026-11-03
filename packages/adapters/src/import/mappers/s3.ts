import { DATA_RAW_KINDS, type RawS3Bucket } from "../raw-data.js";
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

export const s3Mapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.s3],
  kind: "objectStore",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const b = item as unknown as RawS3Bucket;
    if (!b.Name) return { skip: "버킷 이름 없음 (깨진 원본)", grade: "C" };
    const id = b.Name;
    const pub = s3Public(b);
    const versioning = b.Versioning === "Enabled";   // Suspended·없음 = false
    const sizeGb = typeof b.SizeBytes === "number" && b.SizeBytes >= 0 ? Math.round((b.SizeBytes / 1024 ** 3) * 1000) / 1000 : null;
    // 수명 주기: 켜진 규칙만. 접두어·만료일·저장 등급 이동일만 담고, 태그 필터 같은 못 담는 조건이 있는 규칙은 뺀다(0.6)
    const rules = Array.isArray(b.Lifecycle) ? b.Lifecycle.filter((r) => r && r.Status !== "Disabled") : [];
    let dropped = 0;
    const lifecycle: Array<{ prefix: string; expireDays?: number; toColdAfterDays?: number }> = [];
    for (const r of rules) {
      // VI6: 접두어 말고 다른 필터(태그·And·크기 ObjectSize*)가 하나라도 있으면 못 담는다 (빼먹으면 규칙이 버킷 전체에 걸림)
      if (r.Filter && Object.keys(r.Filter).some((k) => k !== "Prefix")) { dropped++; continue; }
      const prefix = r.Filter?.Prefix ?? r.Prefix ?? "";
      const expireDays = r.Expiration?.Days;
      const cold = r.Transitions?.map((t) => t.Days).filter((d): d is number => typeof d === "number").sort((x, y) => x - y)[0];
      if (expireDays === undefined && cold === undefined) { dropped++; continue; }
      lifecycle.push({ prefix, ...(typeof expireDays === "number" ? { expireDays } : {}), ...(cold !== undefined ? { toColdAfterDays: cold } : {}) });
    }
    lifecycle.sort((x, y) => (x.prefix < y.prefix ? -1 : x.prefix > y.prefix ? 1 : 0));
    const props: Record<string, unknown> = { versioning, public: pub.value, sizeGb };
    if (lifecycle.length) props.lifecycle = lifecycle;
    if (Array.isArray(b.Cors) && b.Cors.length) props.cors = b.Cors;
    const src = (k: string) => `s3:${id}.${k}`;
    const meta: Record<string, MetaTuple> = {
      versioning: [src("Versioning"), 1],
      public: pub.value === null ? [src("PublicAccess"), 0.6, pub.why] : [src("PublicAccess"), 1, pub.why],
      sizeGb: sizeGb === null ? [src("BucketSizeBytes"), 0.6, "크기 못 읽음 (복사 시간을 못 셈)"] : [src("BucketSizeBytes"), 0.9, "CloudWatch 하루 1번 값"],
    };
    if (dropped) meta.lifecycle = [src("Lifecycle"), 0.6, `태그·크기 필터 등 못 담는 규칙 ${dropped}개를 뺌`];
    else if (lifecycle.length) meta.lifecycle = [src("Lifecycle"), 1];
    return { name: id, kind: "objectStore", native: { type: DATA_RAW_KINDS.s3, name: id, endpoint: id, uid: b.Arn ?? null }, props, meta };
  },
};
