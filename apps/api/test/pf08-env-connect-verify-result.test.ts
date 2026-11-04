// PF08 (7회차 심사 데모): env:connect verify 끝 줄 "연결 확인 결과  <상태>" + rc (0 connected · 1 failed · 5 아직 verifying),
//   할 일(needsHuman)·빠진 권한 찍기, 이미 connected 면 409 대신 결과 줄만. 가짜 API(이 프로세스 안 http 서버)에 진짜 도구를 띄워 본다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ID = "0b9c2f4e-1111-4111-8111-111111111111";
let after1: Record<string, unknown> = {};   // verify 요청 뒤 GET 이 줄 환경
let start = "awaiting_customer";
let verifyCalls = 0;
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const u = req.url ?? "";
      const env = { id: ID, provider: "aws", name: "src", accountId: null, lastVerifiedAt: null, failureReason: null,
        ...(verifyCalls ? after1 : { connectionStatus: start }) };
      if (req.method === "POST" && u === "/api/v1/auth/login") return send(200, { accessToken: "fake" });
      if (req.method === "GET" && u === "/api/v1/environments") return send(200, { items: [env] });
      if (req.method === "POST" && u === `/api/v1/environments/${ID}/verify`) {
        if (start === "connected" || start === "verifying") return send(409, { code: "InvalidTransition" });
        verifyCalls++;
        return send(202, { envId: ID, status: "verifying", queued: true });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

function verify(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "tools/env-connect.ts", "verify", "--env", ID, "--account", "123456789012"], { cwd: ROOT,
      env: { ...process.env, API_URL: base, DEV_AUTH: "1", DEMO_USER_PASSWORD: "", VERIFY_WAIT_SEC: "10" } });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { out += c; });
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("connected → rc 0, 끝 줄, 빠진 선택 권한도 찍음", async () => {
  start = "awaiting_customer"; verifyCalls = 0;
  after1 = { connectionStatus: "connected", missingPermissions: ["guardduty:ListDetectors"] };
  const r = await verify();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /빠진 권한  guardduty:ListDetectors/);
  assert.match(r.out, /^연결 확인 결과  connected$/m);
});

test("거부: failed → rc 1, 사유·할 일 찍음 (예전엔 rc 0)", async () => {
  start = "awaiting_customer"; verifyCalls = 0;
  after1 = { connectionStatus: "failed", failureReason: "ROLE_ASSUME_DENIED", needsHuman: ["연결 스택이 CREATE_COMPLETE 인지 확인"] };
  const r = await verify();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /할 일      연결 스택이 CREATE_COMPLETE 인지 확인/);
  assert.match(r.out, /다음 할 일  스택이 CREATE_COMPLETE 인지/);
  assert.match(r.out, /^연결 확인 결과  failed \(ROLE_ASSUME_DENIED\)$/m);
  assert.doesNotMatch(r.out, /결과  connected/);
});

test("disconnected 는 통과 아님 (rc 1) — 출력에 'connected' 글자가 들어가도", async () => {
  start = "awaiting_customer"; verifyCalls = 0;
  after1 = { connectionStatus: "disconnected" };
  const r = await verify();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^연결 확인 결과  disconnected$/m);
});

test("이미 connected → 409 덩어리 없이 rc 0", async () => {
  start = "connected"; verifyCalls = 0; after1 = {};
  const r = await verify();
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /409|InvalidTransition/);
  assert.match(r.out, /^연결 확인 결과  connected$/m);
});

test("시간 안에 안 끝남 → rc 5, 다시 치라는 줄", { timeout: 30_000 }, async () => {
  start = "awaiting_customer"; verifyCalls = 0;
  after1 = { connectionStatus: "verifying" };
  const r = await verify();
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /^연결 확인 결과  verifying$/m);
  assert.match(r.out, /아직 확인 중/);
});

test("PF09 재실행: verifying 중에 다시 치면 409 없이 기다려서 결과 (새 확인 요청 0)", async () => {
  start = "verifying"; verifyCalls = 0; after1 = {};
  // verifyCalls 가 0 이면 GET 은 start 상태를 준다 → 2초 뒤 connected 로 바꿈
  const t = setTimeout(() => { start = "connected"; }, 2500);
  const r = await verify();
  clearTimeout(t);
  assert.equal(r.code, 0, r.out);
  assert.equal(verifyCalls, 0, "POST verify 안 보냄");
  assert.match(r.out, /이미 verifying/);
  assert.doesNotMatch(r.out, /409/);
  assert.match(r.out, /^연결 확인 결과  connected$/m);
});

test("PF09 재실행: 연결된 환경에 link 다시 → 409 덩어리 없이 한 줄, rc 0", async () => {
  start = "connected"; verifyCalls = 0; after1 = {};
  const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "tools/env-connect.ts", "link", "--env", ID], { cwd: ROOT,
      env: { ...process.env, API_URL: base, DEV_AUTH: "1", DEMO_USER_PASSWORD: "" } });
    let out = "";
    p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { out += c; });
    p.on("close", (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /이미 connected → 링크를 다시 받지 않음/);
});
