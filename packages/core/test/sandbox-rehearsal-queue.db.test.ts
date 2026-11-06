// sandbox-rehearsal 큐: 키가 같으면 실행 중 1건 (policy singleton).
// 회사 번호 없는 옛 키(sandbox-node)는 여러 회사가 줄을 서도, 집는 프로세스가 둘이어도 실행 중은 1건이고, 그 건이 끝나야 다음 회사가 집힌다
// 회사 키(tenant:<번호>)는 다른 회사끼리 같이 돌고, 같은 회사는 1건씩 (동시 상한은 agent-worker localConcurrency)
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
const enqueue = (tenantId: string, perTenant = false) => core.boss.send(Q,
  core.parseJobData(Q, { tenantId, requestId: "r", sandboxRunId: randomUUID() }) as object,
  { singletonKey: core.jobKey(Q, perTenant ? { tenantId } : {}) });

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

test("회사 키: 다른 회사 두 건은 같이 집히고, 같은 회사 두 번째 건은 앞 건이 끝나야 집힌다", { skip }, async () => {
  assert.equal(core.jobKey(Q, { tenantId: "t-1" }), "sandbox-rehearsal:tenant:t-1");
  assert.equal(core.jobKey(Q, {}), "sandbox-rehearsal:sandbox-node", "회사 번호 없는 옛 작업은 예전 키");
  const t1 = randomUUID(), t2 = randomUUID();
  const a1 = await enqueue(t1, true), a2 = await enqueue(t1, true), b = await enqueue(t2, true);
  assert.ok(a1 && a2 && b, "줄 서기는 막지 않는다");

  const first = await core.boss.fetch(Q, { batchSize: 1 });
  assert.equal(first.length, 1);
  const second = await other.fetch(Q, { batchSize: 5 });
  assert.equal(second.length, 1, "다른 프로세스는 다른 회사 건 1건만 집는다 (같은 회사 두 번째 건은 막힘)");
  const running = [first[0]!, second[0]!];
  const tenantOf = (j: { data: unknown }) => (j.data as { tenantId: string }).tenantId;
  assert.deepEqual(new Set(running.map(tenantOf)), new Set([t1, t2]), "도는 두 건은 서로 다른 회사");
  assert.deepEqual(await core.boss.fetch(Q, { batchSize: 5 }), [], "같은 회사 두 번째 건은 앞 건이 끝날 때까지 못 집는다");

  const t1Job = running.find((j) => tenantOf(j) === t1)!, t2Job = running.find((j) => tenantOf(j) === t2)!;
  await (t1Job === first[0] ? core.boss : other).complete(Q, t1Job.id);
  const third = await other.fetch(Q, { batchSize: 5 });
  assert.equal(third.length, 1, "앞 건이 끝나면 같은 회사 남은 건");
  assert.equal(third[0]!.id, t1Job.id === a1 ? a2 : a1);
  await other.complete(Q, third[0]!.id);
  await (t2Job === first[0] ? core.boss : other).complete(Q, t2Job.id);
});
