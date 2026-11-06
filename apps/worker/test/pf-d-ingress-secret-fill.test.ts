// deploy 커밋 전, 빈 입구 비밀(cloudflared-token·svc-metric-token)만 플랫폼이 채운다 (ADR-072 예외, gitops/ingress-secrets.ts)
import { test } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import assert from "node:assert/strict";
import { fillIngressSecrets, hashMetricToken, newMetricToken, readTunnelToken, tunnelSourceFromEnv, writeIngressSecret, type MetricIssuer } from "../src/gitops/ingress-secrets.js";
import { METRIC_TOKEN_PREFIX } from "@svc/contracts";
import { ingressSecretFill, secretValuesGate, setIngressSecretSources, setSecretValueExec } from "../src/jobs/deploy.js";
import { approvedValues, type DeployInput } from "../src/gitops/index.js";
import { ONE } from "./demo-one.js";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import type { Exec } from "@svc/adapters";
import type { MigrationJob } from "@svc/contracts";
import type { MigrationRow } from "../src/jobs/_step.js";

const TUNNEL = "eyJhIjoiVFVOTkVMLVNFQ1JFVC1WQUxVRSJ9";          // 가짜 터널 토큰
const METRIC = "svc_mt_" + "M".repeat(43);                     // 가짜 지표 토큰 모양

interface Call { cmd: string; args: string[]; data?: string; file?: string; mode?: number; env: NodeJS.ProcessEnv }
/** --data-file=<경로> 의 내용·권한을 부른 그 순간에 읽는다 (끝나면 지워지므로) */
const dataFileOf = (args: string[]) => {
  const f = args.find((a) => a.startsWith("--data-file="))?.slice("--data-file=".length);
  return f ? { file: f, data: readFileSync(f, "utf8"), mode: statSync(f).mode & 0o777 } : {};
};
/** 가짜 CLI. 상태(값 있음)는 그릇 이름별, 쓰기가 오면 그 그릇이 찬다 */
function fakeCli(o: { filled?: string[]; denied?: string[]; writeFails?: Record<string, string>; tunnelOut?: { code: number; stdout?: string; stderr?: string } } = {}) {
  const filled = new Set(o.filled ?? []);
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env, ...dataFileOf(args) });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", ms: 1 });
    if (args.includes("get-secret-value")) return { stderr: "", ms: 1, stdout: "", ...(o.tunnelOut ?? { code: 0, stdout: JSON.stringify({ sourceToken: "S", targetToken: TUNNEL }) }) };
    if (cmd === "gcloud" && args[2] === "describe") {
      const k = args.find((a) => a.startsWith("--secret="))!.slice(9);
      if (o.denied?.includes(k)) return { code: 1, stdout: "", stderr: "PERMISSION_DENIED", ms: 1 };
      return ok(filled.has(k) ? "ENABLED" : "");
    }
    if (cmd === "aws" && args.includes("describe-secret")) {
      const k = args[args.indexOf("--secret-id") + 1]!;
      return ok(JSON.stringify({ deleted: null, stages: filled.has(k) ? { v: ["AWSCURRENT"] } : null }));
    }
    const k = cmd === "gcloud" ? args[3]! : args[args.indexOf("--secret-id") + 1]!;
    if (o.writeFails?.[k]) return { code: 1, stdout: "", stderr: o.writeFails[k]!, ms: 1 };
    filled.add(k);
    return ok();
  };
  return { exec, calls, filled };
}
const fakeMetric = (log: string[] = []): MetricIssuer => async (write) => { log.push("issue"); await write(METRIC); log.push("committed"); };
const noToken = (s: unknown) => { const j = JSON.stringify(s); assert.ok(!j.includes(TUNNEL) && !j.includes(METRIC), `토큰 원문이 남음: ${j.slice(0, 200)}`); };

const gcpSecrets = [
  { name: "cloudflared-token", remoteKey: "app-shop-cloudflared-token" },
  { name: "shop-db", remoteKey: "app-shop-shop-db" },
  { name: "svc-metric-token", remoteKey: "app-shop-svc-metric-token" },
];

test("빈 입구 그릇만 채우고, 값 있는 그릇·고객 앱 비밀은 건드리지 않는다", async () => {
  const cli = fakeCli({ filled: ["app-shop-cloudflared-token"] });
  const log: string[] = [];
  const r = await fillIngressSecrets({ secrets: gcpSecrets, projectId: "iron-target-gcp",
    tunnel: async () => TUNNEL, metric: fakeMetric(log) }, cli.exec);
  assert.deepEqual(r.filled, ["svc-metric-token"]);
  assert.deepEqual(r.skipped, [{ name: "cloudflared-token", why: "has_value" }]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(log, ["issue", "committed"]);
  const writes = cli.calls.filter((c) => c.args.includes("add"));
  assert.equal(writes.length, 1, "값 있는 그릇은 안 덮는다");
  assert.deepEqual(writes[0]!.args.slice(0, 5), ["secrets", "versions", "add", "app-shop-svc-metric-token", "--project=iron-target-gcp"]);
  assert.deepEqual(JSON.parse(writes[0]!.data!), { token: METRIC }, "차트가 property token 으로 읽는 JSON");
  assert.equal(writes[0]!.mode, 0o600, "임시 파일은 0600");
  assert.equal(existsSync(writes[0]!.file!), false, "끝나면 임시 파일을 지운다");
  assert.ok(!cli.calls.some((c) => c.args.some((a) => a.includes("shop-db"))), "고객 앱 비밀 그릇은 보지도 않는다");
  for (const c of cli.calls) noToken(c.args);
  noToken(r);
});

test("aws 도착은 채우지 않는다 (쓰기 권한 없음) → 기존 검사가 SECRET_VALUES_MISSING 으로 멈춘다", async () => {
  const cli = fakeCli();
  const log: string[] = [];
  setSecretValueExec(cli.exec);
  setIngressSecretSources({ tunnel: async () => TUNNEL, metric: fakeMetric(log) });
  try {
    assert.equal(await ingressSecretFill(job, mig, input("aws")), null);
    assert.equal(cli.calls.length, 0, "그릇을 보지도 쓰지도 않는다");
    assert.deepEqual(log, [], "지표 토큰 발급 안 함");
    const out = await secretValuesGate(input("aws"));
    assert.equal(out?.failureCode, "SECRET_VALUES_MISSING");
  } finally { setSecretValueExec(undefined); setIngressSecretSources(undefined); }
});

test("지표 토큰 모양·해시는 api 와 같다 (접두사 + base64url 43자, sha256 hex)", () => {
  const t = newMetricToken();
  assert.ok(t.startsWith(METRIC_TOKEN_PREFIX));
  assert.match(t.slice(METRIC_TOKEN_PREFIX.length), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newMetricToken(), t);
  assert.match(hashMetricToken(t), /^[0-9a-f]{64}$/);
  assert.equal(hashMetricToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("입구 없는 앱(터널 이름 없음)·지표 꺼짐(지표 이름 없음)이면 아무것도 안 하고 지표 토큰도 발급 안 한다", async () => {
  const cli = fakeCli();
  const log: string[] = [];
  const r = await fillIngressSecrets({ secrets: [{ name: "shop-db", remoteKey: "app-shop-shop-db" }], projectId: "p",
    tunnel: async () => { throw new Error("부르면 안 됨"); }, metric: fakeMetric(log) }, cli.exec);
  assert.deepEqual(r, { filled: [], skipped: [], failed: [] });
  assert.equal(cli.calls.length, 0);
  assert.deepEqual(log, [], "지표 토큰 발급 안 함");
});

test("지표가 꺼진 배포(TRAFFIC_METRICS_ENDPOINT 없음)는 svc-metric-token 이 값에 없어 발급하지 않는다 (deploy 배선)", async () => {
  const saved = process.env.TRAFFIC_METRICS_ENDPOINT;
  delete process.env.TRAFFIC_METRICS_ENDPOINT;
  const cli = fakeCli();
  const log: string[] = [];
  setSecretValueExec(cli.exec);
  setIngressSecretSources({ tunnel: async () => TUNNEL, metric: fakeMetric(log) });
  try {
    const r = await ingressSecretFill(job, mig, input("gcp"));
    assert.deepEqual(r?.filled, ["cloudflared-token"]);
    assert.deepEqual(log, []);
    // 켜면 둘 다
    process.env.TRAFFIC_METRICS_ENDPOINT = "https://metrics.example/v1/metrics";
    const r2 = await ingressSecretFill(job, mig, input("gcp"));
    assert.deepEqual(r2?.filled, ["svc-metric-token"], "터널은 앞에서 찼다");
    assert.deepEqual(log, ["issue", "committed"]);
  } finally {
    setSecretValueExec(undefined); setIngressSecretSources(undefined);
    if (saved === undefined) delete process.env.TRAFFIC_METRICS_ENDPOINT; else process.env.TRAFFIC_METRICS_ENDPOINT = saved;
  }
});

test("상태를 못 읽은 그릇은 건너뛰고(뒤 검사가 판정), 쓰기 실패면 failed + 원문 없는 오류. 지표 발급도 되돌린다", async () => {
  const cli = fakeCli({ denied: ["app-shop-cloudflared-token"], writeFails: { "app-shop-svc-metric-token": `PERMISSION_DENIED payload {"token":"${METRIC}"}` } });
  const log: string[] = [];
  const r = await fillIngressSecrets({ secrets: gcpSecrets, projectId: "p", tunnel: async () => TUNNEL, metric: fakeMetric(log) }, cli.exec);
  assert.deepEqual(r.skipped, [{ name: "cloudflared-token", why: "unknown" }]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.name, "svc-metric-token");
  assert.match(r.failed[0]!.error, /PERMISSION_DENIED/);
  assert.deepEqual(log, ["issue"], "쓰기가 던지면 발급 트랜잭션이 끝까지 안 간다(되돌림)");
  noToken(r);
});

test("터널 토큰 출처: worker 자기 env 로 get-secret-value, 키를 꺼낸다. 없거나 JSON 아니면 원문 없는 오류", async () => {
  const cli = fakeCli();
  const own = { AWS_REGION: "ap-northeast-2", PATH: "/bin" };
  assert.equal(await readTunnelToken({ secretId: "platform/shop-tunnels", key: "targetToken", region: "ap-northeast-2" }, cli.exec, own), TUNNEL);
  assert.equal(cli.calls[0]!.env, own);
  assert.deepEqual(cli.calls[0]!.args.slice(0, 4), ["secretsmanager", "get-secret-value", "--secret-id", "platform/shop-tunnels"]);
  const bad = fakeCli({ tunnelOut: { code: 0, stdout: `not-json ${TUNNEL}` } });
  await assert.rejects(readTunnelToken({ secretId: "s", key: "targetToken", region: "r" }, bad.exec), (e: Error) => { noToken(e.message); return /JSON/.test(e.message); });
  const nokey = fakeCli({ tunnelOut: { code: 0, stdout: JSON.stringify({ sourceToken: TUNNEL }) } });
  await assert.rejects(readTunnelToken({ secretId: "s", key: "targetToken", region: "r" }, nokey.exec), (e: Error) => { noToken(e.message); return /targetToken/.test(e.message); });
});

test("출처 env: 둘 다 있어야 켜진다. 리전 기본은 서울", () => {
  assert.equal(tunnelSourceFromEnv({}), null);
  assert.equal(tunnelSourceFromEnv({ TARGET_TUNNEL_SECRET_ID: "platform/shop-tunnels", TARGET_TUNNEL_SECRET_KEY: " " }), null);
  assert.deepEqual(tunnelSourceFromEnv({ TARGET_TUNNEL_SECRET_ID: "platform/shop-tunnels", TARGET_TUNNEL_SECRET_KEY: "targetToken" }),
    { secretId: "platform/shop-tunnels", key: "targetToken", region: "ap-northeast-2" });
});

test("출처 env 가 비면 터널 그릇은 안 채우고(no_source), 예전처럼 검사에서 paused(SECRET_VALUES_MISSING)", async () => {
  const saved = { id: process.env.TARGET_TUNNEL_SECRET_ID, key: process.env.TARGET_TUNNEL_SECRET_KEY, ep: process.env.TRAFFIC_METRICS_ENDPOINT };
  delete process.env.TARGET_TUNNEL_SECRET_ID; delete process.env.TARGET_TUNNEL_SECRET_KEY; delete process.env.TRAFFIC_METRICS_ENDPOINT;
  const i = input("gcp");
  const shopDb = keysOf(i).filter((k) => !k.endsWith("cloudflared-token"));
  const cli = fakeCli({ filled: shopDb });
  setSecretValueExec(cli.exec);
  setIngressSecretSources({ metric: fakeMetric() });   // 터널은 진짜 출처 길(env) 그대로
  try {
    const r = await ingressSecretFill(job, mig, i);
    assert.deepEqual(r?.skipped, [{ name: "cloudflared-token", why: "no_source" }]);
    assert.ok(!cli.calls.some((c) => c.args.includes("get-secret-value") || c.args.includes("add")));
    const out = await secretValuesGate(i);
    assert.equal(out?.failureCode, "SECRET_VALUES_MISSING");
    assert.deepEqual((out?.detail as any).deploy.missing, ["app-shop-api-cloudflared-token"]);
  } finally {
    setSecretValueExec(undefined); setIngressSecretSources(undefined);
    for (const [k, v] of [["TARGET_TUNNEL_SECRET_ID", saved.id], ["TARGET_TUNNEL_SECRET_KEY", saved.key], ["TRAFFIC_METRICS_ENDPOINT", saved.ep]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("쓰기 오류 문장에서 토큰 원문·JSON 을 지운다", async () => {
  let file = "";
  const exec: Exec = async (_c, args) => { const d = dataFileOf(args); file = d.file!; return { code: 1, stdout: "", stderr: `bad input ${d.data} / ${TUNNEL}`, ms: 1 }; };
  await assert.rejects(writeIngressSecret({ remoteKey: "k", token: TUNNEL }, exec), (e: Error) => { noToken(e.message); return /\*\*\*/.test(e.message); });
  assert.equal(existsSync(file), false, "실패해도 임시 파일을 지운다");
});

// ---- deploy 배선용 입력 ----
const job = { tenantId: "9f8e7d6c-0000-4000-8000-000000000001", migrationId: "4a8c0000-0000-4000-8000-000000000001", requestId: "r" } as unknown as MigrationJob;
const mig = { id: job.migrationId, targetEnvId: "33333333-3333-4333-8333-333333333333" } as unknown as MigrationRow;
function input(provider: "gcp" | "aws"): DeployInput {
  const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000001", migrationId: job.migrationId,
    spec: ONE, target: { envId: mig.targetEnvId, provider, region: "default" }, precheck: stubPrecheck(), now: new Date() });
  return { tenantId: job.tenantId, spec: ONE, plan, target: { envId: mig.targetEnvId, provider, region: "default", accountId: "demo-project" }, tfOutputs: {} };
}
const keysOf = (i: DeployInput) => ((approvedValues(i).externalSecrets as { secrets: Array<{ remoteKey: string }> }).secrets).map((s) => s.remoteKey);

