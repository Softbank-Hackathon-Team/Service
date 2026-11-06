// pf-d APP-20 (ADR-072 유지): deploy 커밋 전에 도착 비밀 그릇에 값(버전)이 들었나 본다. 플랫폼은 값을 안 읽고 안 복사한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSecretValues } from "../src/gitops/secret-values.js";
import { targetCliEnv, secretValuesGate, setSecretValueExec } from "../src/jobs/deploy.js";
import { approvedValues, type DeployInput } from "../src/gitops/index.js";
import { ONE } from "./demo-one.js";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import type { Exec } from "@svc/adapters";

const fakeExec = (by: Record<string, { code: number; stdout?: string; stderr?: string }>, seen: string[][] = []): Exec => async (cmd, args) => {
  seen.push([cmd, ...args]);
  const key = cmd === "gcloud" ? args.find((a) => a.startsWith("--secret="))!.slice("--secret=".length) : args[args.indexOf("--secret-id") + 1]!;
  const r = by[key] ?? { code: 0, stdout: "" };
  return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: 1 };
};

test("APP-20: gcp 는 최신 버전이 ENABLED 면 값 있음, 꺼졌거나 NOT_FOUND 면 빠짐, 그 밖 오류는 모름", async () => {
  const seen: string[][] = [];
  const r = await checkSecretValues({ provider: "gcp", keys: ["app-shop-a", "app-shop-b", "app-shop-c", "app-shop-d"], projectId: "p1", region: "x" }, fakeExec({
    "app-shop-a": { code: 0, stdout: "ENABLED\n" },
    "app-shop-b": { code: 0, stdout: "DISABLED\n" },
    "app-shop-c": { code: 1, stderr: "ERROR: (gcloud.secrets.versions.describe) NOT_FOUND: Secret [app-shop-c] not found" },
    "app-shop-d": { code: 1, stderr: "ERROR: PERMISSION_DENIED" },
  }, seen));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["app-shop-b", "app-shop-c"]);
  assert.deepEqual(r.unknown.map((u) => u.key), ["app-shop-d"]);
  assert.ok(seen[0]!.includes("--project=p1") && seen[0]!.includes("describe"));
  assert.ok(!seen.flat().some((a) => /access|get-secret-value/.test(a)), "값을 읽는 명령은 안 씀");
});

test("APP-20: aws 는 AWSCURRENT 버전이 있으면 값 있음. 없거나, 지우는 중이거나, ResourceNotFound 면 빠짐", async () => {
  const seen: string[][] = [];
  const r = await checkSecretValues({ provider: "aws", keys: ["platform/t/shop/a", "platform/t/shop/b", "platform/t/shop/c", "platform/t/shop/d"], region: "ap-northeast-2" }, fakeExec({
    "platform/t/shop/a": { code: 0, stdout: JSON.stringify({ deleted: null, stages: { v1: ["AWSCURRENT"] } }) },
    "platform/t/shop/b": { code: 254, stderr: "An error occurred (ResourceNotFoundException)" },
    "platform/t/shop/c": { code: 0, stdout: JSON.stringify({ deleted: null, stages: null }) },
    "platform/t/shop/d": { code: 0, stdout: JSON.stringify({ deleted: "2026-11-06", stages: { v1: ["AWSCURRENT"] } }) },
  }, seen));
  assert.deepEqual(r.missing, ["platform/t/shop/b", "platform/t/shop/c", "platform/t/shop/d"]);
  assert.ok(seen.every((a) => a.includes("describe-secret")), "고객 실행 역할에 있는 권한만 쓴다");
  assert.ok(!seen.flat().some((a) => /get-secret-value/.test(a)), "값을 읽는 명령은 안 씀");
});

test("점검 환경: 빌린 자격만 쓰고 worker 자기 자격은 빠진다. 빌린 게 없으면(흉내) 그대로", () => {
  const base = { PATH: "/bin", AWS_PROFILE: "me", AWS_ROLE_ARN: "worker", AWS_WEB_IDENTITY_TOKEN_FILE: "/t", GOOGLE_APPLICATION_CREDENTIALS: "/f", CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/worker.json" };
  const aws = targetCliEnv({ awsEnv: { target: { AWS_CONFIG_FILE: "/c" } } }, "1", base)!;
  assert.equal(aws.AWS_PROFILE, undefined);
  assert.equal(aws.AWS_ROLE_ARN, undefined);
  assert.equal(aws.AWS_WEB_IDENTITY_TOKEN_FILE, undefined);
  assert.equal(aws.AWS_CONFIG_FILE, "/c");
  const gcp = targetCliEnv({ gcpToken: { target: "tok" } }, "proj", base)!;
  assert.equal(gcp.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok");
  assert.equal(gcp.CLOUDSDK_CORE_PROJECT, "proj");
  assert.equal(gcp.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, undefined);
  assert.equal(targetCliEnv({ gcpToken: { source: "other" } }, "p", base), undefined, "출발 토큰은 안 쓴다");
});

test("점검 env 가 CLI 까지 간다", async () => {
  let seen: NodeJS.ProcessEnv | undefined;
  const exec: Exec = async (_c, _a, o) => { seen = o.env; return { code: 0, stdout: "ENABLED", stderr: "", ms: 1 }; };
  await checkSecretValues({ provider: "gcp", keys: ["k"], region: "x", env: { CLOUDSDK_AUTH_ACCESS_TOKEN: "tok" } }, exec);
  assert.equal(seen?.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok");
});

const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000001", migrationId: "4a8c0000-0000-4000-8000-000000000001",
  spec: ONE, target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", region: "default" }, precheck: stubPrecheck(), now: new Date() });
const input: DeployInput = { tenantId: "9f8e7d6c-0000-4000-8000-000000000001", spec: ONE, plan,
  target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", region: "default", accountId: "demo-project" }, tfOutputs: {} };
const keysOf = () => ((approvedValues(input).externalSecrets as { secrets: Array<{ remoteKey: string }> }).secrets).map((s) => s.remoteKey);

test("APP-20 거부: deploy 는 값 없는 그릇이 있으면 커밋 전에 paused(SECRET_VALUES_MISSING) + 그릇 이름", async () => {
  const keys = keysOf();
  assert.ok(keys.length > 0, "데모 명세에 비밀이 있어야 시험이 뜻이 있음");
  setSecretValueExec(fakeExec({ ...Object.fromEntries(keys.map((k) => [k, { code: 0, stdout: "ENABLED" }])), [keys[0]!]: { code: 0, stdout: "" } }));
  try {
    const out = await secretValuesGate(input);
    assert.equal(out?.to, "paused");
    assert.equal(out?.failureCode, "SECRET_VALUES_MISSING");
    assert.deepEqual((out?.detail as any).deploy.missing, [keys[0]]);
  } finally { setSecretValueExec(undefined); }
});

test("APP-20: 모든 그릇에 값이 있으면 막지 않음 (null), 온프레는 안 봄", async () => {
  setSecretValueExec(fakeExec(Object.fromEntries(keysOf().map((k) => [k, { code: 0, stdout: "ENABLED" }]))));
  try {
    assert.equal(await secretValuesGate(input), null);
    assert.equal(await secretValuesGate({ ...input, target: { ...input.target, provider: "onprem" } }), null);
  } finally { setSecretValueExec(undefined); }
});
