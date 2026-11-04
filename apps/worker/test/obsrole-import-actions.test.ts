// OBSROLE: 가져오기가 관찰 역할을 빌릴 때 요청하는 동작 목록 — 데이터 읽기가 더해지고 최소 권한 검사를 통과한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AWS_DATA_READ_ACTIONS, AWS_NET_READ_ACTIONS, GCP_NET_READ_PERMISSIONS, CLOUDRUN_OBSERVE_PERMISSIONS, ECS_OBSERVE_ACTIONS, EC2_OBSERVE_ACTIONS, GCE_OBSERVE_PERMISSIONS, GCP_DATA_READ_PERMISSIONS } from "@svc/adapters";
import { checkLeastPrivilege } from "@svc/security";
import { IMPORT_GCP_OBSERVE_ACTIONS, IMPORT_OBSERVE_ACTIONS, importObserveActions } from "../src/jobs/import.js";

const withIam = <T>(f: () => T, iam?: string): T => {
  const oldIam = process.env.IMPORT_AWS_IAM;
  if (iam === undefined) delete process.env.IMPORT_AWS_IAM; else process.env.IMPORT_AWS_IAM = iam;
  try { return f(); } finally {
    if (oldIam === undefined) delete process.env.IMPORT_AWS_IAM; else process.env.IMPORT_AWS_IAM = oldIam;
  }
};
const req = (actions: string[]) => ({ tenantId: "t", envId: "e", provider: "aws" as const, purpose: "observe" as const, actions, ttlSec: 3600 });

test("기본 목록 + 데이터 읽기 12개, 최소 권한 검사(와일드카드·쓰기 금지)를 통과 (IAM 읽기 끔)", () => {
  {
    const a = withIam(() => importObserveActions(), "0");
    // I9: ECS 출발 읽기(목록·설명만)도 더해진다
    assert.deepEqual(a, [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...AWS_NET_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS, ...EC2_OBSERVE_ACTIONS]);
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

test("ID-5: 깃발 없으면 IAM 읽기 켬(=1 과 같음)", () => {
  assert.deepEqual(withIam(() => importObserveActions()), withIam(() => importObserveActions(), "1"));
});

test("IMPORT_AWS_IAM=1: 앱 신원 IAM 읽기(파드 신원 2 + IAM 5)가 더해지고, 0 이면 안 더해짐", () => {
  const base = withIam(() => importObserveActions(), "0");   // 기본 + 데이터 + ECS
  assert.deepEqual(base, [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...AWS_NET_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS, ...EC2_OBSERVE_ACTIONS]);
  const a = withIam(() => importObserveActions(), "1");
  assert.deepEqual(a.slice(0, base.length), base);
  assert.deepEqual(a.slice(base.length).sort(), ["eks:DescribePodIdentityAssociation", "eks:ListPodIdentityAssociations", "iam:GetPolicy", "iam:GetPolicyVersion",
    "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"]);
  assert.equal(new Set(a).size, a.length);
  assert.doesNotThrow(() => checkLeastPrivilege(req(a)));
});

test("장부 목록의 모든 동작은 고객 관찰 역할 정의에 들어 있음 (AWS 인라인 정책 / GCP 연결 스크립트 권한)", () => {
  const aws = withIam(() => importObserveActions("aws"), "1");
  for (const a of aws) if (a !== "sts:GetCallerIdentity") assert.ok(inline.includes(a), `AWS 관찰 역할에 없음: ${a}`);
  const gcp = withIam(() => importObserveActions("gcp"));
  assert.ok(gcp.length >= 12);
  for (const p of gcp) assert.ok(shPerms.split(/[",]/).includes(p), `GCP 관찰 역할에 없음: ${p}`);
});

test("GCP 가져오기는 AWS 동작 이름이 아니라 GCP 권한 이름으로 요청 (GCP 목록 + 데이터 읽기 추가)", () => {
  const off = IMPORT_GCP_OBSERVE_ACTIONS;
  assert.ok(off.every((p) => /^[a-z]+\.[A-Za-z]+\.[A-Za-z]+$/.test(p)), off.join());
  assert.ok(!off.some((p) => p.includes(":")));
  // VMIMPORT: GCE 읽기 + CRIMPORT: Cloud Run 읽기 (겹치는 권한은 한 번만)
  const base = [...IMPORT_GCP_OBSERVE_ACTIONS, ...GCP_DATA_READ_PERMISSIONS, ...GCP_NET_READ_PERMISSIONS];
  const v2 = withIam(() => importObserveActions("gcp"), "0");
  assert.deepEqual(v2.slice(0, base.length), base);
  // WI-1: 기본(IAM 읽기 켬)이면 프로젝트 IAM 정책 읽기 하나가 더해진다
  const on = withIam(() => importObserveActions("gcp"));
  assert.deepEqual(on.filter((a) => !v2.includes(a)), ["resourcemanager.projects.getIamPolicy"]);
  assert.deepEqual(new Set(v2), new Set([...base, ...GCE_OBSERVE_PERMISSIONS, ...CLOUDRUN_OBSERVE_PERMISSIONS]));
  assert.equal(new Set(v2).size, v2.length);
  assert.doesNotThrow(() => checkLeastPrivilege({ ...req([]), provider: "gcp" as const, actions: withIam(() => importObserveActions("gcp")) }));
});

test("CRIMPORT: gcp 관찰 요청에 Cloud Run 읽기 권한이 들어가고 최소 권한을 통과, 쓰기(run.services.update·run.jobs.run)를 섞으면 거부", () => {
  const gcp = withIam(() => importObserveActions("gcp"));
  for (const p of ["run.services.list", "run.revisions.get", "run.jobs.list", "cloudscheduler.jobs.list"]) assert.ok(gcp.includes(p), p);
  const g = (actions: string[]) => ({ ...req([]), provider: "gcp" as const, actions });
  assert.doesNotThrow(() => checkLeastPrivilege(g(gcp)));
  for (const w of ["run.services.update", "run.jobs.run", "run.services.setIamPolicy", "cloudscheduler.jobs.pause"])
    assert.throws(() => checkLeastPrivilege(g([...gcp, w])), /ROLE_OBSERVE_WRITE|쓰기/, w);
});
