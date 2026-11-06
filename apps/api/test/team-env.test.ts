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
      - { name: s2-src-aws, provider: aws, region: ap-northeast-2, cluster: b-eks }
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
