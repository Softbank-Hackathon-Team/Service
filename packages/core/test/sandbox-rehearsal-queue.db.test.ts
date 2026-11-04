// sandbox-rehearsal 큐: 리허설은 샌드박스 노드에서 한 번에 1건 (전용 노드에 회사 하나씩).
// 여러 회사가 줄을 서도, 집는 프로세스가 둘이어도 실행 중은 1건이고, 그 건이 끝나야 다음 회사가 집힌다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { QUEUES } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let other: PgBoss;   // 두 번째 agent-worker 자리

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  await core.startBoss();
  other = new PgBoss({ connectionString: DB, schema: "pgboss", createSchema: false, migrate: false, supervise: false, schedule: false });
  other.on("error", () => undefined);
  await other.start();
});
after(async () => {
  if (skip) return;
  await other.stop({ graceful: false });
  await core.boss.stop({ graceful: false }); await core.pool.end();
});

const Q = QUEUES.sandboxRehearsal;
const enqueue = (tenantId: string) => core.boss.send(Q,
  core.parseJobData(Q, { tenantId, requestId: "r", sandboxRunId: randomUUID() }) as object,
  { singletonKey: core.jobKey(Q, {}) });

test("동시 1건: 두 회사 작업이 모두 줄을 서고, 두 프로세스가 집어도 실행 중은 1건, 끝나면 다음 건", { skip }, async () => {
  const a = await enqueue(randomUUID()), b = await enqueue(randomUUID());
  assert.ok(a && b, "줄 서기는 막지 않는다 (send 가 null 이 아님)");

  const first = await core.boss.fetch(Q, { batchSize: 5 });
  assert.equal(first.length, 1, "한 번에 여러 건을 달라고 해도 1건");
  assert.deepEqual(await other.fetch(Q, { batchSize: 5 }), [], "다른 프로세스도 실행 중인 건이 있으면 못 집는다");

  await core.boss.complete(Q, first[0]!.id);
  const next = await other.fetch(Q, { batchSize: 5 });
  assert.equal(next.length, 1, "앞 건이 끝나면 다음 회사 건이 집힌다");
  assert.notEqual(next[0]!.id, first[0]!.id);
  assert.deepEqual(new Set([first[0]!.id, next[0]!.id]), new Set([a, b]));
  await other.complete(Q, next[0]!.id);
});
