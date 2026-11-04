// pf-d APP-20 (ADR-072 유지): deploy 커밋 전에 도착 비밀 그릇에 값(버전)이 들었나 본다. 플랫폼은 값을 안 읽고 안 복사한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSecretValues } from "../src/gitops/secret-values.js";
import { secretValuesGate, setSecretValueExec } from "../src/jobs/deploy.js";
import { approvedValues, type DeployInput } from "../src/gitops/index.js";
import { ONE } from "./demo-one.js";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import type { Exec } from "@svc/adapters";

const fakeExec = (by: Record<string, { code: number; stdout?: string; stderr?: string }>, seen: string[][] = []): Exec => async (cmd, args) => {
  seen.push([cmd, ...args]);
  const key = cmd === "gcloud" ? args[3]! : args[args.indexOf("--secret-id") + 1]!;
  const r = by[key] ?? { code: 0, stdout: "" };
  return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: 1 };
};

test("APP-20: gcp 는 ENABLED 버전 이름이 있으면 값 있음, 비었거나 NOT_FOUND 면 빠짐, 그 밖 오류는 모름", async () => {
  const seen: string[][] = [];
  const r = await checkSecretValues({ provider: "gcp", keys: ["app-shop-a", "app-shop-b", "app-shop-c", "app-shop-d"], projectId: "p1", region: "x" }, fakeExec({
    "app-shop-a": { code: 0, stdout: "projects/1/secrets/app-shop-a/versions/1\n" },
    "app-shop-b": { code: 0, stdout: "" },
    "app-shop-c": { code: 1, stderr: "ERROR: (gcloud.secrets.versions.list) NOT_FOUND: Secret [app-shop-c] not found" },
    "app-shop-d": { code: 1, stderr: "ERROR: PERMISSION_DENIED" },
  }, seen));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["app-shop-b", "app-shop-c"]);
  assert.deepEqual(r.unknown.map((u) => u.key), ["app-shop-d"]);
  assert.ok(seen[0]!.includes("--project=p1") && seen[0]!.includes("--filter=state:ENABLED"));
  assert.ok(!seen.flat().some((a) => /access|get-secret-value/.test(a)), "값을 읽는 명령은 안 씀");
});

test("APP-20: aws 는 AWSCURRENT 버전이 있으면 값 있음 (ResourceNotFound 는 빠짐)", async () => {
  const r = await checkSecretValues({ provider: "aws", keys: ["platform/t/shop/a", "platform/t/shop/b"], region: "ap-northeast-2" }, fakeExec({
    "platform/t/shop/a": { code: 0, stdout: "abc-123\n" },
    "platform/t/shop/b": { code: 254, stderr: "An error occurred (ResourceNotFoundException)" },
  }));
  assert.deepEqual(r.missing, ["platform/t/shop/b"]);
  assert.equal((await checkSecretValues({ provider: "aws", keys: ["platform/t/shop/a"], region: "ap-northeast-2" }, fakeExec({ "platform/t/shop/a": { code: 0, stdout: "v1" } }))).ok, true);
});

const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000001", migrationId: "4a8c0000-0000-4000-8000-000000000001",
  spec: ONE, target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", region: "default" }, precheck: stubPrecheck(), now: new Date() });
const input: DeployInput = { tenantId: "9f8e7d6c-0000-4000-8000-000000000001", spec: ONE, plan,
  target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", region: "default", accountId: "demo-project" }, tfOutputs: {} };
const keysOf = () => ((approvedValues(input).externalSecrets as { secrets: Array<{ remoteKey: string }> }).secrets).map((s) => s.remoteKey);

test("APP-20 거부: deploy 는 값 없는 그릇이 있으면 커밋 전에 paused(SECRET_VALUES_MISSING) + 그릇 이름", async () => {
  const keys = keysOf();
  assert.ok(keys.length > 0, "데모 명세에 비밀이 있어야 시험이 뜻이 있음");
  setSecretValueExec(fakeExec({ ...Object.fromEntries(keys.map((k) => [k, { code: 0, stdout: "v/1" }])), [keys[0]!]: { code: 0, stdout: "" } }));
  try {
    const out = await secretValuesGate(input);
    assert.equal(out?.to, "paused");
    assert.equal(out?.failureCode, "SECRET_VALUES_MISSING");
    assert.deepEqual((out?.detail as any).deploy.missing, [keys[0]]);
  } finally { setSecretValueExec(undefined); }
});

test("APP-20: 모든 그릇에 값이 있으면 막지 않음 (null), 온프레는 안 봄", async () => {
  setSecretValueExec(fakeExec(Object.fromEntries(keysOf().map((k) => [k, { code: 0, stdout: "v/1" }]))));
  try {
    assert.equal(await secretValuesGate(input), null);
    assert.equal(await secretValuesGate({ ...input, target: { ...input.target, provider: "onprem" } }), null);
  } finally { setSecretValueExec(undefined); }
});
