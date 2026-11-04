// DM-2·RF-2: S3 버킷 칸을 "못 읽은 것"과 "설정 없음"을 가른다. 못 읽음 → null·생략 + 신뢰도 0.6, 설정 없음(NoSuch…) → 확신 1 유지
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAwsData } from "../src/discover/data.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { s3Mapper } from "../src/import/mappers/s3.js";
import { v2Blockers } from "../src/target/shared.js";
import { fakeExec, type Reply } from "./fake-cli.js";
import type { RawItem } from "../src/import/types.js";

const DENY: Reply = { code: 254, err: "An error occurred (AccessDenied) when calling the operation: Access Denied" };
const bucket = (over: Array<[RegExp, Reply]>) => fakeExec([
  ...over,
  [/^aws s3api list-buckets/, { out: { Buckets: [{ Name: "shop-assets" }] } }],
  [/^aws s3api get-bucket-versioning/, { out: { Status: "Enabled" } }],
  [/^aws s3api get-public-access-block/, { out: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } } }],
  [/^aws s3api get-bucket-policy-status/, { code: 254, err: "NoSuchBucketPolicy" }],
  [/^aws s3api get-bucket-acl/, { out: { Grants: [] } }],
  [/^aws s3api get-bucket-lifecycle-configuration/, { out: { Rules: [{ Status: "Enabled", Filter: { Prefix: "tmp/" }, Expiration: { Days: 90 } }] } }],
  [/^aws s3api get-bucket-cors/, { out: { CORSRules: [{ AllowedOrigins: ["https://shop.example.com"], AllowedMethods: ["PUT"] }] } }],
  [/^aws cloudwatch get-metric-statistics/, { out: { Datapoints: [] } }],
  [/^aws sqs list-queues/, { out: {} }], [/^aws elasticache describe-replication-groups/, { out: {} }],
]);
const mapped = async (over: Array<[RegExp, Reply]>) => {
  const { exec } = bucket(over);
  const items = await readAwsData({ exec, env: {} }, "r", []);
  const c = s3Mapper.map(items.find((i) => i.kind === "s3.bucket") as RawItem);
  if ("skip" in c) throw new Error(c.skip);
  return c;
};

test("DM-2: get-bucket-versioning 거부 → versioning null + 신뢰도 0.6 (false 로 확신하지 않음)", async () => {
  const c = await mapped([[/^aws s3api get-bucket-versioning/, DENY]]);
  assert.equal(c.props.versioning, null);
  assert.equal(c.meta.versioning?.[1], 0.6);
});

test("DM-2: 수명 주기·CORS 거부 → 칸 생략 + 검토 표시 (규칙 0개로 조용히 넘어가지 않음)", async () => {
  const c = await mapped([[/^aws s3api get-bucket-lifecycle-configuration/, DENY], [/^aws s3api get-bucket-cors/, DENY]]);
  assert.equal(c.props.lifecycle, undefined);
  assert.equal(c.props.cors, undefined);
  assert.equal(c.meta.lifecycle?.[1], 0.6);
  assert.equal(c.meta.cors?.[1], 0.6);
});

test("DM-2: 설정 없음(NoSuchLifecycleConfiguration·NoSuchCORSConfiguration) · 한 번도 안 켠 버전 관리 → 확신 1 유지", async () => {
  const c = await mapped([[/^aws s3api get-bucket-versioning/, { out: {} }],
    [/^aws s3api get-bucket-lifecycle-configuration/, { code: 254, err: "An error occurred (NoSuchLifecycleConfiguration)" }],
    [/^aws s3api get-bucket-cors/, { code: 254, err: "An error occurred (NoSuchCORSConfiguration)" }]]);
  assert.equal(c.props.versioning, false);
  assert.equal(c.meta.versioning?.[1], 1);
  assert.equal(c.meta.lifecycle, undefined);
  assert.equal(c.meta.cors, undefined);
});

test("DM-2: 칸 하나 스로틀링 → 없음으로 두지 않고 다시 가져오기(SOURCE_TRANSIENT)", async () => {
  const { exec } = bucket([[/^aws s3api get-bucket-versioning/, { code: 254, err: "ThrottlingException: Rate exceeded" }]]);
  await assert.rejects(readAwsData({ exec, env: {} }, "r", []), (e: { code?: string }) => e.code === "SOURCE_TRANSIENT");
});

test("DM-2: 명세 versioning null 은 도착 Builder 가 사람에게 묻는다 (조용히 끈 버킷을 만들지 않음)", async () => {
  const { exec } = bucket([[/^aws s3api get-bucket-versioning/, DENY]]);
  const items = await readAwsData({ exec, env: {} }, "r", []);
  const r = normalizeV2({ provider: "aws", items, coverage: {} }).result;
  assert.equal(r.fieldMeta["components.shop-assets.versioning"]?.needs_review, true);
  // 공통 명세는 버킷 하나뿐 (경계: 워크로드가 없으면 전부 둠)
  assert.ok(v2Blockers(r.spec, []).needsHuman.some((x) => x.includes("버전 관리 설정을 못 읽음")));
});
