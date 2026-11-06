// 고객 Terraform state 내려받기: worker 안 창구 (apps/worker/src/state-export-server.ts). DB 없이 임시 폴더로 돈다
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatePath, startStateExportServer, stateExportFromEnv } from "../src/state-export-server.js";

const TOKEN = "t".repeat(40);
const A = "t-aaaaaaaa", B = "t-bbbbbbbb";
const M = "22222222-2222-4222-8222-222222222222";       // A 회사 이전
const M_B = "33333333-3333-4333-8333-333333333333";     // B 회사 이전
const M_EMPTY = "44444444-4444-4444-8444-444444444444"; // 폴더는 있는데 state 없음
const M_LINK = "55555555-5555-4555-8555-555555555555";  // state 가 회사 폴더 밖을 가리키는 링크
const ENV = "66666666-6666-4666-8666-666666666666";
const STATE = JSON.stringify({ version: 4, serial: 7, resources: [] });

const root = mkdtempSync(join(tmpdir(), "state-export-"));
function workDir(tenant: string, id: string, state?: string) {
  const d = join(root, tenant, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "terraform.tfvars.json"), "{}");
  if (state !== undefined) writeFileSync(join(d, "terraform.tfstate"), state);
  return d;
}
workDir(A, M, STATE);
workDir(B, M_B, '{"other":"tenant"}');
workDir(A, M_EMPTY);
writeFileSync(join(root, "outside.tfstate"), '{"secret":"outside"}');
symlinkSync(join(root, "outside.tfstate"), join(workDir(A, M_LINK), "terraform.tfstate"));
mkdirSync(join(root, A, `env-${ENV}`), { recursive: true });
writeFileSync(join(root, A, `env-${ENV}`, "terraform.tfstate"), '{"env":true}');

const lines: Array<Record<string, unknown>> = [];
const log = { info: (o: Record<string, unknown>) => { lines.push(o); }, warn: (o: Record<string, unknown>) => { lines.push(o); } };
const server = await startStateExportServer({ token: TOKEN, root, port: 0, host: "127.0.0.1", log });
after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });

// fetch 는 경로의 ../ 를 줄여 버린다 → 날것 그대로 보내려고 http.request
function get(path: string, o: { token?: string | null; method?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((res, rej) => {
    const headers: Record<string, string> = {};
    if (o.token !== null) headers["x-internal-token"] = o.token ?? TOKEN;
    const q = request({ host: "127.0.0.1", port: server.port, path, method: o.method ?? "GET", headers }, (r) => {
      let body = "";
      r.setEncoding("utf8").on("data", (c) => { body += c; }).on("end", () => res({ status: r.statusCode!, body, headers: r.headers }));
    });
    q.on("error", rej).end();
  });
}

test("정상: 앱 층 state 를 그대로 200 application/json 으로, 원본은 남는다", async () => {
  const r = await get(`/internal/state/${A}/app/${M}`);
  assert.equal(r.status, 200);
  assert.equal(r.body, STATE);
  assert.match(String(r.headers["content-type"]), /application\/json/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(existsSync(join(root, A, M, "terraform.tfstate")));
});

test("정상: 환경 층 state (env-<환경 id>/terraform.tfstate)", async () => {
  const r = await get(`/internal/state/${A}/env/${ENV}`);
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"env":true}');
});

test("토큰이 없거나 틀리면 401 (경로를 보기 전에)", async () => {
  assert.equal((await get(`/internal/state/${A}/app/${M}`, { token: null })).status, 401);
  assert.equal((await get(`/internal/state/${A}/app/${M}`, { token: "x" })).status, 401);
  assert.equal((await get(`/internal/state/${A}/app/${M}`, { token: TOKEN + "x" })).status, 401);
  assert.equal((await get("/internal/state/../../etc/passwd", { token: "x" })).status, 401);
});

test("GET 외 405", async () => {
  const r = await get(`/internal/state/${A}/app/${M}`, { method: "DELETE" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "GET");
  assert.ok(existsSync(join(root, A, M, "terraform.tfstate")));
});

test("모양이 틀리면 400 (회사 slug·종류·id·조각 수)", async () => {
  for (const p of [
    `/internal/state/tenant-a/app/${M}`, `/internal/state/T-AAAAAAAA/app/${M}`, `/internal/state/${A}/db/${M}`,
    `/internal/state/${A}/app/not-a-uuid`, `/internal/state/${A}/app`, `/internal/state/${A}/app/${M}/extra`, "/other",
  ]) assert.equal((await get(p)).status, 400, p);
});

test("../ 가 섞인 경로는 400 (날것·인코딩 둘 다)", async () => {
  for (const p of [
    `/internal/state/${A}/app/../../${B}/app/${M_B}`, `/internal/state/${A}/../${B}/app/${M_B}`,
    `/internal/state/${A}/app/%2e%2e%2f${M_B}`, `/internal/state/..%2f${B}/app/${M_B}`,
  ]) assert.equal((await get(p)).status, 400, p);
});

test("다른 회사 폴더의 이전은 404 (B 이전을 A 이름으로)", async () => {
  const r = await get(`/internal/state/${A}/app/${M_B}`);
  assert.equal(r.status, 404);
  assert.ok(!r.body.includes("other"));
});

test("파일 없음 404: 이전 폴더 없음 / 폴더만 있고 state 없음 / 환경 층 없음 / 회사 폴더 밖 링크", async () => {
  assert.equal((await get(`/internal/state/${A}/app/77777777-7777-4777-8777-777777777777`)).status, 404);
  assert.equal((await get(`/internal/state/${A}/app/${M_EMPTY}`)).status, 404);
  assert.equal((await get(`/internal/state/${B}/env/${ENV}`)).status, 404);
  const link = await get(`/internal/state/${A}/app/${M_LINK}`);
  assert.equal(link.status, 404);
  assert.ok(!link.body.includes("outside"));
});

test("로그에는 상태 코드·종류·id 만 (내용·토큰·경로 없음)", () => {
  const all = JSON.stringify(lines);
  assert.ok(lines.some((l) => l.status === 200 && l.id === M));
  for (const bad of [TOKEN, root, "serial", "secret"]) assert.ok(!all.includes(bad), bad);
});

test("설정: 토큰이 없거나 포트 0 이면 창구를 안 연다", () => {
  assert.equal(stateExportFromEnv({}), null);
  assert.equal(stateExportFromEnv({ INTERNAL_STATE_TOKEN: "  " }), null);
  assert.equal(stateExportFromEnv({ INTERNAL_STATE_TOKEN: TOKEN, WORKER_STATE_EXPORT_PORT: "0" }), null);
  assert.deepEqual(stateExportFromEnv({ INTERNAL_STATE_TOKEN: TOKEN, TF_WORK_DIR: "/w" }), { token: TOKEN, root: "/w", port: 8081 });
});

test("parseStatePath: 질의 문자열은 무시", () => {
  assert.deepEqual(parseStatePath(`/internal/state/${A}/app/${M}?x=1`), { tenant: A, layer: "app", id: M });
});
