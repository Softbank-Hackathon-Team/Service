// BOUNDPULL: 경계 밖 데이터 자원을 사람이 끌어오기(applyInclude) + 재가져오기 때 유지. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2, applyInclude, IncludeError, carryHumanEdits } from "../src/index.js";

type Raw = Record<string, any>;
const NS = "shop";
const D = "sha256:" + "ab".repeat(32);
const ACC = "000000000000";
const inv = (items: Raw[]): RawInventory => ({ provider: "aws", coverage: {}, items });
const P = "app.kubernetes.io/part-of", N = "app.kubernetes.io/name";
const dep = (name: string, labels: Record<string, string> = {}, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name, ...labels } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const cron = (name: string, labels: Record<string, string>, env: Raw[] = []): Raw => ({ kind: "k8s.cronjob", imageDigest: D, metadata: { name, namespace: NS, labels },
  spec: { schedule: "0 3 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, env }] } } } } } });
const bucket = (name: string): Raw => ({ kind: "s3.bucket", Name: name, Arn: `arn:aws:s3:::${name}` });
const queue = (name: string, dlq?: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/${name}`,
  Attributes: { QueueArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${name}`, ...(dlq ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${dlq}`, maxReceiveCount: 3 }) } : {}) } });
const rds = (id: string): Raw => ({ kind: "rds.dbInstance", DBInstanceIdentifier: id, Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20,
  Endpoint: { Address: `${id}.abc.ap-northeast-2.rds.amazonaws.com` }, DBInstanceArn: `arn:aws:rds:ap-northeast-2:${ACC}:db:${id}` });
const ids = (r: ImportResultV2) => r.spec.components.map((c) => c.id).sort();
const outs = (r: ImportResultV2) => (r.outOfBoundary ?? []).map((o) => o.resource);
const items = (): Raw[] => [dep("shop-api", { [P]: "shop" }), dep("blog-api", { [P]: "blog" }, []), bucket("shop-uploads"), bucket("acme-tfstate"), rds("analytics-db"), queue("shop-jobs", "shop-jobs-dlq"), queue("shop-jobs-dlq")];
const base = () => normalizeV2(inv(items()), { partOf: "shop" });

test("가져오기가 경계 밖 데이터 자원의 재료(boundaryPool)를 남긴다 — 키 = outOfBoundary.resource, 워크로드(blog-api)는 없다", () => {
  const { result } = base();
  assert.deepEqual(outs(result), ["k8s.deployment:blog-api", "rds.dbInstance:analytics-db", "s3.bucket:acme-tfstate", "s3.bucket:shop-uploads", "sqs.queue:shop-jobs", "sqs.queue:shop-jobs-dlq"].sort().filter(() => true));
  const pool = result.boundaryPool!;
  assert.ok(!("k8s.deployment:blog-api" in pool));
  assert.deepEqual(Object.keys(pool).sort(), ["rds.dbInstance:analytics-db", "s3.bucket:acme-tfstate", "s3.bucket:shop-uploads", "sqs.queue:shop-jobs", "sqs.queue:shop-jobs-dlq"]);
  assert.equal(pool["rds.dbInstance:analytics-db"]!.nativeType, "rds.dbInstance");
  assert.ok(Object.keys(pool["s3.bucket:shop-uploads"]!.fieldMeta).every((k) => k.startsWith("components.shop-uploads.")));
  assert.ok(ImportResultV2.safeParse(result).success);
});

test("끌어오기 정상: 구성요소·fieldMeta 가 들어가고 경계 밖 목록·풀에서 빠지며 included 에 기록, boundary 표시는 human·검토 필요", () => {
  const { result } = base();
  const out = applyInclude(result, ["s3.bucket:shop-uploads", "rds.dbInstance:analytics-db"]);
  assert.deepEqual(ids(out.result), ["analytics-db", "shop-api", "shop-uploads"]);
  assert.ok(!outs(out.result).includes("s3.bucket:shop-uploads") && !outs(out.result).includes("rds.dbInstance:analytics-db"));
  assert.ok(!("s3.bucket:shop-uploads" in (out.result.boundaryPool ?? {})));
  assert.deepEqual(out.result.included, ["rds.dbInstance:analytics-db", "s3.bucket:shop-uploads"]);
  const b = out.result.fieldMeta["components.shop-uploads.boundary"]!;
  assert.equal(b.source, "human"); assert.equal(b.needs_review, true); assert.equal(b.confidence, 1);
  assert.deepEqual(out.postgres, { "analytics-db": { nativeType: "rds.dbInstance" } });
  assert.deepEqual(checkV2(out.result.spec).errors, []);
  assert.ok(ImportResultV2.safeParse(out.result).success);
  // 입력은 안 바뀐다
  assert.ok(!ids(result).includes("shop-uploads"));
});

test("거부: 없는 이름 → not_found, 이미 끌어온 이름 → already, 워크로드(blog-api)·풀 없는 옛 판 → unavailable, 하나라도 실패하면 아무것도 안 바뀐다", () => {
  const { result } = base();
  const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof IncludeError ? e.failure : "other"; } return "no-throw"; };
  assert.equal(code(() => applyInclude(result, ["s3.bucket:nope"])), "not_found");
  assert.equal(code(() => applyInclude(result, ["k8s.deployment:blog-api"])), "unavailable");
  const once = applyInclude(result, ["s3.bucket:shop-uploads"]).result;
  assert.equal(code(() => applyInclude(once, ["s3.bucket:shop-uploads"])), "already");
  const legacy = structuredClone(result); delete legacy.boundaryPool;
  assert.equal(code(() => applyInclude(legacy, ["s3.bucket:shop-uploads"])), "unavailable");
  // 섞어 보내면(하나 좋음 + 하나 나쁨) 통째로 거부
  assert.equal(code(() => applyInclude(result, ["s3.bucket:shop-uploads", "s3.bucket:nope"])), "not_found");
  // 앞 판이 안 바뀜
  assert.ok(outs(result).includes("s3.bucket:shop-uploads"));
});

test("같은 이름을 한 요청에 두 번 써도 한 번만 끌어온다(중복 제거) / 빈 목록은 아무것도 안 함", () => {
  const { result } = base();
  const o = applyInclude(result, ["s3.bucket:shop-uploads", "s3.bucket:shop-uploads"]);
  assert.equal(o.added.length, 1);
  assert.equal(ids(applyInclude(result, []).result).length, ids(result).length);
});

test("재가져오기 유지(lenient): 같은 원본을 다시 정규화한 뒤 앞 판의 included 를 적용하면 같은 구성요소가 같은 id 로 다시 들어온다", () => {
  const first = applyInclude(base().result, ["s3.bucket:shop-uploads", "rds.dbInstance:analytics-db"]).result;
  const again = normalizeV2(inv(items()), { partOf: "shop", previousIds: first.ids });
  const kept = applyInclude(again.result, first.included!, { lenient: true }).result;
  assert.deepEqual(ids(kept), ids(first));
  assert.deepEqual(kept.included, first.included);
  assert.deepEqual(kept.spec.components, first.spec.components);
  // 사람이 손댄 칸은 carry 가 그대로 이어준다
  const edited = structuredClone(first);
  const c = edited.spec.components.find((x) => x.id === "shop-uploads")!;
  (c.props as Record<string, unknown>).versioning = true;
  edited.fieldMeta["components.shop-uploads.versioning"] = { source: "human", confidence: 1, needs_review: false };
  const carried = carryHumanEdits(kept, [{ spec: edited.spec, fieldMeta: edited.fieldMeta }, { spec: first.spec, fieldMeta: first.fieldMeta }]);
  assert.ok(!carried.report.flagged.some((f) => f.endsWith(".boundary")), "boundary 표시가 값 바뀜으로 잡히면 안 된다");
  const carriedR = carried.result;
  assert.equal((carriedR.spec.components.find((x) => x.id === "shop-uploads")!.props as Record<string, unknown>).versioning, true);
});

test("재가져오기 lenient: 원본에서 사라졌거나 이미 근거로 안에 들어온 이름은 조용히 넘어간다 (에러 없음, included 에서 빠짐)", () => {
  const first = applyInclude(base().result, ["s3.bucket:shop-uploads"]).result;
  // 원본에서 버킷이 사라짐
  const gone = normalizeV2(inv(items().filter((i) => i.Name !== "shop-uploads")), { partOf: "shop", previousIds: first.ids }).result;
  const a = applyInclude(gone, first.included!, { lenient: true }).result;
  assert.ok(!ids(a).includes("shop-uploads"));
  assert.equal(a.included, undefined);
  // 이제 서비스가 env 로 가리켜 자연스럽게 경계 안
  const natural = normalizeV2(inv([dep("shop-api", { [P]: "shop" }, [{ name: "B", value: "s3://shop-uploads" }]), bucket("shop-uploads")]), { partOf: "shop" }).result;
  const b = applyInclude(natural, ["s3.bucket:shop-uploads"], { lenient: true }).result;
  assert.deepEqual(ids(b), ["shop-api", "shop-uploads"]);
  assert.equal(b.included, undefined);
});
