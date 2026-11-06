// tools/team-env.sh: 팀 환경 등록부(docs/team-env/registry.yaml)를 읽어 칸 하나의 GCP 연결 명령을 찍는다.
// 가짜 등록부·가짜 gcloud 로만 돈다 (클라우드 호출 0). --check 는 읽기 전용 두 명령만 부르는지까지 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SA = "t-5b7095dff329bac5840a31c433e7@sb-iron-platform.iam.gserviceaccount.com";

function run(args: string[], registry?: string, env: Record<string, string> = {}) {
  const e: Record<string, string> = { ...process.env, ...env } as Record<string, string>;
  delete e.PLATFORM_SA; delete e.PLATFORM_GCP_PROJECT; delete e.TEAM_ENV_REGISTRY;
  if (registry !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "team-env-")), "registry.yaml");
    writeFileSync(f, registry);
    e.TEAM_ENV_REGISTRY = f;
  }
  return spawnSync("bash", ["tools/team-env.sh", ...args], { cwd: ROOT, encoding: "utf8", env: { ...e, ...env } });
}
const commands = (out: string) => out.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));

// 고정본: 블록 모양 환경·작은따옴표·주석·흐름 목록이 섞여 있다 (파서가 등록부에 실제로 쓰는 모양을 다 읽는지)
const FIXTURE = `# 시험용 등록부
version: 1
tenant: 11111111-1111-4111-8111-111111111111   # dev-company
slots:
  - id: slot-1
    login: <id>@iron
    signup_code_sha256: ""
    environments:
      - { name: src-aws-sample, provider: aws, region: ap-northeast-2, cluster: platform-target, notes: "공유, 쉼표와 # 가 든 메모" }
      - { name: GCP-sample, provider: gcp, region: asia-northeast3, gcp: { original_project: iron-source-gcp, dedicated_project: iron-target-gcp } }
  - id: slot-2
    login: 'b@iron'   # 작은따옴표
    signup_code_sha256: "${"a".repeat(64)}"
    environments:
      - name: s2-gcp
        provider: gcp
        region: asia-northeast3
        gcp:
          original_project: team-b-orig
          dedicated_project: team-b-target   # 전용
        notes: "블록 모양"
      - { name: s2-src-aws, provider: aws, region: ap-northeast-2, cluster: b-eks, db_instance: b-shop-db }
  - id: slot-3
    login: <id>@iron
    signup_code_sha256: ""
    environments: []
    #   - { name: s3-gcp, provider: gcp, gcp: { original_project: <원래>, dedicated_project: <전용> } }
`;

test("레포 등록부: slot-1 은 공유 GCP 환경 명령을 값까지 채워 찍는다 (회사 SA 는 회사 번호에서 계산, 자리 값 없음)", () => {
  const r = run(["slot-1"]);
  assert.equal(r.status, 0, r.stderr);
  const cmds = commands(r.stdout);
  assert.equal(cmds[0], `PLATFORM_SA=${SA} PROJECT_ID=iron-source-gcp TARGET_PROJECT_ID=iron-target-gcp bash infra/onboarding/gcp-connect.sh`);
  assert.ok(cmds.includes("gcloud services enable cloudbilling.googleapis.com --project=iron-source-gcp"));
  assert.ok(cmds.includes("gcloud services enable cloudbilling.googleapis.com --project=iron-target-gcp"));
  assert.ok(cmds.includes("gcloud iam roles update platform_env --project=iron-target-gcp --add-permissions=compute.addresses.setLabels,compute.globalAddresses.setLabels,compute.instanceGroupManagers.get,serviceusage.operations.get"));
  assert.ok(cmds.includes("gcloud iam roles update platform_operate --project=iron-target-gcp --add-permissions=compute.instanceGroupManagers.get,resourcemanager.projects.get,secretmanager.versions.enable,serviceusage.operations.get"));
  assert.ok(cmds.includes("gcloud iam roles update platform_plan --project=iron-target-gcp --add-permissions=compute.instanceGroupManagers.get,serviceusage.operations.get"));
  assert.match(r.stdout, /--member=serviceAccount:svc-operate@iron-target-gcp\.iam\.gserviceaccount\.com --role=projects\/iron-target-gcp\/roles\/platform_operate_iam/);
  for (const c of cmds) {
    assert.doesNotMatch(c, /<[^>]*>/, `자리 값이 남음: ${c}`);
    assert.match(c, /^(PLATFORM_SA=|gcloud |for sa in )/, `명령 한 줄이 아님: ${c}`);
  }
  // 원래 프로젝트에는 쓰기 명령이 cloudbilling 켜기와 gcp-connect.sh 뿐이다 (역할 갱신은 전용 프로젝트에만)
  assert.deepEqual(cmds.filter((c) => c.includes("--project=iron-source-gcp")), ["gcloud services enable cloudbilling.googleapis.com --project=iron-source-gcp"]);
});

test("칸 회사: 칸에 tenant 가 있으면 GCP 연결의 회사 SA 는 그 칸 회사 것 (명부 맨 위 회사 SA 가 아님)", () => {
  const T2 = "6ccb6f15-b354-496c-a4fe-3f7135961422";
  const reg = `version: 1\ntenant: 11111111-1111-4111-8111-111111111111\nslots:\n  - id: slot-9\n    tenant: ${T2}\n    login: x@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: x-gcp, provider: gcp, region: asia-northeast3, gcp: { original_project: x-src-prj, dedicated_project: x-mig-prj } }\n`;
  const r = run(["slot-9"], reg);
  assert.equal(r.status, 0, r.stderr);
  const sa = `t-${createHash("md5").update(T2).digest("hex").slice(0, 28)}@sb-iron-platform.iam.gserviceaccount.com`;
  assert.equal(commands(r.stdout)[0], `PLATFORM_SA=${sa} PROJECT_ID=x-src-prj TARGET_PROJECT_ID=x-mig-prj bash infra/onboarding/gcp-connect.sh`);
  assert.ok(!r.stdout.includes(SA), "dev-company 회사 SA 가 아님");
  const bad = run(["slot-9"], reg.replace(T2, "not-a-uuid"));
  assert.equal(bad.status, 2);
});

test("레포 등록부: 환경을 안 적은 칸(slot-2)은 끝 코드 2 와 무엇을 채울지", () => {
  const r = run(["slot-2"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /slot-2 에 provider: gcp 환경이 없음/);
});

test("고정본: 블록 모양 환경·따옴표·주석을 읽어 slot-2 명령을 찍는다", () => {
  const r = run(["slot-2"], FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  const cmds = commands(r.stdout);
  assert.equal(cmds[0], `PLATFORM_SA=${SA} PROJECT_ID=team-b-orig TARGET_PROJECT_ID=team-b-target bash infra/onboarding/gcp-connect.sh`);
  assert.equal(cmds.length, 9);
  assert.ok(cmds.every((c) => !/iron-(source|target)-gcp/.test(c)), "다른 칸 값이 섞이면 안 된다");
  assert.match(r.stdout, /^# === slot-2 \/ s2-gcp: 원래 team-b-orig → 전용 team-b-target/m);
});

test("PLATFORM_GCP_PROJECT·PLATFORM_SA 로 회사 SA 를 바꿀 수 있고, 모양이 틀리면 거부", () => {
  assert.match(run(["slot-2"], FIXTURE, { PLATFORM_GCP_PROJECT: "other-plat" }).stdout, /PLATFORM_SA=t-5b7095dff329bac5840a31c433e7@other-plat\.iam\.gserviceaccount\.com /);
  const bad = run(["slot-2"], FIXTURE, { PLATFORM_SA: "someone@example.com" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /PLATFORM_SA 모양이 아님/);
});

test("거부: 칸 이름·없는 칸·모르는 옵션", () => {
  assert.equal(run(["slot-9"], FIXTURE).status, 2);
  const missing = run(["slot-9"], FIXTURE);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /등록부에 slot-9 칸이 없음/);
  assert.equal(run(["slot-2", "--apply"], FIXTURE).status, 2);
});

test("거부: 자리 값·같은 프로젝트·전용 프로젝트 공유·환경 이름 중복·version 틀림 (명령을 하나도 안 찍는다)", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["자리 값", FIXTURE.replace("original_project: team-b-orig", "original_project: <원래>"), /original_project 가 GCP 프로젝트 ID 모양이 아님/],
    ["빈 칸", FIXTURE.replace("dedicated_project: team-b-target", 'dedicated_project: ""'), /둘 다 채운다/],
    ["원래=전용", FIXTURE.replace("dedicated_project: team-b-target", "dedicated_project: team-b-orig"), /원래 프로젝트와 전용 프로젝트가 같음/],
    ["전용 공유", FIXTURE.replace("dedicated_project: team-b-target", "dedicated_project: iron-target-gcp"), /전용 프로젝트 iron-target-gcp 를 다른 환경도 쓴다/],
    ["남의 원래 프로젝트를 전용으로", FIXTURE.replace("dedicated_project: team-b-target", "dedicated_project: iron-source-gcp"), /전용 프로젝트 iron-source-gcp 를 다른 환경도 쓴다/],
    ["이름 중복", FIXTURE.replace("name: s2-src-aws", "name: src-aws-sample"), /환경 이름 src-aws-sample 이 두 칸 이상에 있음/],
    ["version", FIXTURE.replace("version: 1", "version: 2"), /version 이 1 이 아님/],
  ];
  for (const [name, reg, err] of cases) {
    const r = run(["slot-2"], reg);
    assert.equal(r.status, 2, name);
    assert.equal(r.stdout, "", name);
    assert.match(r.stderr, err, name);
  }
});

test("거부: 깨진 YAML 은 줄 번호와 함께 끝 코드 2", () => {
  const r = run(["slot-1"], FIXTURE.replace("dedicated_project: iron-target-gcp } }", "dedicated_project: iron-target-gcp }"));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /등록부 10번째 줄: 흐름 맵이 닫히지 않음/);
  const tab = run(["slot-1"], FIXTURE.replace("    login: <id>@iron\n    signup", "\tlogin: <id>@iron\n    signup"));
  assert.equal(tab.status, 2);
  assert.match(tab.stderr, /들여쓰기에 탭/);
});

// 가짜 gcloud: 프로젝트마다 <dir>/<프로젝트>.apis 파일이 켜진 API 목록. 파일이 없으면 프로젝트 없음
function fakeGcloud(apis: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "team-env-gcloud-"));
  for (const [p, list] of Object.entries(apis)) writeFileSync(join(dir, `${p}.apis`), list.map((a) => `${a}.googleapis.com\n`).join(""));
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "projects describe") [ -f "${dir}/$3.apis" ] || exit 1; echo "$3" ;;
  "services list") p=$(printf '%s\\n' "$@" | sed -n 's/^--project=//p'); cat "${dir}/$p.apis" ;;
  *) exit 9 ;;
esac
`);
  chmodSync(join(dir, "gcloud"), 0o755);
  return { env: { PATH: `${dir}:${process.env.PATH}` }, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n") };
}
const TARGET_APIS = readFileSync(join(ROOT, "infra/onboarding/gcp-connect.sh"), "utf8").match(/^TARGET_APIS="(.*)"$/m)![1]!.split(" ");

test("--check: 다 켜져 있으면 끝 코드 0, 읽기 전용 두 명령만 부른다", () => {
  const g = fakeGcloud({ "team-b-orig": ["iamcredentials", "cloudresourcemanager", "cloudbilling"], "team-b-target": TARGET_APIS });
  const r = run(["slot-2", "--check"], FIXTURE, g.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^OK project team-b-orig$/m);
  assert.match(r.stdout, new RegExp(`^OK apis team-b-target \\(${TARGET_APIS.length} 개\\)$`, "m"));
  assert.match(r.stdout, /^다 있음$/m);
  for (const c of g.calls()) assert.match(c, /^(projects describe |services list --enabled )/, `읽기 전용이 아닌 호출: ${c}`);
});

test("--check: 빠진 API·없는 프로젝트를 줄마다 알리고 끝 코드 1", () => {
  const g = fakeGcloud({ "team-b-orig": ["iamcredentials", "cloudresourcemanager"], "team-b-target": TARGET_APIS.filter((a) => a !== "cloudbilling" && a !== "container") });
  const r = run(["slot-2", "--check"], FIXTURE, g.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^MISSING api team-b-orig cloudbilling\.googleapis\.com$/m);
  assert.match(r.stdout, /^MISSING api team-b-target container\.googleapis\.com$/m);
  assert.match(r.stdout, /^MISSING api team-b-target cloudbilling\.googleapis\.com$/m);
  assert.match(r.stdout, /bash tools\/team-env\.sh slot-2 의 1\)·2\) 명령/);
  const none = run(["slot-2", "--check"], FIXTURE, fakeGcloud({ "team-b-orig": ["iamcredentials", "cloudresourcemanager", "cloudbilling"] }).env);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^MISSING project team-b-target/m);
});

// source: 출발 샘플(3티어 shop, real-app, orders 100행)을 올리는 명령. 찍기만 한다 (gcloud·aws·kubectl 호출 0)
const GCP_SRC = "GCP_PROJECT=iron-source-gcp TF_STATE_BUCKET=iron-source-gcp-tfstate REGION=asia-northeast3";
const rdsQ = (region: string, id: string, field: string) =>
  `aws rds describe-db-instances --region ${region} --db-instance-identifier ${id} --query 'DBInstances[0].${field}' --output text`;

test("source: 레포 등록부 slot-1 은 AWS·GCP 출발 샘플 명령을 등록부 순서로, 값까지 채워 찍는다", () => {
  const r = run(["slot-1", "source"]);
  assert.equal(r.status, 0, r.stderr);
  const cmds = commands(r.stdout);
  assert.deepEqual(cmds, [
    "aws eks update-kubeconfig --name platform-target --region ap-northeast-2 --alias src-aws-sample",
    "kubectl --context src-aws-sample -n real-app get deployment shop-web shop-api",
    "export KUBE_CONTEXT=src-aws-sample NS=real-app AWS_REGION=ap-northeast-2 DB_INSTANCE=sample-shop-db DB_NAME=shop",
    `export DB_HOST="$(${rdsQ("ap-northeast-2", "sample-shop-db", "Endpoint.Address")})"`,
    `export DB_PASSWORD_SECRET_ID="$(${rdsQ("ap-northeast-2", "sample-shop-db", "MasterUserSecret.SecretArn")})"`,
    "bash tools/aws-source-app.sh app",
    "bash tools/aws-source-app.sh seed",
    "gcloud container clusters list --project=iron-source-gcp --format='value(name)'",
    `${GCP_SRC} bash tools/gcp-source.sh up`,
    `${GCP_SRC} bash tools/gcp-source.sh app`,
    `${GCP_SRC} bash tools/gcp-source.sh seed`,
  ]);
  for (const c of cmds) assert.doesNotMatch(c, /<[^>]*>/, `자리 값이 남음: ${c}`);
  // down 은 주석으로만 (복사해 붙여도 지우지 않는다). 공유 환경은 "치지 않는다" 를 알린다
  assert.match(r.stdout, /^# 다 쓴 뒤 .*: bash tools\/aws-source-app\.sh down$/m);
  assert.match(r.stdout, new RegExp(`^# 다 쓴 뒤 .*: ${GCP_SRC} bash tools/gcp-source\\.sh down$`, "m"));
  assert.ok(!cmds.some((c) => / down$/.test(c)));
  assert.equal((r.stdout.match(/^# 공유 환경: .*down 은 치지 않는다/gm) ?? []).length, 2);
  // EKS·RDS 는 만들지 않는다: 먼저 있어야 한다는 것과 만드는 길(콘솔·aws CLI)
  assert.match(r.stdout, /^# 먼저 있어야 하는 것 \(이 도구는 만들지 않는다\): EKS 클러스터 platform-target, 같은 VPC 의 RDS PostgreSQL\(초기 DB 이름 shop\)/m);
  assert.match(r.stdout, /콘솔\(EKS → 클러스터 생성 .*초기 데이터베이스 이름 shop.* 또는 aws CLI\(aws eks create-cluster …, aws rds create-db-instance --engine postgres --db-name shop/);
  // RDS 는 등록부 db_instance 이름으로만 찾는다 (리전의 "첫 PostgreSQL" 을 고르지 않는다: 같은 계정에 platform-db 가 있다)
  assert.ok(cmds.filter((c) => c.includes("describe-db-instances")).every((c) => c.includes("--db-instance-identifier sample-shop-db")));
  assert.doesNotMatch(r.stdout, /Engine==|\|\[0\]/);
  // 이미지: 기본은 태그(buildx 로 digest), @sha256 로 주면 Docker 없이 쓴다는 줄
  assert.equal((r.stdout.match(/^# {4}app·seed 의 기본 이미지는 태그라 docker buildx 로 digest 에 고정한다.*WEB_IMAGE·API_IMAGE·SEED_IMAGE 를 repo@sha256:<digest> 로 export 하면 Docker 없이 그대로 쓴다$/gm) ?? []).length, 2);
  // 연결 명령(gcp-connect·roles update)은 source 에 안 섞인다. 도착(전용) 프로젝트에 샘플을 올리지 않는다
  assert.ok(!r.stdout.includes("gcp-connect.sh") && !r.stdout.includes("roles update"));
  assert.ok(cmds.every((c) => !c.includes("iron-target-gcp")));
});

test("source: 찍힌 DB 조회 줄은 셸에서 그대로 돈다 (식별자·JMESPath 가 인자 그대로 aws 에 간다)", () => {
  const lines = commands(run(["slot-1", "source"]).stdout).filter((c) => c.startsWith("export DB_"));
  assert.equal(lines.length, 2);
  // aws 를 셸 함수로 가로챈다 (PATH 의 진짜 aws 는 안 불림): 받은 인자를 그대로 돌려준다
  const script = `aws() { printf '%s|' "$@"; }\n${lines.join("\n")}\nprintf '%s\\n%s\\n' "$DB_HOST" "$DB_PASSWORD_SECRET_ID"`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "rds|describe-db-instances|--region|ap-northeast-2|--db-instance-identifier|sample-shop-db|--query|DBInstances[0].Endpoint.Address|--output|text|",
    "rds|describe-db-instances|--region|ap-northeast-2|--db-instance-identifier|sample-shop-db|--query|DBInstances[0].MasterUserSecret.SecretArn|--output|text|",
  ]);
});

test("source: 고정본 slot-2 는 블록 모양 GCP 환경 → AWS 환경 순서, 다른 칸 값은 안 섞임, 공유 줄 없음", () => {
  const r = run(["slot-2", "source"], FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  const cmds = commands(r.stdout);
  const gi = cmds.indexOf("GCP_PROJECT=team-b-orig TF_STATE_BUCKET=team-b-orig-tfstate REGION=asia-northeast3 bash tools/gcp-source.sh up");
  const ai = cmds.indexOf("aws eks update-kubeconfig --name b-eks --region ap-northeast-2 --alias s2-src-aws");
  assert.ok(gi >= 0 && ai > gi, cmds.join("\n"));
  assert.ok(cmds.includes("export KUBE_CONTEXT=s2-src-aws NS=real-app AWS_REGION=ap-northeast-2 DB_INSTANCE=b-shop-db DB_NAME=shop"));
  assert.ok(cmds.includes(`export DB_HOST="$(${rdsQ("ap-northeast-2", "b-shop-db", "Endpoint.Address")})"`));
  assert.ok(cmds.every((c) => !/iron-(source|target)-gcp|platform-target|src-aws-sample/.test(c)), "다른 칸 값이 섞이면 안 된다");
  assert.doesNotMatch(r.stdout, /공유 환경/);
  assert.doesNotMatch(r.stdout, /asia-northeast3 고정/);
});

test("source: AWS 만 있는 칸도 찍는다 (연결 명령 모드는 gcp 가 없어 거부 그대로)", () => {
  const reg = `version: 1\ntenant: 11111111-1111-4111-8111-111111111111\nslots:\n  - id: slot-4\n    login: d@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: s4-src-aws, provider: aws, region: us-west-2, cluster: d-eks, db_instance: d-shop-db, notes: "AWS 계정 별칭 d" }\n`;
  const r = run(["slot-4", "source"], reg);
  assert.equal(r.status, 0, r.stderr);
  const cmds = commands(r.stdout);
  assert.equal(cmds[0], "aws eks update-kubeconfig --name d-eks --region us-west-2 --alias s4-src-aws");
  assert.ok(cmds.includes("export KUBE_CONTEXT=s4-src-aws NS=real-app AWS_REGION=us-west-2 DB_INSTANCE=d-shop-db DB_NAME=shop"));
  assert.ok(cmds.includes(`export DB_PASSWORD_SECRET_ID="$(${rdsQ("us-west-2", "d-shop-db", "MasterUserSecret.SecretArn")})"`));
  assert.ok(!r.stdout.includes("gcp-source.sh"));
  const p = run(["slot-4"], reg);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /slot-4 에 provider: gcp 환경이 없음/);
});

test("source: aws 환경에 db_instance 가 없으면 RDS 를 고르지 않고 채우라는 주석만 (DB·app·seed 줄 없음)", () => {
  // 고정본 slot-1 의 src-aws-sample 은 db_instance 가 없다
  const r = run(["slot-1", "source"], FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  const cmds = commands(r.stdout);
  const aws = cmds.slice(0, cmds.findIndex((c) => c.startsWith("gcloud ")));
  assert.deepEqual(aws, [
    "aws eks update-kubeconfig --name platform-target --region ap-northeast-2 --alias src-aws-sample",
    "kubectl --context src-aws-sample -n real-app get deployment shop-web shop-api",
  ]);
  assert.ok(!cmds.some((c) => /describe-db-instances|aws-source-app\.sh|^export /.test(c)), cmds.join("\n"));
  assert.match(r.stdout, /^# 3\) DB: 등록부의 src-aws-sample 에 db_instance\(RDS 식별자\)가 없어 DB·app·seed 줄을 찍지 않는다 \(리전의 아무 PostgreSQL 이나 고르지 않는다\. 같은 계정에 플랫폼 DB platform-db 가 있다\)$/m);
  assert.match(r.stdout, /^# {4}docs\/team-env\/registry\.yaml 의 src-aws-sample 줄에 db_instance: <자기 샘플 RDS 식별자> 를 더하고 다시: bash tools\/team-env\.sh slot-1 source$/m);
  // 같은 칸의 GCP 환경 명령은 그대로 찍힌다
  assert.ok(cmds.includes(`${GCP_SRC} bash tools/gcp-source.sh up`));
});

test("source: 찍힌 slot-1 AWS 줄을 그대로 돌리면 aws-source-app.sh app·seed --dry-run 이 통과한다 (DB_INSTANCE·DB_HOST 가 맞물림)", () => {
  const lines = commands(run(["slot-1", "source"]).stdout).filter((c) => c.startsWith("export ") || c.startsWith("bash tools/aws-source-app.sh"));
  assert.equal(lines.length, 5);
  // aws 는 셸 함수로 가로챈다 (진짜 aws 안 불림). 엔드포인트·비밀 ARN 모양만 돌려준다
  const fake = `aws() { case "$*" in *Endpoint.Address*) echo sample-shop-db.abc123xyz.ap-northeast-2.rds.amazonaws.com ;; *) echo 'arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:rds!db-x' ;; esac; }`;
  const script = [fake, ...lines.map((l) => l.startsWith("bash ") ? `${l} --dry-run || exit $?` : l)].join("\n");
  const home = mkdtempSync(join(tmpdir(), "team-env-src-"));
  const r = spawnSync("bash", ["-c", script], { cwd: ROOT, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /app 시작 dry=1 ctx=src-aws-sample ns=real-app db=sample-shop-db\/shop/);
  assert.match(r.stdout, /seed 시작 dry=1 ctx=src-aws-sample ns=real-app db=sample-shop-db\/shop/);
  assert.match(r.stdout, /delete job\/shop-seed secret\/shop-seed-db configmap\/shop-seed-sql/);
});

test("source: GCP 리전이 서울이 아니면 샘플 모듈이 서울 고정이라는 줄을 더한다", () => {
  const r = run(["slot-2", "source"], FIXTURE.replace("region: asia-northeast3\n        gcp:", "region: us-central1\n        gcp:"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(commands(r.stdout).includes("GCP_PROJECT=team-b-orig TF_STATE_BUCKET=team-b-orig-tfstate REGION=us-central1 bash tools/gcp-source.sh up"));
  assert.match(r.stdout, /^# 샘플 모듈\(infra\/samples\/gcp-source\)은 asia-northeast3 고정이다/m);
});

test("source 거부: 환경 없는 칸·cluster 없음·자리 값 cluster·리전 모양·컨텍스트로 못 쓰는 이름·db_instance(platform-db·모양·gcp) (명령을 하나도 안 찍는다)", () => {
  const empty = run(["slot-2", "source"]);
  assert.equal(empty.status, 2);
  assert.equal(empty.stdout, "");
  assert.match(empty.stderr, /slot-2 에 provider: aws·gcp 환경이 없음/);
  const cases: Array<[string, string, RegExp]> = [
    ["cluster 없음", FIXTURE.replace(", cluster: b-eks,", ","), /s2-src-aws: aws 환경에 cluster\(EKS 이름\)를 채운다/],
    ["자리 값 cluster", FIXTURE.replace("cluster: b-eks", "cluster: <EKS 이름>"), /cluster 가 EKS 이름 모양이 아님/],
    ["AWS 리전", FIXTURE.replace("provider: aws, region: ap-northeast-2, cluster: b-eks", "provider: aws, region: seoul, cluster: b-eks"), /region 이 AWS 리전 모양이 아님: seoul/],
    ["GCP 리전 없음", FIXTURE.replace("        region: asia-northeast3\n", ""), /s2-gcp: region 이 GCP 리전 모양이 아님/],
    ["이름", FIXTURE.replace("name: s2-src-aws", 'name: "s2 src;aws"'), /kubectl 컨텍스트 이름으로 못 씀/],
    ["db_instance = platform-db", FIXTURE.replace("db_instance: b-shop-db", "db_instance: platform-db"), /s2-src-aws: db_instance 에 platform-db 가 들어 있음/],
    ["db_instance 에 platform-db", FIXTURE.replace("db_instance: b-shop-db", "db_instance: platform-db-replica"), /db_instance 에 platform-db 가 들어 있음/],
    ["db_instance 모양", FIXTURE.replace("db_instance: b-shop-db", "db_instance: B_Shop;db"), /db_instance 가 RDS 식별자 모양이 아님/],
    ["db_instance 자리 값", FIXTURE.replace("db_instance: b-shop-db", "db_instance: <샘플 RDS 식별자>"), /db_instance 가 RDS 식별자 모양이 아님/],
    ["gcp 에 db_instance", FIXTURE.replace("        notes: \"블록 모양\"", "        db_instance: b-shop-db\n        notes: \"블록 모양\""), /s2-gcp: db_instance 는 provider: aws 환경에만 쓴다/],
  ];
  for (const [name, reg, err] of cases) {
    const r = run(["slot-2", "source"], reg);
    assert.equal(r.status, 2, name);
    assert.equal(r.stdout, "", name);
    assert.match(r.stderr, err, name);
  }
});

test("db_instance 규칙은 연결 명령 모드에도 같다 (gcp 환경에 쓰면 거부, aws 환경 값은 연결 명령에 안 섞임)", () => {
  const ok = run(["slot-2"], FIXTURE);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!ok.stdout.includes("b-shop-db"));
  const bad = run(["slot-2"], FIXTURE.replace("        notes: \"블록 모양\"", "        db_instance: b-shop-db\n        notes: \"블록 모양\""));
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /db_instance 는 provider: aws 환경에만 쓴다/);
});
