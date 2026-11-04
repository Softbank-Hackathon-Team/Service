// 관측 모듈 단위 시험 (DB 없음): 지표 텍스트 형식, 누적 칸 변환, 로그 필드, 타임라인
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Registry, toCumulative, createLogger, withLogContext, contextFromJob, buildTimeline, type AuditRow,
} from "../src/index.js";

test("지표: 카운터·게이지·히스토그램이 Prometheus 텍스트 형식으로 나온다", async () => {
  const r = new Registry();
  const c = r.counter("t_total", "help c");
  const g = r.gauge("t_gauge", "help g");
  const h = r.histogram("t_seconds", "help h", [0.1, 1]);
  c.inc({ q: "a" }); c.inc({ q: "a" }, 2);
  g.set({ s: 'x"y' }, 5);
  h.observe({ q: "a" }, 0.05); h.observe({ q: "a" }, 0.5); h.observe({ q: "a" }, 3);
  const out = await r.render();
  assert.match(out, /# TYPE t_total counter\nt_total\{q="a"\} 3/);
  assert.match(out, /t_gauge\{s="x\\"y"\} 5/);                       // 라벨 값 따옴표 이스케이프
  assert.match(out, /t_seconds_bucket\{le="0.1",q="a"\} 1/);
  assert.match(out, /t_seconds_bucket\{le="1",q="a"\} 2/);
  assert.match(out, /t_seconds_bucket\{le="\+Inf",q="a"\} 3/);
  assert.match(out, /t_seconds_sum\{q="a"\} 3.55/);
  assert.match(out, /t_seconds_count\{q="a"\} 3/);
});

test("지표: 수집 함수가 실패해도 render 전에 불린다", async () => {
  const r = new Registry();
  const g = r.gauge("t_g", "h");
  r.onCollect(async () => { g.set({}, 42); });
  assert.match(await r.render(), /t_g 42/);
});

test("width_bucket 결과 → 누적 칸 (칸 i = bucket ≤ i 인 줄 수)", () => {
  // 경계 [1, 5, 10]: 0.5초 2개(bucket 0), 3초 1개(bucket 1), 20초 1개(bucket 3)
  assert.deepEqual(toCumulative([{ bucket: 0, n: 2 }, { bucket: 1, n: 1 }, { bucket: 3, n: 1 }], 3), [2, 3, 3]);
  assert.deepEqual(toCumulative([], 2), [0, 0]);
});

test("로그: 한 줄 JSON, snake_case 문맥 필드가 await 너머까지 붙는다", async () => {
  const lines: string[] = [];
  const log = createLogger("worker", {}, { write: (l) => lines.push(l) });
  const ctx = contextFromJob("sync", "job-1",
    { tenantId: "t-1", migrationId: "m-1", requestId: "req-9", extra: 1 });
  await withLogContext(ctx, async () => {
    await new Promise((r) => setTimeout(r, 1));
    log.info({ prev_state: "syncing", state: "shifting" }, "transition");
  });
  log.warn({ err: new Error("boom") }, "outside");
  assert.equal(contextFromJob("sandbox-rehearsal", "job-2", { tenantId: "t-1", requestId: "r", sandboxRunId: "sr-1" }).sandbox_run_id, "sr-1");
  const a = JSON.parse(lines[0]!);
  assert.equal(a.level, "info"); assert.equal(a.service, "worker"); assert.equal(a.msg, "transition");
  assert.equal(a.tenant_id, "t-1"); assert.equal(a.migration_id, "m-1");
  assert.equal(a.job_id, "job-1"); assert.equal(a.queue, "sync"); assert.equal(a.request_id, "req-9");
  assert.equal(a.state, "shifting");
  assert.match(a.time, /^\d{4}-\d\d-\d\dT.*Z$/);
  const b = JSON.parse(lines[1]!);
  assert.equal(b.tenant_id, undefined);                               // 문맥 밖이면 안 붙는다
  assert.deepEqual(b.err, { type: "Error", message: "boom" });         // Error 가 {} 로 사라지지 않는다
});

test("로그: level 아래는 안 찍힌다", () => {
  const lines: string[] = [];
  const log = createLogger("x", {}, { level: "warn", write: (l) => lines.push(l) });
  log.info("no"); log.error("yes");
  assert.equal(lines.length, 1);
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 1, 0, s)).toISOString();
const rows: AuditRow[] = [
  { seq: "12", at: at(3), actor: "worker", action: "import.spec_review", result: "ok",
    detail: { from: "importing", to: "spec_review", requestId: "req-1" } },
  { seq: "10", at: at(0), actor: "user:dev", action: "migration.importing", result: "ok",
    detail: { from: "draft", to: "importing", requestId: "req-1" } },
  { seq: "13", at: at(4), actor: "worker", action: "job.rejected", result: "denied", detail: { job: "import" } },
  { seq: "14", at: at(10), actor: "worker", action: "cutover.rollback_window", result: "ok",
    detail: { from: "spec_review", to: "rollback_window",
      measurements: [{ name: "cutover_pause_ms", value: 850, unit: "ms", env: "target" }, { bad: 1 }] } },
];

test("타임라인: seq 순 정렬, durationMs = from 상태에 머문 ms, 첫 전이는 null", () => {
  const t = buildTimeline(rows, { id: "m-1", status: "completed", createdAt: at(0) }, new Date(at(60)));
  assert.deepEqual(t.items.map((i) => i.seq), [10, 12, 13, 14]);
  assert.deepEqual(t.items.map((i) => i.durationMs), [null, 3000, null, 7000]);
  assert.deepEqual(t.items.map((i) => i.kind), ["transition", "transition", "event", "transition"]);
  assert.equal(t.items[0]!.requestId, "req-1");
  assert.deepEqual(t.items[3]!.measurements.map((m) => m.name), ["cutover_pause_ms"]);   // 모양이 틀린 측정값은 뺀다
  assert.equal(t.items[2]!.detail.job, "import");
  assert.equal(t.items[0]!.detail.from, undefined);                    // 위로 뺀 칸은 detail 에서 덜어 낸다
  assert.equal(t.totalMs, 10_000);                                      // 끝난 이전 = 첫 전이 ~ 마지막 전이
  assert.equal(t.running, false);
  assert.deepEqual(t.stateDurations, [
    { state: "importing", ms: 3000, entries: 1 }, { state: "spec_review", ms: 7000, entries: 1 }]);
});

test("타임라인: 진행 중이면 totalMs 는 지금까지", () => {
  const t = buildTimeline(rows.slice(0, 2), { id: "m-1", status: "spec_review", createdAt: at(0) }, new Date(at(30)));
  assert.equal(t.running, true);
  assert.equal(t.totalMs, 30_000);
});

test("타임라인: 감사 줄이 없으면 빈 목록과 null", () => {
  const t = buildTimeline([], { id: "m-1", status: "draft", createdAt: at(0) });
  assert.equal(t.items.length, 0);
  assert.equal(t.totalMs, null);
});
