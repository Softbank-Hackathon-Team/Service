// 뼈대 API를 흉내 내는 작은 서버 (DB·워커 없이 화면만 확인할 때).
// 경로·응답 모양은 통합본 API와 같다. 워커 대신 타이머가 상태를 한 칸씩 옮긴다.
// 실행: node mock/mock-api.mjs   (포트 3000, MOCK_PORT로 바꿈)
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as z85 from "./mock-z85.mjs";
import * as z86 from "./mock-z86.mjs";

// 작업 Z2: GET /migrations/:id/cost 가짜 응답. 실제 계산기(@svc/cost + V 가격 캐시)로 aws→gcp 한 번 뽑아 둔 것
// 다시 만들기: npx tsx tools/gen-cost-fixture.ts apps/web/mock/cost-fixture.json (루트에서)
const COST = JSON.parse(readFileSync(new URL("./cost-fixture.json", import.meta.url), "utf8"));
// 작업 Z58: GET /migrations/:id/agent-review 가짜 응답. 서버 STUB_REMEDIATE(apps/api/src/routes/agent-review.ts)와 같은 값
// (apps/api/test/agent-review.test.ts 가 둘이 같은지 본다)
const AGENT_REVIEW_STUB = JSON.parse(readFileSync(new URL("./agent-review-fixture.json", import.meta.url), "utf8"));
function costView(m) {
  const env = (id) => envs.find((e) => e.id === id);
  const s = env(m.sourceEnvId), t = env(m.targetEnvId);
  const ref = (e) => ({ id: e.id, provider: e.provider, name: e.name });
  const row = (p) => COST.estimate.envs.find((e) => e.provider === p);
  const sm = row(s.provider)?.monthlyUsd ?? null, tm = row(t.provider)?.monthlyUsd ?? null;
  const r1 = (x) => Math.round(x * 10) / 10;
  return { ...COST, migrationId: m.id, source: ref(s), target: ref(t), createdAt: new Date().toISOString(),
    pair: { from: s.provider, to: t.provider, sourceMonthlyUsd: sm, targetMonthlyUsd: tm,
      monthlyUsd: sm !== null && tm !== null ? r1(sm - tm) : null,
      creditPortionUsd: r1((row(t.provider)?.creditUsd ?? 0) - (row(s.provider)?.creditUsd ?? 0)) } };
}


const TENANT = "11111111-1111-4111-8111-111111111111";
const envs = [
  { id: "22222222-2222-4222-8222-222222222222", provider: "aws", name: "dev-aws", connectionStatus: "connected", accountId: null, lastVerifiedAt: null, failureReason: null },
  { id: "33333333-3333-4333-8333-333333333333", provider: "gcp", name: "dev-gcp", connectionStatus: "connected", accountId: null, lastVerifiedAt: null, failureReason: null },
  { id: "44444444-4444-4444-8444-444444444444", provider: "azure_mock", name: "dev-azure-mock", connectionStatus: "connected", accountId: null, lastVerifiedAt: null, failureReason: null },
];

// packages/adapters/src/azure-mock/runner.ts 의 status()와 같은 모양 (이름 규칙도 같게: sha256 앞 6자리)
const h6 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 6);
function envStatus(e) {
  if (e.provider !== "azure_mock")
    return { provider: e.provider, mock: false, envId: e.id, region: "default", health: "unknown", checkedAt: new Date().toISOString(), resources: [] };
  const h = h6(e.id), rg = `rg-platform-${h}`, sub = "/subscriptions/00000000-0000-0000-0000-000000000000";
  const res = (type, arm, name) => ({ type, name, id: `${sub}/resourceGroups/${rg}/providers/${arm}/${name}`, state: "Succeeded" });
  return { provider: "azure_mock", mock: true, envId: e.id, region: "koreacentral", health: "healthy", checkedAt: new Date().toISOString(),
    resources: [
      { type: "azurerm_resource_group", name: rg, id: `${sub}/resourceGroups/${rg}`, state: "Succeeded" },
      res("azurerm_virtual_network", "Microsoft.Network/virtualNetworks", `vnet-platform-${h}`),
      res("azurerm_kubernetes_cluster", "Microsoft.ContainerService/managedClusters", `aks-platform-${h}`),
      res("azurerm_container_registry", "Microsoft.ContainerRegistry/registries", `acrplatform${h}`),
    ] };
}
// Z83: MOCK_TEST_ENVS=N 이면 부하 시험이 남기는 모양의 환경 N개를 더한다 (화면의 "시험용 환경 접힘" 확인용)
for (let i = 0; i < Number(process.env.MOCK_TEST_ENVS ?? 0); i++)
  envs.push({ id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`, provider: "gcp", name: `load-mock-dst-${i}`,
    connectionStatus: "connected", accountId: null, lastVerifiedAt: null, failureReason: null });
const migrations = new Map();
const plans = new Map();
// Z83: GET /migrations/:id/timeline 용 전이 기록 (통합본은 감사 기록에서 만든다)
const log = new Map();
function logMove(m, from, to, detail = {}, measurements = []) {
  const arr = log.get(m.id) ?? []; const now = Date.now(); const prev = arr.at(-1);
  arr.push({ seq: arr.length + 1, at: new Date(now).toISOString(), kind: "transition", actor: from === null ? "api" : (AUTO[from] ? "worker" : "api"),
    action: "migration.advanced", result: "ok", from, to, durationMs: prev ? now - Date.parse(prev.at) : null, failureCode: null, requestId: null, measurements, detail });
  log.set(m.id, arr);
}
function timeline(m) {
  const items = log.get(m.id) ?? []; const durs = new Map();
  items.forEach((it, i) => { const end = items[i + 1] ? Date.parse(items[i + 1].at) : Date.now(); const d = durs.get(it.to) ?? { state: it.to, ms: 0, entries: 0 };
    d.ms += end - Date.parse(it.at); d.entries += 1; durs.set(it.to, d); });
  const createdAt = items[0]?.at ?? m.updatedAt;
  return { migrationId: m.id, status: m.status, createdAt, generatedAt: new Date().toISOString(), running: !["completed", "rolled_back", "cancelled"].includes(m.status),
    totalMs: Date.now() - Date.parse(createdAt), items, stateDurations: [...durs.values()] };
}
const STEP_MS = Number(process.env.MOCK_STEP_MS ?? 1500);

// 사람이 끼지 않는 칸은 타이머가 다음 칸으로 옮긴다
const AUTO = {
  importing: "spec_review", prechecking: "planning", planning: "awaiting_approval",
  provisioning: "deploying", deploying: "syncing", syncing: "shifting", shifting: "cutover",
  cutover: "rollback_window", rollback_window: "cleanup", cleanup: "completed",
};

// Z83-06: 워커가 detail/measurements 에 넣는 값 흉내 (apps/worker/src/jobs/*.ts 와 같은 키)
const PRECHECK_BLOCK = [
  { id: "PC-01", level: "block", message: "도착 환경 CIDR 10.0.0.0/16 이 출발과 겹침", fix: "도착 VPC CIDR 을 10.1.0.0/16 으로 바꿔" },
  { id: "PC-04", level: "warn", message: "Postgres 15 → 16 메이저 업그레이드 포함", fix: "복제 뒤 ANALYZE 필요" },
  { id: "PC-09", level: "info", message: "이미지 3개 레지스트리 복사 예정" },
];
function moveDetail(m, to) {
  if (to === "deploying") return [{ deploy: { status: "synced" }, gitops: { commit: "9d805bb3c0ffee", argoApp: "app-" + m.id.slice(0, 8) } }, []];
  if (to === "shifting") return [{}, [{ name: "replication_lag_ms", value: 12, unit: "ms" }, { name: "initial_copy_ms", value: 550, unit: "ms" }]];
  if (to === "rollback_window") return [{ windowSec: 3 }, [{ name: "cutover_pause_ms", value: 310, unit: "ms" }]];
  if (to === "spec_review" && m.status === "prechecking") return [{ precheck: PRECHECK_BLOCK }, []];
  if (to === "planning") return [{ precheck: PRECHECK_BLOCK.filter((c) => c.level !== "block") }, []];
  return [{}, []];
}
function move(m, to) {
  // MOCK_BLOCK=1: 첫 사전 점검은 막힘으로 되돌아간다(명세 검토 → 다시 확정하면 통과)
  if (to === "planning" && process.env.MOCK_BLOCK === "1" && !m._bounced) { m._bounced = true; to = "spec_review"; }
  const [detail, measurements] = moveDetail(m, to);
  logMove(m, m.status, to, detail, measurements);
  m.status = to; m.version += 1; m.updatedAt = new Date().toISOString();
  if (to === "planning") makePlan(m);
  const next = AUTO[to];
  if (next) setTimeout(() => { if (m.status === to) move(m, next); }, STEP_MS);
}

function makePlan(m) {
  const body = {
    planId: randomUUID(), migrationId: m.id, adapterVersion: "mock-0.1",
    steps: [
      { id: "provision", owner: "terraform", estSec: 300, rollback: "terraform destroy (도착 쪽만)" },
      { id: "deploy", owner: "argocd", estSec: 120 },
      { id: "sync", owner: "worker", estSec: 180, gate: "복제 지연 < 5초" },
      { id: "shift", owner: "worker", weights: [10, 50, 100], holdSec: 60, rollback: "가중치 0으로" },
      { id: "cutover", owner: "worker", estSec: 30 },
      { id: "cleanup", owner: "terraform", estSec: 120 },
    ],
    precheck: [
      { id: "PC-01", level: "info", message: "도착 리전 할당량 충분" },
      { id: "PC-07", level: "warn", message: "출발 DB에 기본 키 없는 표 1개", fix: "REPLICA IDENTITY FULL 설정" },
    ],
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: "sha256:tf-mock", helmValuesHash: "sha256:helm-mock",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  body.planHash = "sha256:" + createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  plans.set(body.planId, body);
  m.planId = body.planId;
}

const view = ({ planId, _bounced, ...m }) => m;
const err = (res, status, code, message) => send(res, status, { status, code, message, requestId: "mock-" + Date.now() });
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }

z85.seed(migrations, envs, logMove); // Z85: MOCK_SEED=1 이면 여러 상태의 이전 4건
z86.seed(migrations, envs, logMove); // Z86: MOCK_SEED=1 이면 온프레 환경 + 온프레→AWS 전환 중 1건

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/^\/api\/v1(?=\/)/, ""); // 통합본처럼 /api/v1 접두사를 받는다 (없어도 받음)
  let body = {};
  if (req.method === "POST") {
    let raw = ""; for await (const c of req) raw += c;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return err(res, 400, "BAD_REQUEST", "json"); }
  }
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  // Z93: 모의 API 는 로그인 없이 개발 헤더 모드로 돈다 (화면이 이 값을 보고 로그인 화면을 건너뛴다)
  if (p === "/auth/config") return send(res, 200, { devAuth: true, loginRequired: false });
  if (p === "/auth/refresh" || p === "/auth/logout") return err(res, 401, "REFRESH_INVALID", "mock has no login");
  if (req.headers["x-dev-tenant"] !== TENANT) return err(res, 401, "UNAUTHENTICATED", "no session");
  if (p === "/readyz") return send(res, 200, { ok: true });
  if (p === "/environments" && req.method === "GET") return send(res, 200, { items: envs });
  if (p === "/migrations" && req.method === "GET")
    return send(res, 200, { items: [...migrations.values()].reverse().slice(0, 50).map(view) });
  if (p === "/migrations" && req.method === "POST") {
    if (!body.sourceEnvId || !body.targetEnvId) return err(res, 400, "BAD_REQUEST", "sourceEnvId, targetEnvId");
    const m = { id: randomUUID(), status: "draft", version: 0, sourceEnvId: body.sourceEnvId, targetEnvId: body.targetEnvId, updatedAt: new Date().toISOString() };
    migrations.set(m.id, m); logMove(m, null, "draft"); move(m, "importing");
    return send(res, 202, { id: m.id });
  }
  req._res = res; // Z85: 비용·모니터링·보안감사 페이지 경로 (mock-z85.mjs)
  if (z85.handle(req, p, body, { migrations, envs, cost: COST, send, err })) return;
  if (z86.handle(req, p, body, { migrations, envs, send, err, envStatus })) return; // Z86: 환경 실자원·대응표
  let r;
  if ((r = p.match(/^\/migrations\/([^/]+)\/agent-review$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    // Z90 모양: llm 칸(모의 API 는 가짜). 기록 없으면 remediate null 이지만, 모의에선 대본을 보여 준다(FAKE_LLM=1 시험과 같음)
    return m ? send(res, 200, { migrationId: m.id, llm: { state: "fake", model: "mock-llm", why: "모의 API (FAKE_LLM=1 과 같음)" }, remediate: AGENT_REVIEW_STUB, specDraft: null })
      : err(res, 404, "NOT_FOUND", "migration " + r[1]);
  }
  // Z83-05: 장애 점검 실행 흉내 — 202 접수만. 결과는 위 STUB 그대로
  if ((r = p.match(/^\/migrations\/([^/]+)\/agent-review\/run$/)) && req.method === "POST") {
    const m = migrations.get(r[1]);
    if (!m) return err(res, 404, "NOT_FOUND", "migration " + r[1]);
    if (process.env.MOCK_LLM_KEY_MISSING === "1") return err(res, 409, "LLM_KEY_MISSING", "ANTHROPIC_API_KEY not set");
    return send(res, 202, { runId: randomUUID(), migrationId: m.id, kind: body?.kind === "spec_draft" ? "spec_draft" : "remediate", status: "queued" });
  }
  // Z83-05: API 문서 페이지 흉내 (진짜는 서버 Zod 스키마 → OpenAPI 표)
  if (p === "/docs" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><meta charset=utf-8><title>mock docs</title><body style=\"font:14px sans-serif;padding:16px\"><h1>OpenAPI (mock)</h1><p>진짜 서버에선 GET /api/v1/docs 가 경로 표를 돌려줘.</p><ul><li>GET /environments</li><li>POST /migrations</li><li>GET /migrations/:id/timeline</li></ul>");
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/timeline$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    return m ? send(res, 200, timeline(m)) : err(res, 404, "NOT_FOUND", "migration " + r[1]);
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/cost$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    return m ? send(res, 200, costView(m)) : err(res, 404, "NOT_FOUND", "migration " + r[1]);
  }
  // 작업 Z35: 가동 중 앱 숫자. 기본은 "프록시 연결 안 됨"(e2e 화면 그대로). MOCK_LIVE=1 이면 초당 50건씩 느는 가짜 숫자 (실패 0)
  if ((r = p.match(/^\/migrations\/([^/]+)\/live-traffic$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    if (!m) return err(res, 404, "NOT_FOUND", "migration " + r[1]);
    const base = { migrationId: m.id, source: "proxy", fetchedAt: new Date().toISOString(), c4xx: 0, held: 0, maxHoldMs: 0, mode: "hold", switchedAt: null, since: null, byState: [] };
    if (process.env.MOCK_LIVE !== "1") return send(res, 200, { ...base, available: false, reason: "not_configured", total: 0, ok: 0, fail: 0, p50Ms: null, p95Ms: null });
    m.liveStart ??= Date.now();
    const n = Math.round((Date.now() - m.liveStart) / 20);
    return send(res, 200, { ...base, available: true, total: n, ok: n, fail: 0, p50Ms: 6.2, p95Ms: 11.8, byState: [{ state: m.status, n, fail: 0, p95Ms: 11.8 }] });
  }
  // Z83: GET /migrations/:id/traffic-shift (Z75 z75-38 TrafficShiftProgress). shifting 동안 목표 50% 로 실측이 10%p 씩 다가가는 가짜 값
  //   MOCK_TRAFFIC_STUB=1 이면 흉내 표시 칸(가짜 지표·등록 안 된 가짜 LB)을 켠다 — 화면의 "흉내 지표 · 가짜 LB" 알약 확인용
  if ((r = p.match(/^\/migrations\/([^/]+)\/traffic-shift$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    if (!m) return err(res, 404, "NOT_FOUND", "migration " + r[1]);
    const marks = process.env.MOCK_TRAFFIC_STUB === "1" ? { metricsSource: "stub", lbStub: true, lbRegistered: false } : { metricsSource: null, lbStub: null, lbRegistered: false };
    const seen = m.shiftStart !== undefined;
    if (m.status !== "shifting" && !seen) return send(res, 200, { migrationId: m.id, available: false, targetWeightPct: null, observedWeightPct: null, reached: null, tolerancePct: 10, reobserve: 0, stepStartedAt: null, observedAt: null, ...marks });
    m.shiftStart ??= Date.now();
    const observed = Math.min(50, Math.round((Date.now() - m.shiftStart) / 400) * 10);
    return send(res, 200, { migrationId: m.id, available: true, targetWeightPct: 50, observedWeightPct: observed, reached: Math.abs(observed - 50) <= 10, tolerancePct: 10, reobserve: 0,
      stepStartedAt: new Date(m.shiftStart).toISOString(), observedAt: new Date().toISOString(), ...marks });
  }
  if ((r = p.match(/^\/environments\/([^/]+)\/status$/)) && req.method === "GET") {
    const e = envs.find((x) => x.id === r[1]);
    return e ? setTimeout(() => send(res, 200, envStatus(e)), 300) : err(res, 404, "NOT_FOUND", "environment " + r[1]);
  }
  if ((r = p.match(/^\/migrations\/([^/]+)(\/(plan|start))?$/))) {
    const m = migrations.get(r[1]);
    if (!m) return err(res, 404, "NOT_FOUND", "migration " + r[1]);
    if (!r[3] && req.method === "GET") return send(res, 200, view(m));
    if (r[3] === "plan" && req.method === "GET") return m.planId ? send(res, 200, plans.get(m.planId)) : err(res, 404, "NOT_FOUND", "plan of migration");
    const need = r[3] === "plan" ? "spec_review" : "approved";
    if (m.status !== need) return err(res, 409, "INVALID_TRANSITION", `${m.status} -> ${r[3] === "plan" ? "prechecking" : "provisioning"}`);
    move(m, r[3] === "plan" ? "prechecking" : "provisioning");
    return send(res, 202, { id: m.id });
  }
  if ((r = p.match(/^\/plans\/([^/]+)(\/approvals)?$/))) {
    const pl = plans.get(r[1]);
    if (!pl) return err(res, 404, "NOT_FOUND", "plan " + r[1]);
    if (!r[2]) return send(res, 200, pl);
    const m = migrations.get(pl.migrationId);
    if (body.planHash !== pl.planHash) return err(res, 409, "PLAN_HASH_MISMATCH", "plan changed since you viewed it");
    if (m.status !== "awaiting_approval") return err(res, 409, "INVALID_TRANSITION", `${m.status} -> approved`);
    const to = body.decision === "approve" ? "approved" : "rejected";
    move(m, to);
    return send(res, 200, { migrationId: m.id, planId: pl.planId, status: to });
  }
  return err(res, 404, "NOT_FOUND", req.method + " " + p);
}).listen(Number(process.env.MOCK_PORT ?? 3000), () => console.log("mock api on", process.env.MOCK_PORT ?? 3000));
