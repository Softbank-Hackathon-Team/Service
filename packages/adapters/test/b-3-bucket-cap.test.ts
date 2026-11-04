// B-3: 버킷을 이름순 앞 N개만 읽던 것 → 앱이 이름을 적은 버킷은 상한과 상관없이 읽고, 그래도 잘리면 검토 줄
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketsToRead, MAX_BUCKETS, readAwsData } from "../src/discover/data.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { fakeExec } from "./fake-cli.js";

const names = Array.from({ length: MAX_BUCKETS + 5 }, (_, i) => `b-${String(i).padStart(3, "0")}`);

test("B-3: 앱이 env 에 적은 뒤쪽 버킷(zz-uploads)은 상한 밖이어도 읽는다", () => {
  const all = [...names, "zz-uploads"].sort();
  const r = bucketsToRead(all, JSON.stringify([{ env: [{ name: "BUCKET", value: "zz-uploads" }] }]));
  assert.ok(r.read.includes("zz-uploads"));
  assert.equal(r.skipped, 5);
});

test("B-3: 비슷한 이름(zz-uploads-old)은 낱말이 달라 끌려오지 않는다", () => {
  const r = bucketsToRead([...names, "zz-uploads-old"].sort(), JSON.stringify({ v: "s3://zz-uploads/x" }));
  assert.ok(!r.read.includes("zz-uploads-old"));
});

test("B-3: 잘린 버킷이 있으면 check.unread.s3.truncated 검토 줄", async () => {
  const { exec } = fakeExec([
    [/^aws s3api list-buckets/, { out: { Buckets: names.map((Name) => ({ Name })) } }],
    [/^aws s3api /, { code: 254, err: "NoSuchBucketPolicy NoSuchLifecycleConfiguration NoSuchCORSConfiguration NoSuchPublicAccessBlockConfiguration" }],
    [/^aws cloudwatch/, { out: { Datapoints: [] } }],
    [/^aws sqs list-queues/, { out: {} }], [/^aws elasticache/, { out: {} }],
  ]);
  const items = await readAwsData({ exec, env: {} }, "r", [], new Date(), "");
  const r = normalizeV2({ provider: "aws", items, coverage: {} }).result;
  assert.equal(r.fieldMeta["check.unread.s3.truncated"]?.needs_review, true);
  assert.match(r.fieldMeta["check.unread.s3.truncated"]?.rationale ?? "", /5개 안 읽음/);
});
