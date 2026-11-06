// 사전 점검: AWS 도착 사실(실자원 읽기 targetFacts)이 아직이면 승인 전에 막는다 (apply 의 TARGET_FACTS_UNAVAILABLE 를 앞당김),
//   중계기 짝이 아니고 끝점도 없으면 PC-REPL-CONN 이 빠진 끝점 두 줄과 고칠 길을 이름으로 알린다. DB·클라우드는 안 부른다
import { test } from "node:test";
import assert from "node:assert/strict";
import { awsTargetFactsPrecheck, replSourcePrecheck } from "../src/jobs/precheck.js";

const T = "11111111-1111-4111-8111-111111111111";

test("사전 점검 (도착 AWS 사실): TF_FACT_* 가 없고 실자원 읽기가 아직이면 block + '도착 환경 화면을 한 번 연다', 있으면 VPC 를 넘긴다", async () => {
  const notRead = await awsTargetFactsPrecheck(T, "t", {}, async () => ({ ok: false, reason: "도착 EKS 를 아직 읽지 않았다" }));
  assert.deepEqual(notRead.items.map((i) => `${i.id}:${i.level}`), ["PC-AWS-TARGET-FACTS:block"]);
  assert.match(notRead.items[0]!.message, /빠진 것: inventory\.targetFacts/);
  assert.match(notRead.items[0]!.fix!, /도착 환경 화면을 한 번 열어/);
  assert.deepEqual(await awsTargetFactsPrecheck(T, "t", {}, async () => ({ ok: true, facts: { vpcId: "vpc-0a1", clusterName: "c" } })), { items: [], vpcId: "vpc-0a1" });
  let read = 0;
  assert.deepEqual(await awsTargetFactsPrecheck(T, "t", { TF_FACT_VPC_ID: "vpc-0env" }, async () => { read++; return { ok: false, reason: "x" }; }), { items: [], vpcId: "vpc-0env" });
  assert.equal(read, 0, "worker env 사실이 있으면 실자원 읽기를 안 본다");
});

test("사전 점검 (끝점 없음): 중계기 짝이 아니고 줄·REPL_* env 도 없으면 block + 빠진 끝점 두 줄·repl:endpoint·DB_PUBLIC 안내", async () => {
  const [i] = await replSourcePrecheck({}, { required: true, relayDeferred: false });
  assert.deepEqual([i!.id, i!.level], ["PC-REPL-CONN", "block"]);
  assert.match(i!.message, /빠진 것: replication_endpoints\(source\), replication_endpoints\(target\)/);
  assert.match(i!.fix!, /npm run repl:endpoint -- set/);
  assert.match(i!.fix!, /DB_PUBLIC=1/);
});
