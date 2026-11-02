// OBSROLE: 가져오기가 관찰 역할을 빌릴 때 요청하는 동작 목록 — 깃발 off 는 지금 그대로, v2 는 데이터 읽기가 더해지고 최소 권한 검사를 통과한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AWS_DATA_READ_ACTIONS, ECS_OBSERVE_ACTIONS, GCP_DATA_READ_PERMISSIONS } from "@svc/adapters";
import { checkLeastPrivilege } from "@svc/security";
import { IMPORT_GCP_OBSERVE_ACTIONS, IMPORT_OBSERVE_ACTIONS, importObserveActions } from "../src/jobs/import.js";

const withFlag = <T>(v: string | undefined, f: () => T, iam?: string): T => {
  const old = process.env.IMPORT_IR, oldIam = process.env.IMPORT_AWS_IAM;
  if (v === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = v;
  if (iam === undefined) delete process.env.IMPORT_AWS_IAM; else process.env.IMPORT_AWS_IAM = iam;
  try { return f(); } finally {
    if (old === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = old;
    if (oldIam === undefined) delete process.env.IMPORT_AWS_IAM; else process.env.IMPORT_AWS_IAM = oldIam;
  }
};
const req = (actions: string[]) => ({ tenantId: "t", envId: "e", provider: "aws" as const, purpose: "observe" as const, actions, ttlSec: 3600 });

test("깃발 없음·v1·빈 값은 지금 목록 그대로 (S3·SQS·캐시 동작 0)", () => {
  for (const v of [undefined, "v1", "", "  "]) {
    const a = withFlag(v, importObserveActions);
    assert.deepEqual(a, IMPORT_OBSERVE_ACTIONS);
    assert.ok(!a.some((x) => /^(s3|sqs|elasticache|cloudwatch):/.test(x)));
  }
});

test("IMPORT_IR=v2(앞뒤 공백 허용) 이면 데이터 읽기 12개가 더해지고, 최소 권한 검사(와일드카드·쓰기 금지)를 통과", () => {
  for (const v of ["v2", " v2 "]) {
    const a = withFlag(v, importObserveActions);
    // I9: ECS 출발 읽기(목록·설명만)도 더해진다
    assert.deepEqual(a, [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS]);
    assert.equal(new Set(a).size, a.length);
    assert.doesNotThrow(() => checkLeastPrivilege(req(a)));
  }
});

test("거부: 데이터 쓰기·객체 읽기 동작을 섞으면 관찰 역할 요청이 거부됨", () => {
  assert.throws(() => checkLeastPrivilege(req([...AWS_DATA_READ_ACTIONS, "s3:PutObject"])), /ROLE_OBSERVE_WRITE|쓰기/);
  assert.throws(() => checkLeastPrivilege(req(["s3:*"])), /와일드카드/);
});

const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
const inline: string[] = tpl.Resources.ObserveRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((s: { Action: string[] }) => s.Action);
// OBSERVE_PERMS 대입 줄들(쉘 변수 이어 붙이기)에 적힌 권한 이름 전부
const shPerms = readFileSync(new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url), "utf8").split("\n")
  .filter((l) => l.startsWith("OBSERVE_PERMS=")).join(",");

test("IMPORT_AWS_IAM=1 + v2: 앱 신원 IAM 읽기(파드 신원 2 + IAM 5)가 더해지고, 깃발 하나만으로는 안 더해짐", () => {
  const base = [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS];   // I9: v2 는 ECS 읽기(11개)도 요청
  const base = withFlag("v2", importObserveActions, "0");   // 기본 + 데이터 + ECS
  assert.deepEqual(base, [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS]);
  const a = withFlag("v2", importObserveActions, "1");
  assert.deepEqual(a.slice(0, base.length), base);
  assert.deepEqual(a.slice(base.length).sort(), ["eks:DescribePodIdentityAssociation", "eks:ListPodIdentityAssociations", "iam:GetPolicy", "iam:GetPolicyVersion",
    "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"]);
  assert.equal(new Set(a).size, a.length);
  assert.doesNotThrow(() => checkLeastPrivilege(req(a)));
  assert.deepEqual(withFlag(undefined, importObserveActions, "1"), IMPORT_OBSERVE_ACTIONS);   // v1 에서는 IAM 깃발이 있어도 읽지 않으므로 요청도 안 함
});

test("장부 목록의 모든 동작은 고객 관찰 역할 정의에 들어 있음 (AWS 인라인 정책 / GCP 연결 스크립트 권한)", () => {
  const aws = withFlag("v2", () => importObserveActions("aws"), "1");
  for (const a of aws) if (a !== "sts:GetCallerIdentity") assert.ok(inline.includes(a), `AWS 관찰 역할에 없음: ${a}`);
  const gcp = withFlag("v2", () => importObserveActions("gcp"));
  assert.ok(gcp.length >= 12);
  for (const p of gcp) assert.ok(shPerms.split(/[",]/).includes(p), `GCP 관찰 역할에 없음: ${p}`);
});

test("GCP 가져오기는 AWS 동작 이름이 아니라 GCP 권한 이름으로 요청 (깃발 off = GCP 목록만, v2 = 데이터 읽기 5개 추가)", () => {
  const off = withFlag(undefined, () => importObserveActions("gcp"));
  assert.deepEqual(off, IMPORT_GCP_OBSERVE_ACTIONS);
  assert.ok(off.every((p) => /^[a-z]+\.[A-Za-z]+\.[A-Za-z]+$/.test(p)), off.join());
  assert.ok(!off.some((p) => p.includes(":")));
  assert.deepEqual(withFlag("v2", () => importObserveActions("gcp")), [...IMPORT_GCP_OBSERVE_ACTIONS, ...GCP_DATA_READ_PERMISSIONS]);
  assert.doesNotThrow(() => checkLeastPrivilege({ ...req([]), provider: "gcp" as const, actions: withFlag("v2", () => importObserveActions("gcp")) }));
});
