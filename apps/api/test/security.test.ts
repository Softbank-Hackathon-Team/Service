// 보안 표: 파일 스캔·비밀값 찾기·표 조립·경로. DB 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { canonical, sha256, NotFound } from "@svc/core";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { securityRoutes } from "../src/routes/security.js";
import { buildSecurityView, type SecurityInput } from "../src/security/build.js";
import { loadConfig, loadFileInputs } from "../src/security/load.js";
import { scanAwsPermissions, scanChart, scanOnpremPermissions, scanSecrets, urlHasPassword } from "../src/security/scan.js";
import { SecurityView } from "../src/security/schema.js";
import type { AuditRow } from "../src/report/schema.js";

const T = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const NOW = new Date(Date.UTC(2026, 10, 7, 3, 30, 0));
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 3, 0, s)).toISOString();

function chainOf(xs: { action: string; detail?: Record<string, unknown>; result?: "ok" | "denied" | "error" }[]): AuditRow[] {
  let prev = "genesis";
  return xs.map((x, i) => {
    const a = { actor: "worker", action: x.action, target: M, result: x.result ?? "ok", ...(x.detail ? { detail: x.detail } : {}) };
    const hash = sha256(canonical({ ...a, tenantId: T, prevHash: prev }));
    const row: AuditRow = { seq: i + 1, tenantId: T, at: at(i), actor: "worker", action: x.action, target: M,
      result: a.result, detail: x.detail ?? {}, prevHash: prev, hash };
    prev = hash;
    return row;
  });
}

function input(over: Partial<SecurityInput> = {}): SecurityInput {
  const chain = chainOf([
    { action: "migration.importing", detail: { from: "draft", to: "importing" } },
    { action: "temp_role.issued", detail: { credentialRef: "cred/aws/x", provider: "aws" } },
    { action: "cleanup.completed", detail: { from: "cleanup", to: "completed", evidence: { tempResources: 0, operateRoleRevoked: true } } },
  ]);
  return {
    migration: { id: M, status: "completed" },
    envs: [{ side: "source", provider: "onprem", hasExternalId: false }, { side: "target", provider: "aws", hasExternalId: true }],
    events: chain, chain, chainFromGenesis: true,
    ledger: [{ credentialRef: "cred/aws/x", provider: "aws", purpose: "operate", stage: "apply", status: "revoked",
      issuedAt: at(1), expiresAt: new Date(Date.parse(at(1)) + 900_000).toISOString(), revokedAt: at(2) }],
    ledgerValueColumns: [],
    privileges: { auditUpdate: false, auditDelete: false, ledgerDelete: false },
    ...loadFileInputs(),
    secrets: scanSecrets(chain.map((e) => ({ where: `audit#${e.seq}`, value: e.detail }))),
    config: { authMode: "dev_header", replConfigured: false, replPeerPassword: { source: null, target: null } },
    now: () => NOW,
    ...over,
  };
}
const byId = (v: ReturnType<typeof buildSecurityView>, id: string) => {
  const r = v.rows.find((x) => x.id === id); assert.ok(r, `row ${id}`); return r;
};

test("레포 권한 파일을 읽는다: AWS 천장·세션 정책 3개, GCP, 온프레", () => {
  const f = loadFileInputs();
  assert.ok(f.permissions.aws && f.permissions.gcp && f.permissions.onprem, "infra/permissions 3종이 읽혀야 한다");
  assert.equal(f.permissions.aws.wildcard.length, 0);
  assert.equal(f.permissions.aws.sessions.length, 3);
  for (const s of f.permissions.aws.sessions) { assert.equal(s.error, null); assert.ok(s.chars <= s.limit); }
  assert.ok(f.chart, "gitops/charts/app 차트가 읽혀야 한다");
  assert.equal(f.chart.dbPasswordFromSecret, true);
});

test("AWS 스캔: 경계 조건 없는 PutRolePolicy 는 잡고, 조건 있으면 통과", () => {
  const pol = (cond?: object) => JSON.stringify({ Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["iam:PutRolePolicy", "iam:GetRole"], Resource: "arn:aws:iam::*:role/app-*", ...(cond ? { Condition: cond } : {}) },
    { Effect: "Allow", Action: ["ec2:RunInstances", "ec2:DescribeInstances"], Resource: "*" },
  ] });
  const bad = scanAwsPermissions(pol(), {});
  assert.deepEqual(bad.escalationWithoutBoundary, ["iam:PutRolePolicy"]);
  assert.equal(bad.writesOnAnyResource, 1);   // RunInstances 만 (Describe 는 읽기)
  const good = scanAwsPermissions(pol({ StringEquals: { "iam:PermissionsBoundary": "arn:aws:iam::1:policy/b" } }), {});
  assert.deepEqual(good.escalationWithoutBoundary, []);
  // 천장 밖 동작이 든 세션 정책 → ROLE_OUTSIDE_CEILING
  const s = scanAwsPermissions(pol(), { plan: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }) });
  assert.equal(s.sessions[0]!.error, "ROLE_OUTSIDE_CEILING");
});

test("온프레 스캔: 바인딩 없는 ClusterRole 은 전부 클러스터 전체, RoleBinding 전용 역할(G3 모양)은 뺀다", () => {
  const role = (n: string, res: string) => `kind: ClusterRole\nmetadata:\n  name: ${n}\nrules:\n  - apiGroups: ["apps"]\n    resources: ["${res}"]\n    verbs: ["create", "get"]\n`;
  const ns = `kind: ClusterRole\nmetadata:\n  name: ns\nrules:\n  - apiGroups: [""]\n    resources: ["namespaces"]\n    verbs: ["create"]\n`;
  const crb = `kind: ClusterRoleBinding\nmetadata:\n  name: ns\nroleRef:\n  kind: ClusterRole\n  name: ns\n`;
  assert.equal(scanOnpremPermissions(role("all", "deployments")).clusterWideAppWrites, 1);
  const g3 = scanOnpremPermissions([ns, role("app", "deployments"), crb].join("---\n"));
  assert.deepEqual(g3.boundClusterWide, ["ns"]);
  assert.equal(g3.clusterWideAppWrites, 0);
});

test("표 조립: Pod 칸은 도착 기준 — 도착이 Azure Mock 이면 n_a", () => {
  const v = buildSecurityView(input({ envs: [{ side: "source", provider: "aws", hasExternalId: true }, { side: "target", provider: "azure_mock", hasExternalId: false }] }));
  assert.equal(byId(v, "RT-POD").state, "n_a");
  assert.ok(!v.rows.some((r) => r.id === "RT-SATOKEN"));
  const w = buildSecurityView(input());
  assert.equal(byId(w, "RT-POD").scope, "도착 aws");
});

test("차트 스캔: securityContext·평문 비밀 env", () => {
  const dep = `containers:\n  - name: app\n    securityContext: { runAsNonRoot: true }\n    env:\n      - { name: "API_TOKEN", value: "x" }\n`;
  const c = scanChart(dep, "automountServiceAccountToken: false");
  assert.equal(c.securityContext && c.runAsNonRoot && c.automountTokenOff, true);
  assert.deepEqual(c.literalSecretEnv, ["API_TOKEN"]);
  assert.equal(c.dbPasswordFromSecret, null);
});

test("비밀값 찾기: 패턴·키 이름은 잡고, 가린 값·참조 이름은 안 잡는다", () => {
  const hit = scanSecrets([{ where: "d", value: {
    a: "AKIA" + "ABCDEFGHIJKLMNOP", url: "postgres://u:hunter2@h:5432/db", password: "pw1",
    nested: [{ token: "t" }], key: "-----BEGIN RSA PRIVATE KEY-----" } }]);
  assert.deepEqual(hit.hits.map((h) => h.kind).sort(),
    ["aws_access_key", "private_key", "secret_field", "secret_field", "url_password"]);
  const clean = scanSecrets([{ where: "d", value: {
    credentialRef: "cred/aws/svc-operate-1", password: "[redacted]", url: "postgres://u@h/db", roleRef: "arn:aws:iam::x:role/r" } }]);
  assert.equal(clean.hits.length, 0);
  assert.equal(clean.scannedStrings, 4);
});

test("접속 문자열 비밀번호 여부만 본다 (값은 안 돌려줌)", () => {
  assert.equal(urlHasPassword("postgres://a:b@h/d"), true);
  assert.equal(urlHasPassword("postgres://a@h/d"), false);
  assert.equal(urlHasPassword(undefined), null);
  const c = loadConfig({ REPL_SOURCE_URL: "postgres://a:b@h/d", REPL_TARGET_URL: "postgres://a@h/d", AUTH_MODE: "real" });
  assert.deepEqual(c, { authMode: "real", replConfigured: true, replPeerPassword: { source: true, target: false } });
});

test("표 조립: 정상 이전 → 장부·회수·체인·비밀값 ok, k3d warn, 통제 매트릭스 미구현", () => {
  const v = SecurityView.parse(buildSecurityView(input()));
  assert.equal(byId(v, "TC-LEDGER").state, "ok");
  assert.equal(byId(v, "TC-TTL").value, "최대 900초 (기준 900초)");
  assert.equal(byId(v, "TC-REVOKED").state, "ok");
  assert.equal(byId(v, "TC-AUDIT").state, "ok");
  assert.equal(byId(v, "AU-CHAIN").state, "ok");
  assert.equal(byId(v, "AU-CHAIN").value, "3줄 다시 계산 · 끊김 0");
  assert.equal(byId(v, "SE-PLAINTEXT").state, "ok");
  assert.equal(byId(v, "RT-K3D").state, "warn");
  assert.equal(byId(v, "CT-MATRIX").state, "not_implemented");
  assert.equal(byId(v, "LP-EXTID-target").state, "ok");
  assert.equal(v.tempRoleAudit["temp_role.issued"], 1);
  const s = v.summary;
  assert.equal(s.ok + s.warn + s.fail + s.notImplemented + s.na, v.rows.length);
});

test("표 조립: 장부 표 없음 → 미구현, 끝난 이전에 살아 있는 실행 역할 → fail", () => {
  const none = buildSecurityView(input({ ledger: null, ledgerValueColumns: null }));
  assert.equal(byId(none, "TC-LEDGER").state, "not_implemented");
  assert.equal(byId(none, "SE-LEDGER").state, "not_implemented");
  assert.equal(none.ledger, null);
  const live = buildSecurityView(input({ ledger: [{ credentialRef: "c", provider: "aws", purpose: "operate", stage: "apply",
    status: "active", issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 600_000).toISOString(), revokedAt: null }] }));
  assert.equal(byId(live, "TC-LEDGER").state, "fail");
});

test("표 조립: 감사 한 줄을 고치면 체인 fail, 비밀값이 detail 에 있으면 fail (값은 응답에 없음)", () => {
  const base = input();
  const chain = base.chain.map((r) => ({ ...r }));
  chain[1] = { ...chain[1]!, detail: { ...chain[1]!.detail, provider: "gcp" } };
  const v = buildSecurityView({ ...base, chain });
  assert.equal(byId(v, "AU-CHAIN").state, "fail");
  assert.equal(v.auditChain.brokenAtSeq, 2);
  const secret = "postgres://repl:S3cretPw@src:5432/shop";
  const s = buildSecurityView({ ...base, secrets: scanSecrets([{ where: "audit#9", value: { peer: secret } }]) });
  assert.equal(byId(s, "SE-PLAINTEXT").state, "fail");
  assert.ok(!JSON.stringify(s).includes("S3cretPw"));
});

test("표 조립: 해당 없는 칸 — 온프레 없으면 k3d n_a, 실행 역할 발급 0이면 TC-AUDIT 해당 없음 (Z39: 단계 전), 장부 표 없으면 미구현", () => {
  const v = buildSecurityView(input({
    envs: [{ side: "source", provider: "aws", hasExternalId: false }, { side: "target", provider: "gcp", hasExternalId: false }],
    events: [], ledger: [], migration: { id: M, status: "awaiting_approval" } }));
  assert.equal(byId(v, "RT-K3D").state, "n_a");
  assert.equal(byId(v, "TC-AUDIT").state, "n_a");
  assert.equal(byId(buildSecurityView(input({ events: [], ledger: null, ledgerValueColumns: null })), "TC-AUDIT").state, "not_implemented");
  assert.equal(byId(v, "TC-REVOKED").state, "n_a");
  assert.equal(byId(v, "LP-EXTID-source").state, "warn");
  assert.ok(v.rows.some((r) => r.id === "LP-GCP-IAM"));
  assert.ok(!v.rows.some((r) => r.id === "LP-ONPREM"));
});

async function appWith(load: (t: string, m: string) => Promise<SecurityInput>) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(securityRoutes, { prefix: "/api/v1", load });
  return app;
}

test("경로: 200 + 계약 모양 + no-store, 남의 이전 404, 헤더 없으면 401, uuid 아니면 400", async () => {
  const app = await appWith(async (t, m) => { if (m !== M || t !== T) throw new NotFound("migration", m); return input(); });
  const ok = await app.inject({ url: `/api/v1/migrations/${M}/security`, headers: { "x-dev-tenant": T } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  SecurityView.parse(ok.json());
  const other = await app.inject({ url: `/api/v1/migrations/${M}/security`, headers: { "x-dev-tenant": "99999999-9999-4999-8999-999999999999" } });
  assert.equal(other.statusCode, 404);
  assert.equal((await app.inject({ url: `/api/v1/migrations/${M}/security` })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/v1/migrations/x/security`, headers: { "x-dev-tenant": T } })).statusCode, 400);
  await app.close();
});

// ── Z39 ──
const SRC = "22222222-2222-4222-8222-222222222222", DST = "33333333-3333-4333-8333-333333333333";
const withIds = (over: Partial<SecurityInput> = {}) => input({
  envs: [{ side: "source", provider: "aws", hasExternalId: false, envId: SRC }, { side: "target", provider: "gcp", hasExternalId: false, envId: DST }],
  ...over });

test("Z39 통제 매트릭스: 환경 번호가 있으면 24칸이 붙고 CT-MATRIX 는 위반(차트·감사 로그·공개 API), 미구현 아님", () => {
  const v = SecurityView.parse(buildSecurityView(withIds()));
  assert.equal(v.controlMatrix?.length, 24);
  const ct = byId(v, "CT-MATRIX");
  assert.equal(ct.state, "fail");
  assert.match(ct.value, /^출발 aws 통과 5 · 위반 4 · 모름 3 \/ 도착 gcp 통과 6 · 위반 3 · 모름 3/);
  assert.match(ct.value, /위반 통제 SEC-IAM-03, SEC-AUD-01, SEC-VIO-01, SEC-VIO-03/);
  const aud = v.controlMatrix!.find((c) => c.side === "target" && c.controlId === "SEC-AUD-02")!;
  assert.deepEqual([aud.state, aud.basis], ["pass", "measured"]);
  assert.match(aud.reason, /3줄 다시 계산/);   // 위 AU-CHAIN 과 같은 숫자
  assert.ok(!JSON.stringify(v.controlMatrix).includes(SRC), "환경 번호는 매트릭스 칸에 안 나간다");
});

test("Z39 통제 매트릭스: 체인이 끊기면 SEC-AUD-02 위반, Azure 도착은 12칸 해당 없음, 재료 없으면 미구현", () => {
  const base = withIds();
  const chain = base.chain.map((r) => ({ ...r }));
  chain[1] = { ...chain[1]!, detail: { ...chain[1]!.detail, provider: "gcp" } };
  const v = buildSecurityView({ ...base, chain });
  assert.equal(v.controlMatrix!.find((c) => c.side === "source" && c.controlId === "SEC-AUD-02")!.state, "fail");
  const az = buildSecurityView(input({ envs: [{ side: "source", provider: "aws", hasExternalId: false, envId: SRC },
    { side: "target", provider: "azure_mock", hasExternalId: false, envId: DST }] }));
  assert.ok(az.controlMatrix!.filter((c) => c.side === "target").every((c) => c.state === "not_applicable"));
  assert.match(byId(az, "CT-MATRIX").value, /도착 azure_mock 통과 0 · 위반 0 · 모름 0 · 해당 없음 12/);
  const none = buildSecurityView(withIds({ evidenceFiles: null }));
  assert.equal(byId(none, "CT-MATRIX").state, "not_implemented");
  assert.equal(none.controlMatrix, null);
});

test("Z39 장부: 만료 처리 줄과 단계 이름이 TC-LEDGER 에 나오고, 만료 처리된 실행 역할은 살아 있는 것으로 안 센다", () => {
  const v = buildSecurityView(withIds({ ledger: [
    { credentialRef: "a", provider: "aws", purpose: "observe", stage: null, status: "revoked", step: "precheck",
      issuedAt: at(0), expiresAt: at(9), revokedAt: at(1) },
    { credentialRef: "b", provider: "gcp", purpose: "operate", stage: "apply", status: "expired", step: "apply",
      issuedAt: at(1), expiresAt: at(2), revokedAt: null },
  ] }));
  const r = byId(v, "TC-LEDGER");
  assert.equal(r.state, "ok");
  assert.match(r.value, /^2건 · 활성 0 · 회수 요청 0 · 회수 1 · 만료 처리 1 · 만료됐는데 미처리 0 · 단계 precheck·apply$/);
  assert.equal(v.ledger![1]!.expiredButActive, false);
  const denied = buildSecurityView(withIds({ events: chainOf([{ action: "temp_role.denied", result: "denied" }]) }));
  assert.equal(byId(denied, "TC-AUDIT").state, "warn");
});
