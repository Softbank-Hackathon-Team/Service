// 증적 리포트: 체인 검증·리포트 조립·그리기·경로. DB 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { canonical, sha256, NotFound } from "@svc/core";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { reportRoutes } from "../src/routes/report.js";
import { verifyAuditChain } from "../src/report/chain.js";
import { buildEvidenceReport, type ReportInput } from "../src/report/build.js";
import { renderHtml, renderMarkdown } from "../src/report/render.js";
import { EvidenceReport, type AuditRow } from "../src/report/schema.js";

const T = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const S_ENV = "44444444-4444-4444-8444-444444444444";
const T_ENV = "55555555-5555-4555-8555-555555555555";

type In = { actor: string; action: string; result?: "ok" | "denied" | "error";
  detail?: Record<string, unknown>; at: string; target?: string };

// core/audit.ts writeAudit과 같은 방식으로 체인을 만든다 (detail이 없으면 지문에서 빼고 표에는 {})
function chainOf(xs: In[]): AuditRow[] {
  let prev = "genesis";
  return xs.map((x, i) => {
    const a = { actor: x.actor, action: x.action, target: x.target ?? M, result: x.result ?? "ok",
      ...(x.detail ? { detail: x.detail } : {}) };
    const hash = sha256(canonical({ ...a, tenantId: T, prevHash: prev }));
    const row: AuditRow = { seq: i + 1, tenantId: T, at: x.at, actor: a.actor, action: a.action,
      target: a.target, result: a.result, detail: x.detail ?? {}, prevHash: prev, hash };
    prev = hash;
    return row;
  });
}

const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 3, 0, s)).toISOString();
const mv = (from: string, to: string, s: number, extra: Record<string, unknown> = {}, actor = "worker") =>
  ({ actor, action: `x.${to}`, at: at(s), detail: { from, to, ...extra } });
const meas = (name: string, value: number) =>
  ({ migrationId: M, name, value, unit: "ms", env: "gcp", at: at(40) });
const judge = (stepPct: number, verdict = "ok") => ({ migrationId: M, stepPct, samples: 120, target5xx: 0,
  targetErrorRatePct: 0.2, sourceErrorRatePct: 0.1, targetP95Ms: 85, sourceP95Ms: 70, verdict, at: at(30) });

function happy(): AuditRow[] {
  return chainOf([
    mv("draft", "importing", 0, {}, "user:dev"),
    { actor: "worker", action: "job.rejected", result: "denied", at: at(1), detail: { job: "import" } },
    mv("importing", "spec_review", 2),
    mv("prechecking", "planning", 5, { precheck: [{ id: "PC-01", level: "warn", message: "<b>RDS</b> 백업 꺼짐" }] }),
    mv("planning", "awaiting_approval", 6, { planId: P, planHash: "h1" }),
    mv("awaiting_approval", "approved", 9, {}, "user:dev"),
    mv("deploying", "syncing", 20, { deploy: { bundleHash: "b", status: "synced_healthy", resources: [] } }),
    mv("syncing", "shifting", 25, { measurements: [meas("replication_lag_ms", 12.5)] }),
    mv("shifting", "cutover", 35, { judgements: [judge(10), judge(50), judge(100)] }),
    mv("cutover", "rollback_window", 36, { measurements: [meas("cutover_pause_ms", 62)] }),
    { actor: "worker", action: "other", at: at(37), target: "env-x" }, // 다른 대상 줄 (detail 없음)
  ]);
}

function input(rows = happy(), extra: Partial<ReportInput> = {}): ReportInput {
  return {
    migration: { id: M, status: "rollback_window", failureCode: null,
      source: { id: S_ENV, provider: "aws", name: "prod-aws" },
      target: { id: T_ENV, provider: "gcp", name: "prod-gcp" } },
    events: rows.filter((r) => r.target === M),
    chain: rows, chainFromGenesis: true,
    plans: [{ planId: P, planHash: "h1" }],
    approvals: [{ planId: P, decision: "approve", approvedBy: "user:dev", planHash: "h1", at: at(9) }],
    now: () => new Date("2026-11-07T04:00:00Z"),
    ...extra,
  };
}

test("감사 체인: writeAudit 방식으로 만든 줄은 전부 통과 (detail 없는 줄 포함)", () => {
  const c = verifyAuditChain(happy());
  assert.equal(c.ok, true);
  assert.equal(c.checked, 11);
  assert.equal(c.partial, false);
});

test("감사 체인: detail 한 글자만 바꿔도 그 seq에서 hash_mismatch", () => {
  const rows = happy();
  rows[9]!.detail = { ...rows[9]!.detail, measurements: [meas("cutover_pause_ms", 6)] };
  const c = verifyAuditChain(rows);
  assert.equal(c.ok, false);
  assert.equal(c.reason, "hash_mismatch");
  assert.equal(c.brokenAtSeq, 10);
  assert.equal(c.checked, 9);
});

test("감사 체인: 중간 줄을 지우면 prev_link_broken, 앞을 잘라도 genesis가 아니면 실패", () => {
  const rows = happy();
  const cut = [...rows.slice(0, 3), ...rows.slice(4)];
  assert.equal(verifyAuditChain(cut).reason, "prev_link_broken");
  assert.equal(verifyAuditChain(rows.slice(2)).reason, "not_from_genesis");
  // 앞부분을 일부러 안 읽은 경우는 첫 줄 prevHash를 믿고 partial로 표시
  const p = verifyAuditChain(rows.slice(2), false);
  assert.equal(p.ok, true);
  assert.equal(p.partial, true);
});

test("리포트: 시간표·측정값·트래픽·승인·거부 줄을 감사에서 모은다", () => {
  const r = buildEvidenceReport(input());
  assert.equal(EvidenceReport.safeParse(r).success, true);
  assert.equal(r.summary.transitions, 9);
  assert.equal(r.summary.totalMs, 36000);
  assert.equal(r.summary.reachedCutover, true);
  assert.equal(r.summary.rolledBack, false);
  assert.deepEqual(r.timeline.map((t) => t.durationMs).slice(0, 4), [null, 2000, 3000, 1000]);
  assert.deepEqual(r.measurements.map((m) => [m.name, m.value]),
    [["replication_lag_ms", 12.5], ["cutover_pause_ms", 62]]);
  assert.deepEqual(r.traffic, { judgements: 3, steps: [10, 50, 100], bad: 0,
    maxTargetErrorRatePct: 0.2, maxTargetP95Ms: 85 });
  assert.equal(r.approvals[0]!.hashMatches, true);
  assert.equal(r.deploy?.status, "synced_healthy");
  assert.equal(r.precheck[0]!.id, "PC-01");
  assert.deepEqual(r.incidents.map((i) => [i.seq, i.note]), [[2, "import"]]);
  assert.equal(r.integrity.ok, true);
  assert.deepEqual(r.gaps, ["비용 추정 없음"]);
});

test("리포트: 승인 지문이 저장 계획서와 다르면 불일치로 드러난다", () => {
  const r = buildEvidenceReport(input(happy(), { plans: [{ planId: P, planHash: "h2" }] }));
  assert.equal(r.approvals[0]!.hashMatches, false);
  assert.equal(r.approvals[0]!.storedPlanHash, "h2");
});

test("리포트: 기록이 비면 비어 있는 것을 숨기지 않고 gaps에 적는다", () => {
  const rows = chainOf([mv("draft", "importing", 0, {}, "user:dev")]);
  const r = buildEvidenceReport(input(rows, { approvals: [], plans: [] }));
  assert.ok(r.gaps.includes("승인 기록 없음"));
  assert.ok(r.gaps.includes("컷오버 멈춤 시간(cutover_pause_ms) 측정 없음"));
  assert.ok(r.gaps.includes("트래픽 판정 기록 없음"));
  assert.equal(r.traffic, null);
});

test("리포트 지문: 생성 시각이 달라도 같고, 기록이 바뀌면 달라진다", () => {
  const a = buildEvidenceReport(input());
  const b = buildEvidenceReport(input(happy(), { now: () => new Date("2030-01-01T00:00:00Z") }));
  assert.equal(a.reportHash, b.reportHash);
  const c = buildEvidenceReport(input(happy(), { approvals: [] }));
  assert.notEqual(a.reportHash, c.reportHash);
});

test("그리기: Markdown에 핵심 숫자, HTML은 감사 detail 속 태그를 이스케이프", () => {
  const r = buildEvidenceReport(input());
  const md = renderMarkdown(r);
  assert.match(md, /\| cutover_pause_ms \| 62 \| ms \|/);
  assert.match(md, /aws\(prod-aws\) → gcp\(prod-gcp\)/);
  assert.match(md, /감사 기록 무결성: 통과/);
  const html = renderHtml(r);
  assert.match(html, /62 ms/);
  assert.ok(!html.includes("<b>RDS</b>"));
  assert.ok(html.includes("&lt;b&gt;RDS&lt;/b&gt;"));
});

async function appWith(load: (t: string, id: string) => Promise<ReportInput>) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(reportRoutes, { prefix: "/api/v1", load });
  return app;
}
const H = { "x-dev-tenant": T };

test("경로: json·md·html 세 형식, 지문 헤더, 회사 번호를 읽기 함수에 넘긴다", async () => {
  let seen = "";
  const app = await appWith(async (t) => { seen = t; return input(); });
  const j = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/report`, headers: H });
  assert.equal(j.statusCode, 200);
  assert.equal(seen, T);
  const body = EvidenceReport.parse(j.json());
  assert.equal(j.headers["x-report-hash"], body.reportHash);
  const md = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/report?format=md`, headers: H });
  assert.match(String(md.headers["content-type"]), /text\/markdown/);
  assert.match(md.body, /# 이전 증적 리포트/);
  const html = await app.inject({ method: "GET", url: `/api/v1/migrations/${M}/report?format=html`, headers: H });
  assert.match(String(html.headers["content-type"]), /text\/html/);
  assert.match(String(html.headers["content-security-policy"]), /default-src 'none'/);
  await app.close();
});

test("경로 거부: 헤더 없음 401, 잘못된 번호·형식 400, 없는(남의) 이전 404", async () => {
  const app = await appWith(async (_t, id) => { throw new NotFound("migration", id); });
  const u = `/api/v1/migrations/${M}/report`;
  assert.equal((await app.inject({ method: "GET", url: u })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/migrations/nope/report", headers: H })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `${u}?format=pdf`, headers: H })).statusCode, 400);
  const nf = await app.inject({ method: "GET", url: u, headers: H });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().code, "NOT_FOUND");
  await app.close();
});
