// Z39: 통제 12개 증거 수집기 + 작업 단계 임시 역할 요청 + 장부 만료 처리
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  CONTROLS, controlMatrix, createTempRoleBroker, loadPermissionSet, memoryLedger, mockIssuer, readEvidenceFiles,
  STEP_ROLE_MAX_ACTIONS, STEP_ROLES, stepActions, tfBlocks, type AuditRecord, type EvidenceFiles,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const G = "33333333-3333-4333-8333-333333333333";
const M = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-07T01:00:00Z");
const CHAIN_OK = { ok: true, checked: 12, partial: false, brokenAtSeq: null };

const files = () => readEvidenceFiles(ROOT);
const edit = (f: EvidenceFiles, k: keyof EvidenceFiles, fn: (s: string) => string): EvidenceFiles =>
  ({ ...f, [k]: { ...f[k], text: fn(f[k].text!) } });
const cell = (cs: ReturnType<typeof controlMatrix>, side: string, id: string) => {
  const c = cs.find((x) => x.side === side && x.controlId === id); assert.ok(c, `${side} ${id}`); return c;
};
const awsGcp = (f: EvidenceFiles, chain: typeof CHAIN_OK | { ok: false; checked: number; partial: boolean; brokenAtSeq: number } = CHAIN_OK) =>
  controlMatrix(f, [{ side: "source", envId: A, envKind: "aws" }, { side: "target", envId: G, envKind: "gcp" }], { now: NOW, auditChain: chain });

test("레포 파일 20개를 다 읽는다 (빠진 파일 0)", () => {
  const f = files();
  const missing = Object.entries(f).filter(([, v]) => v.text === null).map(([, v]) => v.path);
  assert.deepEqual(missing, []);
});

test("AWS→GCP 매트릭스: 24칸, 지금 레포 기준 판정이 고정된다", () => {
  const cs = awsGcp(files());
  assert.equal(cs.length, CONTROLS.length * 2);
  const by = (side: string) => Object.fromEntries(cs.filter((c) => c.side === side).map((c) => [c.controlId, c.state]));
  assert.deepEqual(by("source"), {
    "SEC-IAM-01": "unknown", "SEC-IAM-02": "pass", "SEC-IAM-03": "fail", "SEC-ENC-01": "pass", "SEC-ENC-02": "pass",
    "SEC-ENC-03": "pass", "SEC-AUD-01": "fail", "SEC-AUD-02": "pass", "SEC-VIO-01": "fail", "SEC-VIO-02": "unknown",
    "SEC-VIO-03": "fail", "SEC-VIO-04": "unknown",
  });
  assert.deepEqual(by("target"), { ...by("source"), "SEC-AUD-01": "pass" });   // GKE 는 관리 활동 감사 로그가 기본
  assert.equal(cell(cs, "source", "SEC-AUD-02").basis, "measured");
  assert.equal(cell(cs, "source", "SEC-IAM-02").basis, "static");
  assert.equal(cell(cs, "source", "SEC-IAM-01").basis, "none");
  assert.match(cell(cs, "source", "SEC-VIO-01").reason, /EKS API 공개\(대역 제한 없음\) true/);
  assert.ok(cell(cs, "source", "SEC-VIO-01").files.includes("infra/modules/aws/env/main.tf"));
});

test("파일을 고치면 칸이 바뀐다: 와일드카드 → IAM-02 위반, 토큰 마운트 끔 → IAM-03 통과, EKS 감사 로그 → AUD-01 통과", () => {
  const f0 = files();
  const wild = edit(f0, "awsSessApply", (s) => s.replace('"ec2:CreateTags"', '"ec2:*"'));
  assert.equal(cell(awsGcp(wild), "source", "SEC-IAM-02").state, "fail");
  assert.equal(cell(awsGcp(wild), "target", "SEC-IAM-02").state, "pass");   // GCP 쪽 파일은 그대로
  const sa = edit(f0, "chartSa", (s) => `${s}\nautomountServiceAccountToken: false\n`);
  assert.equal(cell(awsGcp(sa), "target", "SEC-IAM-03").state, "pass");
  const logs = edit(f0, "awsEnvTf", (s) => s.replace("role_arn = aws_iam_role.cluster[0].arn",
    'role_arn = aws_iam_role.cluster[0].arn\n  enabled_cluster_log_types = ["api", "audit"]'));
  assert.equal(cell(awsGcp(logs), "source", "SEC-AUD-01").state, "pass");
});

test("파일이 없으면 모름 (가짜 통과 없음), 감사 체인이 끊기면 AUD-02 위반", () => {
  const f0 = files();
  const gone = { ...f0, chartDeploy: { ...f0.chartDeploy, text: null } };
  const c = cell(awsGcp(gone), "source", "SEC-VIO-03");
  assert.equal(c.state, "unknown");
  assert.match(c.reason, /파일 없음/);
  const broken = awsGcp(f0, { ok: false, checked: 5, partial: false, brokenAtSeq: 3 });
  assert.equal(cell(broken, "target", "SEC-AUD-02").state, "fail");
  assert.match(cell(broken, "target", "SEC-AUD-02").reason, /seq 3/);
  const noChain = controlMatrix(f0, [{ side: "source", envId: A, envKind: "aws" }], { now: NOW, auditChain: null });
  assert.equal(cell(noChain, "source", "SEC-AUD-02").state, "unknown");
});

test("Azure Mock 은 12칸 전부 해당 없음, 온프레는 데모 db-expose 0.0.0.0/0 을 잡는다", () => {
  const cs = controlMatrix(files(), [{ side: "source", envId: A, envKind: "onprem" }, { side: "target", envId: G, envKind: "azure_mock" }],
    { now: NOW, auditChain: CHAIN_OK });
  assert.ok(cs.filter((c) => c.side === "target").every((c) => c.state === "not_applicable"));
  assert.equal(cell(cs, "source", "SEC-VIO-01").state, "fail");
  assert.match(cell(cs, "source", "SEC-VIO-01").reason, /db-expose/);
  assert.equal(cell(cs, "source", "SEC-IAM-01").state, "unknown");   // 사람 확인(attest) 기록 없음
});

test("tfBlocks: 중괄호 짝으로 resource 블록을 자른다", () => {
  const tf = 'resource "a_b" "x" {\n  k = 1\n  n { y = 2 }\n}\nresource "a_b" "z" { k = 3 }\n';
  const bs = tfBlocks(tf, "a_b");
  assert.equal(bs.length, 2);
  assert.ok(bs[0]!.includes("n { y = 2 }") && bs[0]!.endsWith("}") && !bs[0]!.includes("k = 3"));
  assert.ok(bs[1]!.includes("k = 3"));
});

test("단계별 요청 동작: 권한 파일에서 뽑고, 50개 이하, 중개자 검사를 전부 통과한다", async () => {
  const perms = loadPermissionSet(PERM_DIR);
  const log: AuditRecord[] = [];
  const broker = createTempRoleBroker({
    issuers: { aws: mockIssuer("aws"), gcp: mockIssuer("gcp"), onprem: mockIssuer("onprem"), azure_mock: mockIssuer("azure_mock") },
    permissions: perms, now: () => NOW, ledger: memoryLedger({ durable: true }),
    resolveEnv: async (_t, _e, p) => ({ roleRef: `svc-${p}` }),
    audit: async (_t, a) => { log.push(a); },
  });
  let n = 0;
  for (const provider of ["aws", "gcp", "onprem"] as const) {
    for (const [step, roles] of Object.entries(STEP_ROLES)) for (const r of roles) {
      const stage = "stage" in r ? r.stage : undefined;
      const actions = stepActions(perms, provider, r.purpose, stage);
      assert.ok(actions.length > 0 && actions.length <= STEP_ROLE_MAX_ACTIONS, `${provider} ${step} ${actions.length}`);
      await broker.issue({ tenantId: T, envId: A, provider, purpose: r.purpose, ...(r.purpose === "operate" ? { migrationId: M } : {}),
        ...(stage ? { stage } : {}), actions, ttlSec: 900 }, { step });
      n++;
    }
  }
  assert.equal(log.filter((a) => a.action === "temp_role.issued").length, n);
  assert.equal(log.filter((a) => a.action === "temp_role.denied").length, 0);
  assert.equal(log[0]!.detail!.step, "precheck");
  assert.deepEqual(stepActions(perms, "azure_mock", "operate", "apply"), []);
  assert.deepEqual(stepActions(null, "aws", "operate", "apply"), []);
  assert.ok(stepActions(perms, "aws", "operate", "plan").every((a) => /:(Describe|Get|List)/.test(a)));
});

// ID-8: 장부·감사에 남는 동작 목록이 세션 정책과 같다 (예전엔 50개에서 잘려 66개 중 앞 50개만 남았다)
test("ID-8: AWS 단계 요청 동작 = 세션 정책 동작 전체 (안 잘림), 정리 단계는 아무 자격도 안 빌림", () => {
  const perms = loadPermissionSet(PERM_DIR);
  for (const st of ["plan", "apply", "destroy"] as const) {
    const doc = JSON.parse(perms.aws.sessionPolicies[st]) as { Statement: Array<{ Action: string[] }> };
    const all = new Set(doc.Statement.flatMap((s) => s.Action));
    assert.equal(stepActions(perms, "aws", "operate", st).length, all.size, st);
  }
  assert.ok(stepActions(perms, "aws", "operate", "apply").length > 50, "apply 는 50개를 넘는다 (잘리면 이 시험이 잡는다)");
  assert.deepEqual(STEP_ROLES.cleanup, []);
});

test("장부 만료 처리: 만료 시각이 지나면 sweep 이 expired 로 닫고 감사는 한 번만, 회수 증거에서 빠진다", async () => {
  let now = NOW;
  const ledger = memoryLedger({ durable: true });
  const log: AuditRecord[] = [];
  const mk = (owner: string) => createTempRoleBroker({
    issuers: { aws: mockIssuer("aws") }, permissions: loadPermissionSet(PERM_DIR), now: () => now, ledger, owner,
    resolveEnv: async () => ({ roleRef: "svc-operate" }), audit: async (_t, a) => { log.push(a); },
  });
  const a = mk("worker-a"), b = mk("worker-b");
  const c = await a.issue({ tenantId: T, envId: A, provider: "aws", purpose: "operate", stage: "apply", migrationId: M,
    actions: ["rds:CreateDBInstance"], ttlSec: 900 }, { step: "apply" });
  const row = ledger.rows.get(c.credentialRef)!;
  assert.deepEqual([row.step, row.actionsCount, row.requestedTtlSec, row.stub], ["apply", 1, 900, true]);
  now = new Date(NOW.getTime() + 901_000);
  // 워커 a 가 죽었다고 치고 b 가 정리: 만료 줄은 회수 요청 없이 expired 로 닫힌다 → 증거 true
  const r = await b.revokeForMigration(T, M, "cleanup");
  assert.equal(row.status, "expired");
  assert.deepEqual([r.requested, r.stillActive, r.evidence.operateRoleRevoked], [0, 0, true]);
  await a.sweep();
  assert.equal(log.filter((x) => x.action === "temp_role.expired").length, 2);   // b 가 닫은 감사 1 + a 보관함 청소 1 (같은 참조)
  assert.equal(log.filter((x) => x.action === "temp_role.expired" && x.detail?.closedBy === "worker-b").length, 1);
});

// 세션 정책 줄이기: 보내는 판은 실효 권한(∩ 천장)이 원문과 같고, 상한 2,048자보다 300자 이상 짧다
import { compactSessionPolicy, compactActions } from "../src/permissions.js";
const expand = (pats: string[], universe: string[]) => universe.filter((u) => pats.some((p) => new RegExp("^" + p.replace(/\*/g, ".*") + "$", "i").test(u)));
test("세션 정책 줄이기 정상: 단계마다 보내는 판 ≤ 1748자, 천장 안에서 펼치면 원래 동작과 똑같다", () => {
  const perms = loadPermissionSet(PERM_DIR);
  for (const st of ["plan", "apply", "destroy"] as const) {
    const explicit = JSON.parse(perms.aws.sessionPolicies[st]).Statement[0].Action as string[];
    const wire = compactSessionPolicy(perms.aws.sessionPolicies[st], perms.aws.ceiling);
    assert.ok(wire.length <= 2048 - 300, `${st} ${wire.length}`);
    const pats = JSON.parse(wire).Statement[0].Action as string[];
    assert.deepEqual(expand(pats, perms.aws.ceiling).sort(), [...explicit].sort(), st);
  }
});
test("세션 정책 줄이기 거부: 천장에 목록 밖 동작이 걸리는 앞글자로는 안 묶는다 (plan 은 Delete 를 못 얻는다)", () => {
  const ceiling = ["rds:DescribeDBInstances", "rds:DeleteDBInstance", "rds:DescribeDBSubnetGroups"];
  const packed = compactActions(["rds:DescribeDBInstances", "rds:DescribeDBSubnetGroups"], ceiling);
  assert.ok(!packed.includes("rds:*") && !packed.includes("rds:D*"), packed.join());
  assert.deepEqual(expand(packed, ceiling).sort(), ["rds:DescribeDBInstances", "rds:DescribeDBSubnetGroups"]);
  const perms = loadPermissionSet(PERM_DIR);
  const plan = JSON.parse(compactSessionPolicy(perms.aws.sessionPolicies.plan, perms.aws.ceiling)).Statement[0].Action as string[];
  assert.deepEqual(expand(plan, perms.aws.ceiling).filter((a) => /:(Delete|Create|Modify|Put|GetSecretValue)/.test(a)), []);
});
