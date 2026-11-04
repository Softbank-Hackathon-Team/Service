// vCluster 리허설 읽기 경로 (GET /migrations/:id/rehearsal). DB 없이 돈다: 모양 바꾸기와 경로 규칙
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { RehearsalView, type FidelityMatrix, type RehearsalResult } from "@svc/contracts";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { buildRehearsalView, rehearsalRoutes, type RehearsalRead, type RehearsalRow } from "../src/routes/rehearsal.js";

const T = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

const SHA = "a".repeat(64);
const workerMatrix: FidelityMatrix = {
  version: 1, target: "aws-eks", bundleSha256: SHA,
  items: [{ id: "manifests", status: "identical", real: "렌더 그대로", sandbox: "렌더 그대로", reason: "", refs: [] }],
};
const fullMatrix: FidelityMatrix = {
  ...workerMatrix,
  items: [...workerMatrix.items,
    { id: "images", status: "substituted", real: "ECR 원본", sandbox: "플랫폼 ECR 사본", reason: "고객 계정 접근 없음", refs: ["Deployment/shop/web"] }],
};
const result = (over: Partial<RehearsalResult> = {}): RehearsalResult => ({
  verdict: "passed", failureCode: null,
  sandbox: { podSecurity: "baseline", runtimeClass: null, name: "sbx-abc123", hostNamespace: "sbx-abc123", chart: "vcluster-0.37.6", k8sVersion: "v1.33.1", mock: false },
  bundleSha256: SHA,
  checks: [{ id: "rollout", subject: "Deployment/web", required: true, ok: true, ms: 4200, detail: "ready 2/2" }],
  fidelity: fullMatrix, warnings: [], timingsMs: { create: 31000, apply: 2000, check: 40000, delete: 5000 }, deleted: true,
  ...over,
});
const row = (over: Partial<RehearsalRow> = {}): RehearsalRow => ({
  id: RUN, status: "passed", phase: "done", skip_reason: null, reused_from: null, sandbox_name: "sbx-abc123",
  created_at: "2026-11-07T03:00:00.000Z", started_at: "2026-11-07T03:00:05.000Z", finished_at: "2026-11-07T03:01:30.000Z",
  deadline_at: "2026-11-07T03:20:00.000Z", input_fidelity: workerMatrix, result: result(),
  ...over,
});

test("통과: 결과와 합친 충실도 표, 샌드박스 이름이 그대로 실린다", () => {
  const v = RehearsalView.parse(buildRehearsalView(M, row()));
  assert.equal(v.run?.status, "passed");
  assert.equal(v.run?.sandboxName, "sbx-abc123");
  assert.equal(v.run?.result?.verdict, "passed");
  assert.deepEqual(v.run?.fidelity, fullMatrix);
});

test("실패: 실패 코드와 어느 검사가 깨졌는지가 결과에 실린다", () => {
  const failed = result({
    verdict: "failed", failureCode: "REHEARSAL_CRASHLOOP",
    checks: [{ id: "restarts", subject: "Deployment/web", required: true, ok: false, ms: 60000, detail: "restarts=7" }],
  });
  const v = RehearsalView.parse(buildRehearsalView(M, row({ status: "failed", result: failed })));
  assert.equal(v.run?.result?.failureCode, "REHEARSAL_CRASHLOOP");
  assert.equal(v.run?.result?.checks[0]?.ok, false);
});

test("건너뜀: skip 이유만 있고 결과·충실도는 null", () => {
  const v = RehearsalView.parse(buildRehearsalView(M, row({
    status: "skipped", phase: null, skip_reason: "disabled", sandbox_name: null, started_at: null, deadline_at: null,
    input_fidelity: null, result: null,
  })));
  assert.equal(v.run?.skip, "disabled");
  assert.equal(v.run?.result, null);
  assert.equal(v.run?.fidelity, null);
});

test("진행 중: 결과가 오기 전에는 워커가 넣은 충실도 표를 보여 준다", () => {
  const v = RehearsalView.parse(buildRehearsalView(M, row({ status: "running", phase: "applying", finished_at: null, result: null })));
  assert.equal(v.run?.phase, "applying");
  assert.equal(v.run?.result, null);
  assert.deepEqual(v.run?.fidelity, workerMatrix);
});

test("줄이 없으면 run 이 null", () => {
  assert.deepEqual(RehearsalView.parse(buildRehearsalView(M, null)), { migrationId: M, run: null });
});

test("거부: 모양이 안 맞는 결과 칸은 null 로 두고 줄 상태는 그대로 보인다 (가짜 값으로 안 채움)", () => {
  const v = RehearsalView.parse(buildRehearsalView(M, row({ status: "error", result: { verdict: "oops" }, input_fidelity: { nope: 1 } })));
  assert.equal(v.run?.status, "error");
  assert.equal(v.run?.result, null);
  assert.equal(v.run?.fidelity, null);
});

test("거부: 저장된 글에 비밀이 섞여 있어도 응답에서는 가려진다", () => {
  const leaky = result({
    checks: [{ id: "db_seen", subject: "web→db", required: true, ok: false, ms: 1, detail: "connect failed password=hunter2 host=db.abc.ap-northeast-2.rds.amazonaws.com" }],
    warnings: ["Authorization: Bearer abcdefghijklmnop"],
  });
  const view = RehearsalView.parse(buildRehearsalView(M, row({ result: leaky })));
  assert.match(view.run?.result?.checks[0]?.detail ?? "", /password=<hidden>/);
  const body = JSON.stringify(view);
  assert.ok(!body.includes("hunter2"), body);
  assert.ok(!body.includes("rds.amazonaws.com"), body);
  assert.ok(!body.includes("abcdefghijklmnop"), body);
});

async function appWith(read: RehearsalRead | ((t: string) => RehearsalRead)) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(rehearsalRoutes, { prefix: "/api/v1", load: async (t: string) => (typeof read === "function" ? read(t) : read) });
  await app.ready();
  return app;
}

test("경로: 200 + 계약 모양 + no-store, 없는 이전(남의 회사 포함) 404, 헤더 없으면 401, uuid 아니면 400", async () => {
  const app = await appWith((t) => ({ migrationExists: t === T, row: t === T ? row() : null }));
  const url = `/api/v1/migrations/${M}/rehearsal`;
  const ok = await app.inject({ url, headers: { "x-dev-tenant": T } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(RehearsalView.parse(ok.json()).run?.id, RUN);
  const other = await app.inject({ url, headers: { "x-dev-tenant": "99999999-9999-4999-8999-999999999999" } });
  assert.equal(other.statusCode, 404);
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/migrations/x/rehearsal", headers: { "x-dev-tenant": T } })).statusCode, 400);
  await app.close();
});

test("경로: 이전은 있고 줄이 없으면 200 + run null", async () => {
  const app = await appWith({ migrationExists: true, row: null });
  const res = await app.inject({ url: `/api/v1/migrations/${M}/rehearsal`, headers: { "x-dev-tenant": T } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { migrationId: M, run: null });
  await app.close();
});
