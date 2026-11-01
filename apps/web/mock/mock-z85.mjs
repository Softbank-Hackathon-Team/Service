// Z85: 비용·모니터링·보안감사 페이지용 가짜 경로 (mock-api.mjs 가 부른다). 모양은 통합본 API 와 같다
//   POST /cost/estimate        — cost-fixture 를 피크 rps 에 맞춰 늘린 값 (실제 계산기 아님)
//   GET  /migrations/:id/report   — EvidenceReport 중 화면이 쓰는 칸
//   GET  /migrations/:id/security — SecurityView (행 몇 개 + 통제 표 4줄)
//   POST /migrations/:id/agent-review/run — 202 RunAccepted
//   GET  /migrations/:id/security/regression — Z95 SecurityRegression (실패 = 회귀, 완료 = 회귀 없음, 그 밖 = unavailable)
//   MOCK_SEED=1 이면 완료·실패·일시정지·승인 대기 이전 4건을 미리 넣는다
import { randomUUID, createHash } from "node:crypto";

const r1 = (x) => Math.round(x * 10) / 10;
const ENVS = ["aws", "gcp", "onprem", "azure_mock"];

export function seed(migrations, envs, logMove) {
  if (process.env.MOCK_SEED !== "1") return;
  const [aws, gcp, az] = envs;
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const rows = [
    { status: "completed", s: aws, t: gcp, upd: 95 },
    { status: "failed", s: gcp, t: aws, upd: 12, failedAtStatus: "syncing", failureCode: "REPL_LAG_EXCEEDED" },
    { status: "paused", s: aws, t: az, upd: 4, pausedFrom: "shifting" },
    { status: "awaiting_approval", s: gcp, t: az, upd: 1 },
  ];
  for (const x of rows) {
    const m = { id: randomUUID(), status: x.status, version: 9, sourceEnvId: x.s.id, targetEnvId: x.t.id, updatedAt: ago(x.upd),
      failedAtStatus: x.failedAtStatus ?? null, failureCode: x.failureCode ?? null, pausedFrom: x.pausedFrom ?? null };
    migrations.set(m.id, m); logMove(m, null, "draft"); logMove(m, "draft", x.status);
  }
}

export function handle(req, p, body, { migrations, envs, cost, send, err }) {
  let r;
  if (p === "/cost/estimate" && req.method === "POST") {
    const rps = Number(body?.traffic?.peakRps ?? 10);
    const k = Math.max(1, 1 + (rps - 10) / 120);
    const credit = body?.applyCredits !== false;
    const fin = body?.profile === "finance" ? 1.25 : 1;
    const est = structuredClone(cost.estimate);
    est.peakRps = rps; est.requiredVcpu = r1(0.5 + 0.01 * rps); est.profile = body?.profile ?? "startup";
    for (const e of est.envs) {
      if (e.provider === "onprem" && rps > 1500) { e.feasible = false; e.reason = "ONPREM_CAPACITY_EXCEEDED"; e.monthlyUsd = null; continue; }
      const scale = (v) => r1(v * (e.provider === "onprem" ? 1 : k) * fin);
      e.parts = { cluster: scale(e.parts.cluster), nodes: scale(e.parts.nodes), db: scale(e.parts.db), storage: e.parts.storage, fixed: e.parts.fixed };
      e.monthlyUsdNoCredit = r1(e.parts.cluster + e.parts.nodes + e.parts.db + e.parts.storage + e.parts.fixed + e.creditUsd);
      e.monthlyUsd = r1(e.monthlyUsdNoCredit - (credit ? e.creditUsd : 0));
    }
    const ok = est.envs.filter((e) => e.monthlyUsd !== null).sort((a, b) => a.monthlyUsd - b.monthlyUsd);
    est.cheapest = ok[0]?.provider ?? null;
    const from = body?.from && ENVS.includes(body.from) ? body.from : null;
    const fe = est.envs.find((e) => e.provider === from);
    est.savings = from && fe?.monthlyUsd != null && est.cheapest && est.cheapest !== from
      ? { from, to: est.cheapest, monthlyUsd: r1(fe.monthlyUsd - ok[0].monthlyUsd), creditPortionUsd: 0 } : null;
    est.recommendations = ok.map((e, i) => ({ rank: i + 1, provider: e.provider, security: body?.profile === "finance" ? "hardened" : "basic",
      monthlyUsd: e.monthlyUsd, score: r1((0.4 + i * 0.05) * 1000) / 1000, scoreParts: { cost: 0.25 + i * 0.03, risk: 0.09, time: 0.125 } }));
    return send(res(req), 200, est), true;
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/agent-review\/run$/)) && req.method === "POST") {
    const m = migrations.get(r[1]);
    if (!m) return err(res(req), 404, "NOT_FOUND", "migration " + r[1]), true;
    return send(res(req), 202, { runId: randomUUID(), migrationId: m.id, kind: "remediate", status: "queued" }), true;
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/report$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    if (!m) return err(res(req), 404, "NOT_FOUND", "migration " + r[1]), true;
    const env = (id) => { const e = envs.find((x) => x.id === id); return { id: e.id, provider: e.provider, name: e.name }; };
    const h = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");
    const failed = m.status === "failed";
    const approved = !["draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval"].includes(m.status);
    const ph = h(m.id + "plan");
    return send(res(req), 200, {
      reportVersion: 1, generatedAt: new Date().toISOString(),
      migration: { id: m.id, status: m.status, source: env(m.sourceEnvId), target: env(m.targetEnvId), failureCode: m.failureCode ?? null },
      summary: { startedAt: m.updatedAt, endedAt: m.status === "completed" ? m.updatedAt : null, totalMs: m.status === "completed" ? 41230 : null,
        transitions: m.version, reachedCutover: m.status === "completed", rolledBack: false, deniedOrError: failed ? 2 : 0 },
      integrity: { ok: true, checked: 12 + m.version * 2, firstSeq: 1, lastSeq: 12 + m.version * 2, brokenAtSeq: null, reason: null, partial: false },
      timeline: [], precheck: [], measurements: m.status === "completed" || m.status === "failed" ? [
        { migrationId: m.id, name: "initial_copy_ms", value: 550, unit: "ms", env: "target", at: m.updatedAt },
        { migrationId: m.id, name: "replication_lag_ms", value: m.status === "failed" ? 31000 : 26, unit: "ms", env: "target", at: m.updatedAt },
        ...(m.status === "completed" ? [{ migrationId: m.id, name: "cutover_pause_ms", value: 310, unit: "ms", env: "target", at: m.updatedAt }] : []),
      ] : [], traffic: null, deploy: null, cost: null,
      approvals: approved ? [{ planId: randomUUID(), decision: "approve", approvedBy: "dev-user", at: m.updatedAt, approvedPlanHash: ph, storedPlanHash: ph, hashMatches: true }] : [],
      incidents: failed ? [
        { seq: 17, at: m.updatedAt, actor: "worker", action: "sync.lag_check", result: "error", note: "복제 지연 31초 > 기준 5초 (3회 연속)" },
        { seq: 19, at: m.updatedAt, actor: "api", action: "migration.start", result: "denied", note: "다른 이전이 도착 환경을 잠금" },
      ] : [],
      gaps: m.status === "completed" ? [] : ["트래픽 판정 기록 없음 (전환 단계 전)", "배포 결과 없음"],
      reportHash: h(m.id + m.status),
    }), true;
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/security\/regression$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    if (!m) return err(res(req), 404, "NOT_FOUND", "migration " + r[1]), true;
    const env = (id) => envs.find((x) => x.id === id);
    const head = (side, e) => ({ side, provider: e.provider, envId: e.id, checkedAt: m.updatedAt, origin: "live" });
    const it = (key, category, title, before, after, change, be, ae) => ({ key, category, title, before, after, change, beforeEvidence: be, afterEvidence: ae });
    const base = { regressionVersion: 1, migrationId: m.id, generatedAt: new Date().toISOString(), recorded: m.status === "completed" };
    if (m.status !== "failed" && m.status !== "completed")
      return send(res(req), 200, { ...base, verdict: "unavailable", summary: { worse: 0, better: 0, same: 0, unknown: 0 }, source: null, target: null, items: [] }), true;
    const items = m.status === "failed" ? [
      it("net.default_deny", "network", "네트워크 정책 기본 거부", "pass", "fail", "worse", "NetworkPolicy default-deny 있음", "NetworkPolicy 없음"),
      it("db.tls", "database", "DB 연결 TLS", "pass", "pass", "same", "TLS1.3", "TLS1.3"),
      it("iam.wildcard", "iam", "역할 권한 와일드카드 없음", "warn", "pass", "better", "s3:* 1개", "0개"),
      it("secrets.plain", "secrets", "평문 비밀값 없음", "pass", "unavailable", "unknown", "0건", null),
    ] : [
      it("net.default_deny", "network", "네트워크 정책 기본 거부", "pass", "pass", "same", "있음", "있음"),
      it("db.tls", "database", "DB 연결 TLS", "warn", "pass", "better", "TLS1.2", "TLS1.3"),
    ];
    const n = (c) => items.filter((x) => x.change === c).length;
    return send(res(req), 200, { ...base, verdict: n("worse") ? "regressed" : "no_regression",
      summary: { worse: n("worse"), better: n("better"), same: n("same"), unknown: n("unknown") },
      source: head("source", env(m.sourceEnvId)), target: head("target", env(m.targetEnvId)), items }), true;
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/security$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    if (!m) return err(res(req), 404, "NOT_FOUND", "migration " + r[1]), true;
    const row = (id, area, item, state, value) => ({ id, area, item, scope: "target", state, value, source: "mock", ref: null });
    return send(res(req), 200, {
      viewVersion: 1, generatedAt: new Date().toISOString(), migration: { id: m.id, status: m.status },
      summary: { ok: 4, warn: 1, fail: 0, notImplemented: 1, na: 0 },
      rows: [
        row("SEC-CRED-01", "temp_credentials", "임시 자격 10분 재발급", "ok", "TTL 600초"),
        row("SEC-IAM-03", "least_privilege", "도착 역할 최소 권한", "warn", "와일드카드 1개"),
        row("SEC-AUD-01", "audit", "감사 해시 사슬", "ok", "온전"),
        row("SEC-SEC-01", "secrets", "비밀값 평문 없음", "ok", "0건"),
        row("SEC-RT-01", "runtime", "컨테이너 비루트 실행", "ok", "runAsNonRoot"),
        row("SEC-CTL-09", "controls", "네트워크 정책 기본 거부", "not_implemented", "—"),
      ],
      ledger: null, auditChain: { ok: true, checked: 12 + m.version * 2, brokenAtSeq: null, reason: null, partial: false },
      tempRoleAudit: { issued: 3, revoked: 3 }, controlMatrix: null,
    }), true;
  }
  return false;
}
// mock-api.mjs 의 send/err 는 (res, …) 를 받는다. 여기서는 req 에 res 를 붙여 넘긴다
const res = (req) => req._res;
