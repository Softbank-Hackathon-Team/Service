// fc1: 버킷 CORS 칸 이름(DM-1·TF4-1)과 공개 버킷 그대로 이식(B-2)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, ImportResultV2, checkV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor, v2Blockers } from "../src/index.js";
import { resourceTypesV2For } from "../src/target/index.js";

type Raw = Record<string, any>;
const inv = (items: Raw[], provider = "aws"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);
const comp = (spec: AppSpecV2, id: string) => spec.components.find((c) => c.id === id) as unknown as { id: string; kind: string; props: Raw };
const s3 = (o: Raw = {}): Raw => ({ kind: "s3.bucket", Name: "shop-assets", Versioning: "Enabled",
  PublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  PolicyStatusIsPublic: false, AclPublic: false, SizeBytes: 1024 ** 3, Lifecycle: [], Cors: [], Arn: "arn:aws:s3:::shop-assets", ...o });
const gcs = (o: Raw = {}): Raw => ({ kind: "gcs.bucket", name: "shop-gcs", versioning: true, publicAccessPrevention: "enforced", allUsersBinding: false,
  lifecycleRules: [], cors: [], ...o });
// AWS CLI get-bucket-cors 의 CORSRules 모양 그대로 (첫 글자 대문자)
const S3_RULE = { ID: "upload", AllowedOrigins: ["https://shop.example.com"], AllowedMethods: ["GET", "PUT", "POST"], AllowedHeaders: ["Content-Type"],
  ExposeHeaders: ["ETag"], MaxAgeSeconds: 3000 };
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
const objJson = (p: "aws" | "gcp", spec: AppSpecV2) => JSON.parse(String(targetBuilderFor(p).toTerraformV2(spec, T(p)).vars.object_store_json)) as Raw[];
const tf = (p: string) => readFileSync(new URL(`../../../infra/modules/${p}/kinds/object-store/main.tf`, import.meta.url), "utf8");

test("DM-1·TF4-1: S3 CORSRules(대문자 칸) → IR 공통 모양, 출처·메서드·헤더·캐시 시간 그대로 → cors_json 까지 같은 값", () => {
  const { result } = normalizeV2(inv([s3({ Cors: [S3_RULE] })]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  const c = comp(result.spec, "shop-assets");
  const want = { origins: ["https://shop.example.com"], methods: ["GET", "PUT", "POST"], allowedHeaders: ["Content-Type"], exposeHeaders: ["ETag"], maxAgeSec: 3000 };
  assert.deepEqual(c.props.cors, [want]);
  assert.notEqual((result as any).fieldMeta["components.shop-assets.cors"]?.needs_review, true);
  for (const p of ["aws", "gcp"] as const) assert.deepEqual(JSON.parse(objJson(p, result.spec)[0]!.cors_json), [want], p);
});

test("DM-1: GCS cors(origin·method·responseHeader, snake_case 도) → 같은 IR 모양. responseHeader 는 요청·응답 헤더 둘 다", () => {
  const { result } = normalizeV2(inv([gcs({ cors: [{ origin: ["https://a.example"], method: ["GET", "PUT"], responseHeader: ["Content-Type"], maxAgeSeconds: 60 },
    { origin: ["*"], method: ["GET"], response_header: ["ETag"], max_age_seconds: 10 }] })], "gcp"));
  assert.deepEqual(comp(result.spec, "shop-gcs").props.cors, [
    { origins: ["https://a.example"], methods: ["GET", "PUT"], allowedHeaders: ["Content-Type"], exposeHeaders: ["Content-Type"], maxAgeSec: 60 },
    { origins: ["*"], methods: ["GET"], allowedHeaders: ["ETag"], exposeHeaders: ["ETag"], maxAgeSec: 10 }]);
});

test("DM-1 거부: 출처·메서드가 없는 규칙은 \"*\"·GET 으로 채우지 않고 빼고 검토 표시(0.6). IR 은 옛 모양(대문자 칸)·빈 출처를 거부", () => {
  const { result } = normalizeV2(inv([s3({ Cors: [S3_RULE, { AllowedMethods: ["GET"] }] })]));
  assert.equal(comp(result.spec, "shop-assets").props.cors.length, 1);
  assert.equal((result as any).fieldMeta["components.shop-assets.cors"]?.needs_review, true);
  const bad = (cors: unknown) => {
    const s = structuredClone(result.spec) as Raw;
    comp(s as AppSpecV2, "shop-assets").props.cors = cors;
    return AppSpecV2.safeParse(s).success;
  };
  assert.equal(bad([S3_RULE]), false, "출발 모양 그대로는 IR 이 아님");
  assert.equal(bad([{ origins: [], methods: ["GET"] }]), false, "빈 출처");
  assert.equal(bad([{ origins: ["https://a"], methods: [] }]), false, "빈 메서드");
  // 모듈: 대체값 "*"·GET 이 없어야 하고, 칸이 없으면 validation 으로 거부
  for (const p of ["aws", "gcp"]) {
    const src = tf(p);
    assert.doesNotMatch(src, /\["\*"\]\)|\["GET"\]\)/, `${p} 모듈에 "*"·GET 대체값이 남음`);
    assert.match(src, /length\(try\(r\.origins, \[\]\)\) > 0 && length\(try\(r\.methods, \[\]\)\) > 0/, `${p} 모듈 CORS validation`);
  }
});

test("B-2: 출발이 공개 버킷이면 도착도 공개 — 막지 않음(needsHuman 없음), 승인 줄 public_bucket, 모듈이 공개로 엶", () => {
  const { result } = normalizeV2(inv([s3({ PolicyStatusIsPublic: true, PublicAccessBlock: null })]));
  const spec = result.spec;
  assert.equal(comp(spec, "shop-assets").props.public, true);
  const ap = checkV2(spec).approvals.filter((a) => a.kind === "public_bucket");
  assert.deepEqual(ap.map((a) => a.subject), ["shop-assets"]);
  for (const p of ["aws", "gcp"] as const) {
    const b = v2Blockers(spec, targetBuilderFor(p).capabilities());
    assert.ok(!b.needsHuman.some((x) => /shop-assets/.test(x)), `${p}: ${b.needsHuman.join(" | ")}`);
    assert.equal(objJson(p, spec)[0]!.public, true);
  }
  assert.ok(resourceTypesV2For("aws", spec).includes("aws_s3_bucket_policy"));
  assert.ok(resourceTypesV2For("gcp", spec).includes("google_storage_bucket_iam_member"));
  assert.ok(!resourceTypesV2For("aws", normalizeV2(inv([s3()])).result.spec).includes("aws_s3_bucket_policy"), "비공개면 정책 종류 없음");
  assert.match(tf("aws"), /block_public_policy\s*=\s*!local\.open_public/);
  assert.match(tf("aws"), /resource "aws_s3_bucket_policy" "public_read"[\s\S]*count\s*=\s*local\.open_public \? 1 : 0/);
  assert.match(tf("gcp"), /public_access_prevention\s*=\s*var\.cfg\.public == true \? "inherited" : "enforced"/);
  assert.match(tf("gcp"), /member = "allUsers"/);
  assert.doesNotMatch(tf("aws") + tf("gcp"), /TODO\(human\): public=true/);
});

test("B-2 거부: 비공개(false)·모름(null) 버킷은 승인 줄 없음, 모름은 계속 사람에게 묻고 모듈은 막음", () => {
  const priv = normalizeV2(inv([s3()])).result.spec;
  assert.equal(checkV2(priv).approvals.some((a) => a.kind === "public_bucket"), false);
  const unk = normalizeV2(inv([s3({ PolicyStatusIsPublic: null, AclPublic: null, PublicAccessBlock: null })])).result.spec;
  assert.equal(comp(unk, "shop-assets").props.public, null);
  assert.equal(checkV2(unk).approvals.some((a) => a.kind === "public_bucket"), false);
  assert.ok(v2Blockers(unk, targetBuilderFor("aws").capabilities()).needsHuman.some((x) => /shop-assets: 버킷 공개 여부를 못 읽음/.test(x)));
});
