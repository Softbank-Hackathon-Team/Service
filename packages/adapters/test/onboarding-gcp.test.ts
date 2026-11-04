// GCP 연결 스크립트(infra/onboarding/gcp-connect.sh) 정적 검사. gcloud는 실행하지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const path = new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url);
const src = readFileSync(path, "utf8");
const lines = src.split("\n").filter((l) => !l.trim().startsWith("#"));
const code = lines.join("\n");

test("문법 오류 없음(bash -n)", () => {
  const r = spawnSync("bash", ["-n", path.pathname]);
  assert.equal(r.status, 0, String(r.stderr));
});

// 멱등화(VL7sb)로 명령이 함수 안으로 들어갔다 → 글자 대신 DRY_RUN 출력(실제로 실행될 명령)으로 검사한다
const SA = "t-" + "0123456789abcdef0123456789ab" + "@platform-prj.iam.gserviceaccount.com";
const dryOut = () => spawnSync("bash", [path.pathname], {
  env: { PATH: process.env.PATH, PLATFORM_SA: SA, PROJECT_ID: "cust-prj", DRY_RUN: "1" }, encoding: "utf8" }).stdout;

test("SA 2개(svc-observe·svc-operate), 커스텀 역할 3개", () => {
  const out = dryOut();
  assert.equal((out.match(/service-accounts create svc-(observe|operate)\b/g) ?? []).length, 2);
  for (const r of ["platform_observe", "platform_operate", "platform_operate_iam"])
    assert.ok(out.includes(`roles create ${r}`), r);
  assert.ok(out.includes("gcp-operate-custom-role.yaml") && out.includes("gcp-operate-iam-custom-role.yaml"));
  // IAM 정책 변경 역할은 조건부 바인딩
  assert.match(out, /roles\/platform_operate_iam --condition-from-file=\S*permissions\/gcp-operate-iam-binding-condition\.json/);
  // ID-4: 실행 역할도 조건부 (플랫폼 이름 규칙 자원만)
  assert.match(out, /roles\/platform_operate --condition-from-file=\S*permissions\/gcp-operate-binding-condition\.json/);
});

test("ID-4 조건식: 이름 규칙 자원만 통과, 남의 자원은 막힘 (두 파일 합쳐서)", () => {
  const rd = (f: string) => JSON.parse(readFileSync(new URL(`../../../infra/permissions/${f}`, import.meta.url), "utf8")).expression as string;
  const x = rd("gcp-operate-binding-condition.json") + " || " + rd("gcp-operate-binding-condition-2.json");
  for (const t of ["sqladmin.googleapis.com/Instance", "redis.googleapis.com/Instance", "iam.googleapis.com/ServiceAccount", "secretmanager.googleapis.com/Secret",
    "secretmanager.googleapis.com/SecretVersion", "storage.googleapis.com/Bucket", "pubsub.googleapis.com/Topic", "pubsub.googleapis.com/Subscription"])
    assert.ok(x.includes(`resource.type == "${t}"`), t);
  assert.ok(x.includes('resource.service == "container.googleapis.com"'));
  // Cloud SQL 이름 규칙: <앱>-pg-<해시6>. IAM 조건엔 matches(정규식)가 없어 extract("/instances/{name}-pg-") != "" 로 ("-pg-" 앞에 앱 이름이 있어야 함)
  assert.ok(x.includes('resource.name.extract("/instances/{name}-pg-") != ""'));
  assert.doesNotMatch(x, /matches\(/);
  assert.deepEqual([...new Set([...x.matchAll(/startsWith\("([^"]+)"\)/g)].map((m) => m[1]))].sort(), ["app-", "projects/_/buckets/app-"]);
});

test("tokenCreator는 회사 전용 SA에게, SA 단위로만", () => {
  const out = dryOut();
  const bindings = out.split("\n").filter((l) => l.includes("roles/iam.serviceAccountTokenCreator"));
  assert.equal(bindings.length, 3);   // 관찰·plan(ID-7)·실행
  assert.ok(bindings.every((l) => l.includes(`--member=serviceAccount:${SA}`) && l.includes("service-accounts add-iam-policy-binding")));
  // 프로젝트 전체에 tokenCreator 금지
  assert.ok(!out.split("\n").some((l) => l.includes("projects add-iam-policy-binding") && l.includes("tokenCreator")));
  assert.ok(code.includes("service-accounts add-iam-policy-binding"));
});

test("거부: 키 파일·소유자/편집자 역할·impersonate 실행 없음", () => {
  assert.ok(!/keys create/.test(code));
  assert.ok(!/roles\/(owner|editor|admin)|roles\/iam\.serviceAccountAdmin/.test(code));
  assert.ok(!/--impersonate/.test(code));
});

test("PLATFORM_SA 이름 규칙: 회사 전용 SA만 통과, 아니면 만들기 전에 종료", () => {
  const ok = "t-" + "0123456789abcdef".repeat(2).slice(0, 28) + "@platform-prj.iam.gserviceaccount.com";
  const run = (sa: string) => spawnSync("bash", [path.pathname], {
    env: { PATH: process.env.PATH, PLATFORM_SA: sa, PROJECT_ID: "cust-prj", DRY_RUN: "1" }, encoding: "utf8" });
  const good = run(ok);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /serviceAccount:t-[0-9a-f]{28}@platform-prj/);
  for (const bad of ["someone@gmail.com", "t-1234@platform-prj.iam.gserviceaccount.com", "svc-observe@x.iam.gserviceaccount.com"]) {
    const r = run(bad);
    assert.notEqual(r.status, 0, bad);
    assert.ok(!r.stdout.includes("service-accounts create"), "거부 전에 만들면 안 됨");
  }
});

test("ID-7: plan SA 는 읽기 동사(get·list·getIamPolicy)만 가진 plan 역할을 받고, 실행 역할의 지우기·만들기 권한은 없다", () => {
  const out = spawnSync("bash", [path.pathname], { encoding: "utf8", env: { PATH: process.env.PATH, PLATFORM_SA: SA, PROJECT_ID: "cust-prj", DRY_RUN: "1",
    ROLE_DIR: new URL("../../../infra/permissions", import.meta.url).pathname } }).stdout.split("\n");
  const plan = out.find((l) => l.includes("roles create platform_plan"))!;
  const perms = /--permissions=(\S+)/.exec(plan)![1]!.split(",");
  assert.ok(perms.includes("cloudsql.instances.get") && perms.includes("secretmanager.secrets.get"));
  assert.equal(perms.filter((p) => /\.(create|delete|update|setIamPolicy|access)$/.test(p)).length, 0, perms.join(","));
  assert.equal(new Set(perms).size, perms.length, "중복 없음");
  assert.ok(out.some((l) => l.includes("--member=serviceAccount:svc-plan@cust-prj.iam.gserviceaccount.com") && l.includes("roles/platform_plan")));
});

// FM-CON-03: 연결 명령이 infra 기준 상대 경로라 레포 루트에서 치면 역할 파일을 못 찾았다 → 스크립트 옆 permissions 로 잡고, 그래도 없으면 만들기 전에 멈춤
test("FM-CON-03: 레포 루트에서 ROLE_DIR 없이(또는 틀린 ./permissions 로) 쳐도 infra/permissions 파일로 실행 역할까지 만든다", () => {
  const repo = new URL("../../../", import.meta.url).pathname;
  for (const extra of [{}, { ROLE_DIR: "./permissions" }] as Record<string, string>[]) {
    const r = spawnSync("bash", ["infra/onboarding/gcp-connect.sh"], { cwd: repo, encoding: "utf8",
      env: { PATH: process.env.PATH, PLATFORM_SA: SA, PROJECT_ID: "cust-prj", DRY_RUN: "1", ...extra } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /roles create platform_operate --project=cust-prj --file=\S*infra\/permissions\/gcp-operate-custom-role\.yaml/);
    assert.match(r.stdout, /roles\/platform_operate --condition-from-file=\S*infra\/permissions\/gcp-operate-binding-condition\.json/);
  }
});
test("FM-CON-03 거부: 역할 파일을 어디서도 못 찾으면 exit 2, SA·역할 만들기 명령이 하나도 안 나간다", async () => {
  const { mkdtempSync, copyFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const d = mkdtempSync(`${tmpdir()}/gcp-connect-`); mkdirSync(`${d}/onboarding`);
  copyFileSync(path.pathname, `${d}/onboarding/gcp-connect.sh`);   // 옆에 permissions 없는 사본
  const r = spawnSync("bash", [`${d}/onboarding/gcp-connect.sh`], { cwd: d, encoding: "utf8",
    env: { PATH: process.env.PATH, PLATFORM_SA: SA, PROJECT_ID: "cust-prj", DRY_RUN: "1", ROLE_DIR: "./permissions" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /역할 파일 없음/);
  assert.doesNotMatch(r.stdout, /create|add-iam-policy-binding/);
});
