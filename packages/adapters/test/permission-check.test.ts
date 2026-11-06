// PERM-GATE: 고객 쪽 실제 상태(흉내 gcloud·aws·testIamPermissions)와 묶음을 견준다. 클라우드는 부르지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PermissionBundleFile, PermissionGap } from "@svc/contracts";
import { checkAwsPermissions, checkGcpPermissions, contextOf, deniedPermissionsFromLog, gapsFromDenied, sampleArn } from "../src/permissions/check.js";
import type { Exec } from "../src/terraform/real-runner.js";

const dir = new URL("../../../infra/permissions/", import.meta.url).pathname;
const file = PermissionBundleFile.parse(JSON.parse(readFileSync(`${dir}permission-bundles.json`, "utf8")));
const pick = (...ids: string[]) => ids.map((id) => ({ ...file.bundles.find((b) => b.id === id)!, onSide: id.includes(".source") ? "source" as const : "target" as const }));
const ENV = "00000000-0000-4000-8000-000000000001";
const SP = "cust-prj", TP = "cust-mig";
const roleYaml = (f: string) => readFileSync(`${dir}${f}`, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

interface GcpWorld {
  roles: Record<string, { perms: string[]; description?: string } | "denied">;
  bindings: { role: string; members: string[]; condition?: object }[];
  apis: string[];
  observeGranted?: string[] | "error";
}
function gcpFake(w: GcpWorld) {
  const calls: string[] = [];
  const exec: Exec = async (bin, args, o) => {
    calls.push(`${bin} ${args.join(" ")}`);
    assert.equal(o.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok", "빌린 관찰 토큰으로만 부른다");
    const ok = (x: unknown) => ({ code: 0, stdout: JSON.stringify(x), stderr: "", ms: 1 });
    if (args[0] === "services") return ok(w.apis.map((a) => ({ config: { name: a } })));
    if (args[0] === "projects" && args[1] === "get-iam-policy") return ok({ bindings: w.bindings });
    if (args[0] === "iam" && args[1] === "roles") {
      const r = w.roles[args[3]!];
      if (r === "denied" || !r) return { code: 1, stdout: "", stderr: "ERROR: (gcloud.iam.roles.describe) PERMISSION_DENIED: Permission 'iam.roles.get' denied", ms: 1 };
      return ok({ includedPermissions: r.perms, description: r.description ?? "x" });
    }
    throw new Error(`모르는 명령 ${args.join(" ")}`);
  };
  const fetchFake = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    assert.equal(init.headers.authorization, "Bearer tok");
    const asked = (JSON.parse(init.body) as { permissions: string[] }).permissions;
    if (w.observeGranted === "error") return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "nope" } }), { status: 403 });
    const g = w.observeGranted ?? asked;
    return new Response(JSON.stringify({ permissions: asked.filter((p) => g.includes(p)) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, deps: { exec, fetch: fetchFake, env: {} as NodeJS.ProcessEnv } };
}
const sa = (n: string, p = TP) => `serviceAccount:${n}@${p}.iam.gserviceaccount.com`;
const role = (id: string) => `projects/${TP}/roles/${id}`;
const healthy = (): GcpWorld => ({
  roles: {
    platform_env: { perms: roleYaml("gcp-env-custom-role.yaml"), description: "env [perms v1]" },
    platform_plan: { perms: file.bundles.find((b) => b.id === "gcp.plan")!.permissions },
    platform_operate: { perms: roleYaml("gcp-operate-custom-role.yaml") },
    platform_observe: { perms: [], description: "obs [perms v1]" },
  },
  bindings: [{ role: role("platform_env"), members: [sa("svc-env")] }, { role: role("platform_plan"), members: [sa("svc-plan")] },
    { role: role("platform_operate"), members: [sa("svc-operate")] }, { role: role("platform_observe"), members: [sa("svc-observe", SP)] }],
  apis: file.bundles.flatMap((b) => b.apis),
});
const input = (bundles: ReturnType<typeof pick>) => ({ envId: ENV, version: 1, token: "tok", sourceProject: SP, targetProject: TP, bundles });

test("GCP 정상: 역할 정의·바인딩·API 가 다 있으면 차이 0, 쓰기 명령 없음", async () => {
  const f = gcpFake(healthy());
  const gaps = await checkGcpPermissions(f.deps, input(pick("gcp.observe.target", "gcp.permcheck", "gcp.plan", "gcp.env", "gcp.operate")));
  assert.deepEqual(gaps, []);
  assert.ok(f.calls.every((c) => / (services list|projects get-iam-policy|iam roles describe) /.test(c)), f.calls.join("\n"));
});

test("GCP 11/06 실측 재현: platform_env 에 setLabels 둘·노드 풀 읽기가 없으면 gcp.env block (빠진 3개, 역할의 권한 판)", async () => {
  const w = healthy();
  const measured = ["compute.globalAddresses.setLabels", "compute.addresses.setLabels", "compute.instanceGroupManagers.get"];
  w.roles.platform_env = { perms: roleYaml("gcp-env-custom-role.yaml").filter((p) => !measured.includes(p)), description: "env (예전 판)" };
  const gaps = await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.env", "gcp.operate")));
  assert.equal(gaps.length, 1);
  const g = PermissionGap.parse(gaps[0]);
  assert.equal(g.bundleId, "gcp.env"); assert.equal(g.level, "block"); assert.equal(g.principal, "svc-env");
  assert.deepEqual(g.missing, [...measured].sort());
  assert.equal(g.grantedVersion, null);
});

test("GCP 역할이 사람이 따로 붙인 기본 역할로 채워졌으면 빠진 것으로 안 본다 (바인딩된 역할 전부의 합)", async () => {
  const w = healthy();
  const extra = ["compute.instanceGroupManagers.get"];
  w.roles.platform_operate = { perms: roleYaml("gcp-operate-custom-role.yaml").filter((p) => !extra.includes(p)) };
  w.roles["roles/compute.viewer"] = { perms: extra };
  w.bindings.push({ role: "roles/compute.viewer", members: [sa("svc-operate")] });
  assert.deepEqual(await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.operate"))), []);
});

test("GCP 확인 권한(iam.roles.get) 없음: 단계 묶음은 막지 않고 '확인 못 함'(warn), 확인용 묶음은 빠짐(warn)", async () => {
  const w = healthy();
  for (const k of Object.keys(w.roles)) w.roles[k] = "denied";
  const all = file.bundles.find((b) => b.id === "gcp.permcheck")!.permissions;
  w.observeGranted = file.bundles.filter((b) => b.principal === "svc-observe").flatMap((b) => b.permissions).filter((p) => !all.includes(p));
  const gaps = await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.permcheck", "gcp.env")));
  assert.deepEqual(gaps.map((g) => [g.bundleId, g.level]), [["gcp.permcheck", "warn"], ["gcp.env", "warn"]]);
  assert.deepEqual(gaps[0]!.missing, ["iam.roles.get"]);
  assert.match(gaps[1]!.unverified ?? "", /iam\.roles\.get/);
});

test("GCP API 꺼짐·조건부 바인딩 없음·SA 없음은 각각 이름으로 남는다", async () => {
  const w = healthy();
  w.apis = w.apis.filter((a) => a !== "container.googleapis.com");
  w.roles.platform_operate_db_secret = { perms: ["secretmanager.versions.access"] };   // 역할은 있는데 조건부 바인딩이 없다
  const gaps = await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.env", "gcp.operate.dbsecret")));
  const env = gaps.find((g) => g.bundleId === "gcp.env")!, db = gaps.find((g) => g.bundleId === "gcp.operate.dbsecret")!;
  assert.deepEqual(env.missingApis, ["container.googleapis.com"]);
  assert.deepEqual(db.missing, ["secretmanager.versions.access"]);
  assert.equal(db.level, "block");
  // svc-env 가 아예 없으면(예전 연결) 권한 전부가 빠짐
  w.bindings = w.bindings.filter((b) => !b.members.includes(sa("svc-env")));
  const g2 = await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.env")));
  assert.equal(g2[0]!.missing.length, roleYaml("gcp-env-custom-role.yaml").length);
});

test("GCP 관찰 자기 권한 = testIamPermissions: AR 지역 목록이 없으면 관찰 묶음 warn (단계를 막지 않음), 실패면 확인 못 함", async () => {
  const w = healthy();
  w.observeGranted = file.bundles.filter((b) => b.principal === "svc-observe").flatMap((b) => b.permissions).filter((p) => p !== "artifactregistry.locations.list");
  const gaps = await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.observe.source", "gcp.observe.target")));
  assert.deepEqual(gaps.map((g) => [g.bundleId, g.level, g.missing.join()]),
    [["gcp.observe.source", "warn", "artifactregistry.locations.list"], ["gcp.observe.target", "warn", "artifactregistry.locations.list"]]);
  assert.equal(gaps[1]!.grantedVersion, 1, "전용 프로젝트 관찰 역할 설명의 [perms v1]");
  w.observeGranted = "error";
  const e = await checkGcpPermissions(gcpFake(w).deps, input(pick("gcp.observe.source")));
  assert.match(e[0]!.unverified ?? "", /testIamPermissions 403/);
});

test("GCP 전용 프로젝트가 없으면 도착 묶음은 확인 못 함 (가짜 통과 없음)", async () => {
  const gaps = await checkGcpPermissions(gcpFake(healthy()).deps, { ...input(pick("gcp.env")), targetProject: null });
  assert.equal(gaps[0]!.level, "warn"); assert.match(gaps[0]!.unverified ?? "", /전용 프로젝트/);
});

// ── AWS ──
const ACCT = "111122223333";
const policies = { "svc-operate-policy": JSON.parse(readFileSync(`${dir}aws-operate-role-policy.json`, "utf8")), relay: JSON.parse(readFileSync(`${dir}aws-relay-statements.json`, "utf8")) };
function awsFake(o: { deny?: string[]; simulateDenied?: boolean; tag?: string }) {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    if (args[1] === "get-role") return { code: 0, stdout: JSON.stringify({ Role: { Tags: o.tag ? [{ Key: "platform-perms-version", Value: o.tag }] : [] } }), stderr: "", ms: 1 };
    if (o.simulateDenied) return { code: 254, stdout: "", stderr: "An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation: User is not authorized to perform: iam:SimulatePrincipalPolicy", ms: 1 };
    const names = args.slice(args.indexOf("--action-names") + 1, args.findIndex((a, i) => i > args.indexOf("--action-names") && a.startsWith("--")));
    return { code: 0, stdout: JSON.stringify({ EvaluationResults: names.map((n) => ({ EvalActionName: n, EvalDecision: o.deny?.includes(n) ? "implicitDeny" : "allowed" })) }), stderr: "", ms: 1 };
  };
  return { calls, exec };
}
const awsIn = (ids: string[]) => ({ envId: ENV, version: 1, accountId: ACCT, region: "ap-northeast-2", policies,
  bundles: ids.map((id) => ({ ...file.bundles.find((b) => b.id === id)!, onSide: "target" as const })) });

test("AWS: #315 이전 스택(중계기 도착 RDS 규칙 없음)이면 aws.relay.target block, 견본 자원·조건으로 흉내 평가", async () => {
  const f = awsFake({ deny: ["ec2:AuthorizeSecurityGroupIngress"], tag: "1" });
  const gaps = await checkAwsPermissions({ exec: f.exec, env: {} }, awsIn(["aws.relay.target", "aws.operate"]));
  assert.equal(gaps.length, 2, "같은 동작이 두 묶음에 있으면 둘 다");
  const relay = gaps.find((g) => g.bundleId === "aws.relay.target")!;
  assert.deepEqual([relay.level, relay.missing, relay.grantedVersion], ["block", ["ec2:AuthorizeSecurityGroupIngress"], 1]);
  const sims = f.calls.filter((c) => c[1] === "simulate-principal-policy");
  assert.ok(sims.every((c) => c.includes(`arn:aws:iam::${ACCT}:role/svc-operate`)));
  assert.ok(sims.some((c) => c.includes("--resource-arns")), "자원 지정 문장은 견본 ARN 으로");
  assert.ok(sims.every((c) => !c.join(" ").includes("*")), "견본에 와일드카드 없음");
});

// 한 계정에 환경 여럿 (0056): 흉내 평가·판 태그 읽기 모두 그 환경 역할(svc-operate-<8자>·svc-observe-<8자>). 묶음 주체 이름(화면)은 바탕 그대로
test("AWS RoleSuffix: 꼬리가 있으면 그 환경 역할을 흉내 평가하고 태그도 그 역할에서 읽는다. 없으면 옛 이름", async () => {
  const f = awsFake({ tag: "1" });
  const gaps = await checkAwsPermissions({ exec: f.exec, env: {} }, { ...awsIn(["aws.operate", "aws.permcheck"]), roleSuffix: "-783df2ef" });
  assert.deepEqual(gaps, []);
  const src = f.calls.filter((c) => c[1] === "simulate-principal-policy").map((c) => c[c.indexOf("--policy-source-arn") + 1]);
  assert.deepEqual([...new Set(src)].sort(), [`arn:aws:iam::${ACCT}:role/svc-observe-783df2ef`, `arn:aws:iam::${ACCT}:role/svc-operate-783df2ef`]);
  assert.deepEqual(f.calls.filter((c) => c[1] === "get-role").map((c) => c[3]).sort(), ["svc-observe-783df2ef", "svc-operate-783df2ef"]);
  const old = awsFake({ tag: "1" });
  await checkAwsPermissions({ exec: old.exec, env: {} }, { ...awsIn(["aws.operate"]), roleSuffix: null });
  assert.ok(old.calls.filter((c) => c[1] === "simulate-principal-policy").every((c) => c.includes(`arn:aws:iam::${ACCT}:role/svc-operate`)));
});

test("AWS: 관찰 역할에 흉내 평가 권한이 없으면 확인용 묶음 warn(빠짐), 나머지는 확인 못 함 (막지 않음)", async () => {
  const gaps = await checkAwsPermissions({ exec: awsFake({ simulateDenied: true }).exec, env: {} }, awsIn(["aws.permcheck", "aws.operate"]));
  assert.deepEqual(gaps.map((g) => [g.bundleId, g.level]), [["aws.permcheck", "warn"], ["aws.operate", "warn"]]);
  assert.deepEqual(gaps[0]!.missing, ["iam:SimulatePrincipalPolicy"]);
  assert.match(gaps[1]!.unverified ?? "", /SimulatePrincipalPolicy/);
});

test("견본 ARN·조건: 리전·계정을 채우고 이름 규칙(app-·platform/)을 지키는 값", () => {
  assert.equal(sampleArn("arn:aws:iam::*:role/app-*", "iam:CreateRole", "ap-northeast-2", ACCT), `arn:aws:iam::${ACCT}:role/app-permcheck`);
  assert.equal(sampleArn(["arn:aws:s3:::app-*", "arn:aws:sqs:*:*:app-*"], "sqs:CreateQueue", "ap-northeast-2", ACCT), `arn:aws:sqs:ap-northeast-2:${ACCT}:app-permcheck`);
  assert.equal(sampleArn("*", "ec2:DescribeVpcs", "r", ACCT), null);
  const c = contextOf({ StringEquals: { "aws:RequestedRegion": "ap-northeast-2", "iam:PermissionsBoundary": "arn:aws:iam::${aws:PrincipalAccount}:policy/platform-app-boundary" },
    StringLike: { "aws:ResourceTag/aws:rds:primaryDBInstanceArn": "arn:aws:rds:*:*:db:*-pg-??????" }, Null: { "aws:ResourceTag/tenant": "false" } }, "ap-northeast-2", ACCT);
  const kv = Object.fromEntries((c as { ContextKeyName: string; ContextKeyValues: string[] }[]).map((x) => [x.ContextKeyName, x.ContextKeyValues[0]]));
  assert.equal(kv["iam:PermissionsBoundary"], `arn:aws:iam::${ACCT}:policy/platform-app-boundary`);
  assert.equal(kv["aws:ResourceTag/aws:rds:primaryDBInstanceArn"], "arn:aws:rds:permcheck:permcheck:db:permcheck-pg-aaaaaa");
  assert.equal(kv["aws:ResourceTag/tenant"], "permcheck");
});

test("403 안전망: Terraform 로그의 빠진 권한 → 같은 차이 모양. 표에 있으면 missing, 표에도 없으면 notInTable", () => {
  const log = [
    "│ Error: Error creating Address: googleapi: Error 403: Required 'compute.addresses.setLabels' permission for 'projects/p/regions/r/addresses/a', forbidden",
    "│ Error: googleapi: Error 403: Permission 'container.nodePools.weird' denied on resource 'x'",
    "User: arn:aws:sts::x:assumed-role/svc-operate/s is not authorized to perform: ec2:CreateTags on resource: y",
  ];
  const d = deniedPermissionsFromLog(log);
  assert.deepEqual(d, { gcp: ["compute.addresses.setLabels", "container.nodePools.weird"], aws: ["ec2:CreateTags"] });
  const gaps = gapsFromDenied(file.bundles, d.gcp, { envId: ENV, version: 1, cloud: "gcp", principal: "svc-env" });
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0]!.bundleId, gaps[0]!.missing, gaps[0]!.notInTable, gaps[0]!.level], ["gcp.env", ["compute.addresses.setLabels"], ["container.nodePools.weird"], "block"]);
  assert.deepEqual(gapsFromDenied(file.bundles, [], { envId: ENV, version: 1, cloud: "gcp", principal: "svc-env" }), []);
  assert.deepEqual(deniedPermissionsFromLog("Error: timeout"), { gcp: [], aws: [] });
});
