// BOUNDARY: 가져오기 앱 경계. 계정 전체를 읽은 데이터 자원 중 이 앱의 서비스·잡이 근거(env·비밀·IAM)로 닿는 것만 명세에. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/index.js";

type Raw = Record<string, any>;
const NS = "shop";
const D = "sha256:" + "ab".repeat(32);
const ACC = "000000000000";
const inv = (items: Raw[]): RawInventory => ({ provider: "aws", coverage: {}, items });
const dep = (name: string, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const bucket = (name: string): Raw => ({ kind: "s3.bucket", Name: name, Arn: `arn:aws:s3:::${name}` });
const queue = (name: string, dlq?: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/${name}`,
  Attributes: { QueueArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${name}`, ...(dlq ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${dlq}`, maxReceiveCount: 3 }) } : {}) } });
const rds = (id: string): Raw => ({ kind: "rds.dbInstance", DBInstanceIdentifier: id, Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20,
  Endpoint: { Address: `${id}.abc.ap-northeast-2.rds.amazonaws.com` }, DBInstanceArn: `arn:aws:rds:ap-northeast-2:${ACC}:db:${id}` });
const ids = (r: ImportResultV2) => r.spec.components.map((c) => c.id).sort();
const outs = (r: ImportResultV2) => (r.outOfBoundary ?? []).map((o) => o.resource);

test("정상: 서비스가 env 로 가리키는 버킷은 들어가고, 아무도 안 쓰는 tfstate 버킷·이름만 비슷한 버킷은 경계 밖 (이름·종류만)", () => {
  const { result } = normalizeV2(inv([
    dep("shop-api", [{ name: "ASSETS_BUCKET", value: "s3://shop-assets/img" }, { name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]),
    bucket("shop-assets"), bucket("acme-terraform-state"), bucket("shop-api-logs"), rds("shop-db")]));
  assert.deepEqual(ids(result), ["shop-api", "shop-assets", "shop-db"]);
  assert.deepEqual(outs(result), ["s3.bucket:acme-terraform-state", "s3.bucket:shop-api-logs"]);
  assert.ok(result.outOfBoundary!.every((o) => o.kind === "objectStore"));
  // 이름만 비슷한 것도 링크·fieldMeta 에 흔적이 없음
  assert.ok(!result.spec.links.some((l) => l.to === "shop-api-logs" || l.to === "acme-terraform-state"));
  assert.ok(!Object.keys(result.fieldMeta).some((k) => /shop-api-logs|acme-terraform-state/.test(k)));
  // 경계 판단 근거 = fieldMeta
  assert.deepEqual(result.fieldMeta["components.shop-assets.boundary"], { source: "boundary:shop-api:env:ASSETS_BUCKET", confidence: 1, needs_review: false });
  assert.equal(result.fieldMeta["components.shop-db.boundary"]?.source, "boundary:shop-api:env:DB_HOST");
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.ok(ImportResultV2.safeParse(result).success);
  // 값은 안 남김: 경계 밖 목록에 ARN·주소 없음
  assert.ok(!JSON.stringify(result.outOfBoundary).includes("arn:"));
});

test("정상: IAM 정책이 가리키는 버킷은 env 가 없어도 경계 안, 경계 안 큐의 DLQ 대상 큐도 따라 들어감", () => {
  const { result } = normalizeV2(inv([
    dep("shop-api", [{ name: "JOBS_QUEUE", value: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/shop-jobs` }]),
    { kind: "aws.iamPolicy", roleName: "shop-api-role", serviceAccount: "shop-api", namespace: NS, source: "pod-identity",
      statements: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::media-store/*"] }] },
    bucket("media-store"), queue("shop-jobs", "shop-jobs-dlq"), queue("shop-jobs-dlq"), queue("other-team-queue")]));
  assert.deepEqual(ids(result), ["media-store", "shop-api", "shop-jobs", "shop-jobs-dlq"]);
  assert.deepEqual(outs(result), ["sqs.queue:other-team-queue"]);
  assert.match(result.fieldMeta["components.media-store.boundary"]!.source, /^boundary:shop-api:iam:shop-api-role/);
  assert.equal(result.fieldMeta["components.shop-jobs-dlq.boundary"]?.source, "boundary:shop-jobs:deadLetter");
});

test("DB 예외(3티어): 근거로 닿은 DB 가 없으면 이름 추측 DB 를 0.6 검토로 둠 / 근거 있는 DB 가 있으면 이름만 비슷한 DB 는 경계 밖", () => {
  const guess = normalizeV2(inv([dep("shop-api", [{ name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "app-conn", key: "url" } } }]), rds("shop-db")])).result;
  assert.deepEqual(ids(guess), ["shop-api", "shop-db"]);
  assert.equal(guess.fieldMeta["components.shop-db.boundary"]?.confidence, 0.6);
  assert.equal(guess.fieldMeta["components.shop-db.boundary"]?.needs_review, true);
  const both = normalizeV2(inv([dep("shop-api", [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]), rds("shop-db"), rds("shop-analytics")])).result;
  assert.deepEqual(ids(both), ["shop-api", "shop-db"]);
  assert.deepEqual(outs(both), ["rds.dbInstance:shop-analytics"]);
  assert.ok(!both.spec.links.some((l) => l.to === "shop-analytics"));
  // 이름 추측은 버킷·큐에는 안 통함
  const b = normalizeV2(inv([dep("shop-api"), bucket("shop-uploads")])).result;
  assert.deepEqual(outs(b), ["s3.bucket:shop-uploads"]);
});

test("거부·경계 판단 불가: 워크로드를 하나도 못 읽으면 데이터 자원을 빼지 않고 전부 0.6 검토 / 계약은 값 칸·모르는 종류를 받지 않음", () => {
  const { result } = normalizeV2(inv([bucket("a-bucket"), queue("q1")]));
  assert.deepEqual(ids(result), ["a-bucket", "q1"]);
  assert.equal(result.outOfBoundary, undefined);
  assert.equal(result.fieldMeta["components.a-bucket.boundary"]?.source, "boundary:no-workload");
  const base = normalizeV2(inv([dep("shop-api"), bucket("x-bucket")])).result;
  assert.ok(ImportResultV2.safeParse(base).success);
  assert.equal(ImportResultV2.safeParse({ ...base, outOfBoundary: [{ resource: "s3.bucket:x", kind: "bucket", reason: "r" }] }).success, false);
  assert.equal(ImportResultV2.safeParse({ ...base, outOfBoundary: [{ resource: "s3.bucket:x", kind: "objectStore", reason: "r", arn: "arn:aws:s3:::x" }] }).success, false);
  // 같은 원본이면 같은 결과 (순서 바꿔도)
  const items = [dep("shop-api", [{ name: "B", value: "s3://keep-me" }]), bucket("zzz"), bucket("keep-me"), bucket("aaa")];
  assert.equal(JSON.stringify(normalizeV2(inv(items)).result), JSON.stringify(normalizeV2(inv([...items].reverse())).result));
});
