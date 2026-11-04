// PF07 (6회차 운영자 실수): env-connect create 를 실수 뒤 다시 칠 때.
//   ① 처음에 --cluster 를 빠뜨려 draft 로 남은 환경을 이어 쓰면 영영 CLUSTER_NAME_REQUIRED → draft 는 이어 쓰지 않고 새로 만든다
//   ② 이어 쓴 환경(고객 대기)에 다른 --region/--cluster 를 주면 링크가 옛 값을 가리킨다 → 다르다고 알리고 exit 4
//   가짜 API(이 프로세스 안 http 서버)에 진짜 도구를 띄워 본다. 클라우드 호출 0 (스택·경계 확인 끔)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
type Env = { id: string; provider: string; name: string; connectionStatus: string; region: string | null; cluster: string | null };
let envs: Env[] = [];
let server: Server;
let base = "";

function view(e: Env) {
  return { id: e.id, provider: e.provider, name: e.name, connectionStatus: e.connectionStatus, accountId: null, lastVerifiedAt: null, failureReason: null };
}
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const u = req.url ?? "";
      // 맥 로컬처럼 .secrets/demo-login.txt 가 있으면 도구가 로그인부터 한다 → 가짜 토큰
      if (req.method === "POST" && u === "/api/v1/auth/login") return send(200, { accessToken: "fake" });
      if (req.method === "GET" && u === "/api/v1/environments") return send(200, { items: envs.map(view) });
      if (req.method === "POST" && u === "/api/v1/environments") {
        const b = JSON.parse(body || "{}");
        if (envs.some((e) => e.name === b.name)) return send(409, { code: "ENV_NAME_TAKEN" });
        const e: Env = { id: randomUUID(), provider: b.provider, name: b.name, connectionStatus: "draft", region: b.region ?? null, cluster: b.clusterName ?? null };
        envs.push(e);
        return send(201, view(e));
      }
      const m = /^\/api\/v1\/environments\/([^/]+)\/connection-link/.exec(u);
      if (req.method === "POST" && m) {
        const e = envs.find((x) => x.id === m[1])!;
        if (!e.cluster) return send(400, { code: "CLUSTER_NAME_REQUIRED" });
        e.connectionStatus = "awaiting_customer";
        const r = e.region ?? "ap-northeast-2";
        return send(200, { kind: "aws_quick_create", externalId: "abcd".repeat(16), createBoundaryPolicy: true, expiresAt: "2026-11-05T00:00:00Z",
          url: `https://${r}.console.aws.amazon.com/cloudformation/home?region=${r}#/stacks/create/review?stackName=svc-connect-${e.id.slice(0, 8)}&param_EksClusterName=${encodeURIComponent(e.cluster)}` });
      }
      send(404, { code: "NOT_FOUND" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

function tool(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "tools/env-connect.ts", ...args], { cwd: ROOT,
      env: { ...process.env, API_URL: base, DEV_AUTH: "1", DEMO_USER_PASSWORD: "", CONNECT_STACK_CHECK: "0", CONNECT_BOUNDARY_CHECK: "0", ...extra } });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { out += c; });
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("① --cluster 빠뜨린 draft 를 다시 칠 때: 이어 쓰지 않고 새 이름으로 만들어 링크까지", async () => {
  envs = [];
  const r1 = await tool(["create", "--provider", "aws", "--name", "src-aws", "--region", "ap-northeast-2"]);
  assert.equal(r1.code, 1, r1.out);
  assert.match(r1.out, /CLUSTER_NAME_REQUIRED/);
  const r2 = await tool(["create", "--provider", "aws", "--name", "src-aws", "--region", "ap-northeast-2", "--cluster", "shop-eks"]);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /^환경 만듦  \S+ \(aws, src-aws-\d{8}T\d{4}z\)/m, "첫 줄 모양 그대로, 새 이름");
  assert.match(r2.out, /param_EksClusterName=shop-eks/);
  assert.equal(envs.length, 2);
});

test("② 고객 대기 환경을 이어 쓰는데 다른 --cluster·--region → 알리고 exit 4, 같은 값이면 그대로 이어 씀", async () => {
  envs = [];
  const r1 = await tool(["create", "--provider", "aws", "--name", "src-aws", "--region", "ap-northeast-2", "--cluster", "shop-eks"]);
  assert.equal(r1.code, 0, r1.out);
  const same = await tool(["create", "--provider", "aws", "--name", "src-aws", "--region", "ap-northeast-2", "--cluster", "shop-eks"]);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /이어 씀: 지금 awaiting_customer/);
  const diff = await tool(["create", "--provider", "aws", "--name", "src-aws", "--region", "us-east-1", "--cluster", "shop-eks-2"]);
  assert.equal(diff.code, 4, diff.out);
  assert.match(diff.out, /이어 쓴 환경 값이 이번 입력과 다름  지역 ap-northeast-2 \(이번 입력 us-east-1\), 클러스터 shop-eks \(이번 입력 shop-eks-2\)/);
  assert.equal(envs.length, 1, "새 환경을 몰래 만들지 않음");
});

test("RV-17: 파일 모드면 링크(ExternalId·주체 ARN 원문)는 화면에 없고 0600 파일에만", async () => {
  envs = [];
  const { mkdtempSync, readFileSync, statSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/link-`);
  const r = await tool(["create", "--provider", "aws", "--name", "src-aws", "--cluster", "shop-eks"], { CONNECT_LINK_TO_FILE: "1", CONNECT_LINK_DIR: dir });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /https:\/\/|param_/, "화면에 주소 없음");
  assert.match(r.out, /연결 링크는 파일로만/);
  const f = readdirSync(dir).find((x) => x.startsWith("connect-link-"))!;
  assert.match(readFileSync(`${dir}/${f}`, "utf8"), /^https:\/\/ap-northeast-2\.console\.aws\.amazon\.com\/.*param_EksClusterName=shop-eks/);
  assert.equal(statSync(`${dir}/${f}`).mode & 0o777, 0o600);
});
