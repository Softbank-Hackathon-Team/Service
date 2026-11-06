// PERM-GATE: 권한 묶음은 권한표·역할 파일·연결 스크립트에서 생성된다 (손으로 적은 두 번째 목록 없음). 커밋된 파일 = 다시 만든 것, 판 번호 = 지문
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PermissionBundleFile } from "@svc/contracts";
import { buildPermissionBundles, bundleDigest, gcpBundlesTsv, PERMISSIONS_DIGEST, PERMISSIONS_VERSION, requiredBundles, type BundleNeeds } from "../src/permissions/bundles.js";
import { collectBundleInputs, connectScriptLists, roleYamlPermissions } from "../scripts/permission-bundles.js";

const dir = new URL("../../../infra/permissions/", import.meta.url).pathname;
const file = PermissionBundleFile.parse(JSON.parse(readFileSync(`${dir}permission-bundles.json`, "utf8")));
const by = (id: string) => file.bundles.find((b) => b.id === id)!;
const yaml = (f: string) => roleYamlPermissions(readFileSync(`${dir}${f}`, "utf8"));

test("커밋된 permission-bundles.json·gcp-bundles.tsv = 지금 원본으로 다시 만든 것 (export-permissions 를 안 돌리고 권한을 바꾸면 실패)", () => {
  const fresh = buildPermissionBundles(collectBundleInputs(dir));
  assert.deepEqual(file.bundles, fresh);
  assert.equal(file.version, PERMISSIONS_VERSION);
  assert.equal(readFileSync(`${dir}gcp-bundles.tsv`, "utf8"), gcpBundlesTsv(PERMISSIONS_VERSION, fresh));
});

test("권한 판: 묶음 내용이 바뀌었으면 PERMISSIONS_VERSION 을 올리고 PERMISSIONS_DIGEST 를 새 지문으로", () => {
  const d = bundleDigest(file.bundles);
  assert.equal(d, PERMISSIONS_DIGEST, `묶음 지문이 ${d} 로 바뀜: PERMISSIONS_VERSION(${PERMISSIONS_VERSION}) 을 올리고 PERMISSIONS_DIGEST 를 "${d}" 로 바꾼 뒤 export-permissions 를 다시 돌린다`);
});

test("실행 역할 파일의 권한은 빠짐없이 어느 실행 묶음엔가 있다 (기본 앱·비밀·postgres·데이터)", () => {
  const operate = yaml("gcp-operate-custom-role.yaml");
  const covered = new Set(file.bundles.filter((b) => b.role === "platform_operate").flatMap((b) => b.permissions));
  assert.deepEqual(operate.filter((p) => !covered.has(p)), []);
  assert.deepEqual([...covered].filter((p) => !operate.includes(p)), [], "묶음에만 있고 역할 파일에 없는 권한은 없다");
  assert.deepEqual(by("gcp.env").permissions, yaml("gcp-env-custom-role.yaml"));
  assert.deepEqual(by("gcp.operate.iam").permissions, yaml("gcp-operate-iam-custom-role.yaml"));
  assert.equal(by("gcp.operate.iam").conditional, true);
  assert.equal(by("gcp.operate.dbsecret").conditional, true);
  // plan = 관찰 + 실행 역할 파일의 읽기 동사 (gcp-connect.sh PLAN_READS 와 같은 규칙)
  const sh = connectScriptLists(readFileSync(new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url), "utf8"));
  assert.deepEqual(by("gcp.plan").permissions, [...new Set([...sh.observe, ...operate.filter((p) => /\.(get|list|getIamPolicy)$/.test(p))])].sort());
});

test("11/06 실측 누락이 묶음에 들어 있다 (env setLabels 둘·노드 풀 읽기, plan·operate 노드 풀 읽기, DB 비밀 버전 enable, AR 지역 목록)", () => {
  for (const p of ["compute.globalAddresses.setLabels", "compute.addresses.setLabels", "compute.instanceGroupManagers.get"]) assert.ok(by("gcp.env").permissions.includes(p), p);
  assert.ok(by("gcp.plan").permissions.includes("compute.instanceGroupManagers.get"));
  assert.ok(by("gcp.operate").permissions.includes("compute.instanceGroupManagers.get"));
  assert.ok(by("gcp.operate.postgres").permissions.includes("secretmanager.versions.enable"));
  for (const id of ["gcp.observe.source", "gcp.observe.target"]) assert.ok(by(id).permissions.includes("artifactregistry.locations.list"), id);
  // 결제 확인(PC-BILL)·빌리기 API 는 관찰 묶음 API 로 (연결 스크립트가 켜는 것)
  for (const a of ["cloudbilling.googleapis.com", "iamcredentials.googleapis.com", "cloudresourcemanager.googleapis.com"]) assert.ok(by("gcp.observe.source").apis.includes(a), a);
  // 중계기 도착 RDS 보안 그룹 규칙(#315)은 GCP→AWS 도착 묶음에만
  const rules = ["ec2:AuthorizeSecurityGroupIngress"];
  for (const a of rules) assert.ok(by("aws.relay.target").permissions.includes(a), a);
  assert.ok(by("aws.permcheck").permissions.includes("iam:SimulatePrincipalPolicy"));
  assert.deepEqual(by("gcp.permcheck").permissions, ["iam.roles.get"]);
});

const need = (o: Partial<BundleNeeds>): BundleNeeds => ({ sourceProvider: "aws", targetProvider: "gcp", secrets: false, postgres: false, data: false,
  envLayerCreate: false, relay: null, argoHub: false, ...o });
const ids = (n: BundleNeeds) => requiredBundles(file.bundles, n).map((b) => `${b.onSide}:${b.id}`).sort();

test("필요한 묶음 = 명세·계획·경로에서 계산: 환경 층 생성이 있을 때만 env, postgres 일 때만 DB 묶음, 중계기 경로일 때만 relay", () => {
  const base = ids(need({}));
  assert.ok(base.includes("source:aws.observe") && base.includes("target:gcp.operate") && base.includes("target:gcp.plan"));
  assert.ok(!base.some((x) => /gcp\.env|postgres|dbsecret|relay|aws\.operate/.test(x)), base.join(" "));
  const full = ids(need({ postgres: true, envLayerCreate: true, secrets: true, relay: "aws-gcp", argoHub: true }));
  for (const x of ["target:gcp.env", "target:gcp.operate.postgres", "target:gcp.operate.dbsecret", "target:gcp.operate.secrets", "source:aws.relay.source", "target:gcp.hub"])
    assert.ok(full.includes(x), x);
  const g2a = ids(need({ sourceProvider: "gcp", targetProvider: "aws", relay: "gcp-aws", postgres: true }));
  assert.ok(g2a.includes("target:aws.relay.target") && g2a.includes("source:gcp.observe.source") && g2a.includes("target:aws.operate.postgres"));
  assert.ok(!g2a.some((x) => x.includes("aws.relay.source") || x.includes("gcp.plan")), g2a.join(" "));
  // 온프레·Azure 쪽은 묶음이 없다 (온프레 규칙은 손대지 않음)
  assert.deepEqual(ids(need({ sourceProvider: "onprem", targetProvider: "onprem" })), []);
});

test("연결 템플릿: 관찰 역할 확인 권한은 이 계정 svc-* 역할에만, 두 역할에 권한 판 태그", () => {
  const t = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
  const obs = t.Resources.ObserveRole.Properties;
  const pc = obs.Policies.find((p: { PolicyName: string }) => p.PolicyName === "observe-permcheck").PolicyDocument.Statement;
  assert.deepEqual(pc, [{ Effect: "Allow", Action: ["iam:SimulatePrincipalPolicy"], Resource: { "Fn::Join": ["", ["arn:aws:iam::", { Ref: "AWS::AccountId" }, ":role/svc-*"]] } }]);
  for (const r of ["ObserveRole", "OperateRole"])
    assert.deepEqual(t.Resources[r].Properties.Tags, [{ Key: "platform-perms-version", Value: String(PERMISSIONS_VERSION) }], r);
});
