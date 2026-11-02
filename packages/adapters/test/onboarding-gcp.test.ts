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
  assert.match(out, /roles\/platform_operate_iam --condition-from-file=\.\/permissions\/gcp-operate-iam-binding-condition\.json/);
});

test("tokenCreator는 회사 전용 SA에게, SA 단위로만", () => {
  const out = dryOut();
  const bindings = out.split("\n").filter((l) => l.includes("roles/iam.serviceAccountTokenCreator"));
  assert.equal(bindings.length, 2);
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
