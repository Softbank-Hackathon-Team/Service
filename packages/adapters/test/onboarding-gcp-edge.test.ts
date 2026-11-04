// VL7s: GCP 연결 스크립트 경계·거부 보강. gcloud 는 가짜(호출 기록용)로만 쓰고 진짜는 실행하지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url).pathname;
const permDir = new URL("../../../infra/permissions", import.meta.url).pathname;
const HEX28 = "0123456789abcdef0123456789ab";
const GOOD = `t-${HEX28}@platform-prj.iam.gserviceaccount.com`;

/** 가짜 gcloud: 부른 인자를 로그에 남기고 실패한다. PATH 맨 앞에 둬서 진짜 gcloud 가 절대 안 불리게 한다 */
function fakeGcloud() {
  const dir = mkdtempSync(join(tmpdir(), "fake-gcloud-"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(dir, "gcloud"), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}
function run(env: Record<string, string>, g = fakeGcloud()) {
  const r = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: `${g.dir}:/usr/bin:/bin`, DRY_RUN: "1", TARGET_PROJECT_ID: "cust-mig", ...env } });
  return { ...r, calls: g.calls() };
}

test("DRY_RUN=1 이면 gcloud 를 한 번도 부르지 않는다(프로젝트 번호 조회 포함)", () => {
  const r = run({ PLATFORM_SA: GOOD, PROJECT_ID: "cust-prj" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls, "", "DRY_RUN 인데 gcloud 호출됨: " + r.calls);
  assert.match(r.stdout, /<DRY_RUN>/);
});

test("DRY_RUN 출력: 순서(SA → 역할 → 바인딩 → tokenCreator)와 SA 단위 tokenCreator 2개", () => {
  const out = run({ PLATFORM_SA: GOOD, PROJECT_ID: "cust-prj" }).stdout;
  const idx = (re: RegExp) => out.search(re);
  assert.ok(idx(/service-accounts create svc-observe/) < idx(/roles create platform_observe/));
  // 결정 3번 A안: 프로젝트마다 SA → 역할 → 바인딩 → tokenCreator (원래 다음 전용)
  assert.ok(idx(/roles create platform_operate_iam/) < idx(/projects add-iam-policy-binding cust-mig/));
  assert.ok(idx(/projects add-iam-policy-binding cust-prj/) < idx(/serviceAccountTokenCreator/));
  assert.ok(idx(/projects add-iam-policy-binding cust-mig/) < idx(/svc-operate@cust-mig\.iam\.gserviceaccount\.com --project=cust-mig --member=\S+ --role=roles\/iam\.serviceAccountTokenCreator/));
  const tc = out.split("\n").filter((l) => l.includes("serviceAccountTokenCreator"));
  assert.equal(tc.length, 3);
  assert.ok(tc.some((l) => l.includes("svc-observe@cust-prj.iam")) && tc.some((l) => l.includes("svc-plan@cust-mig.iam")) && tc.some((l) => l.includes("svc-operate@cust-mig.iam")));
  assert.ok(tc.every((l) => l.includes(`serviceAccount:${GOOD}`) && l.includes("service-accounts add-iam-policy-binding")));
});

test("스크립트가 참조하는 ROLE_DIR 파일 3개가 infra/permissions 에 실제로 있다", () => {
  const src = readFileSync(script, "utf8");
  for (const f of src.match(/gcp-operate[a-z-]*\.(yaml|json)/g) ?? []) assert.ok(existsSync(join(permDir, f)), f);
});

test("거부: PLATFORM_SA 경계 — 28자 정확히 통과, 27·29자·대문자·줄바꿈 덧붙임·다른 도메인은 gcloud 호출 전에 종료", () => {
  const bad = [
    `t-${HEX28.slice(1)}@platform-prj.iam.gserviceaccount.com`,
    `t-${HEX28}0@platform-prj.iam.gserviceaccount.com`,
    `t-${HEX28.toUpperCase()}@platform-prj.iam.gserviceaccount.com`,
    `${GOOD}\nevil@x.iam.gserviceaccount.com`,
    `${GOOD}.evil.com`,
    `t-${HEX28}@platform-prj.iam.gserviceaccount.com ; rm -rf /`,
    `t-${HEX28}@gmail.com`,
    "",
  ];
  for (const sa of bad) {
    const r = run({ PLATFORM_SA: sa, PROJECT_ID: "cust-prj" });
    assert.notEqual(r.status, 0, JSON.stringify(sa));
    assert.ok(!r.stdout.includes("service-accounts"), "만들기 전에 종료: " + JSON.stringify(sa));
    assert.equal(r.calls, "");
  }
});

test("거부: PLATFORM_SA 없음 → 종료, PROJECT_ID 없고 gcloud 기본값도 없으면 종료(아무것도 안 만듦)", () => {
  const a = run({ PROJECT_ID: "cust-prj" });
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /PLATFORM_SA/);
  const b = run({ PLATFORM_SA: GOOD });
  assert.notEqual(b.status, 0);
  assert.ok(!b.stdout.includes("service-accounts"));
});

test("PROJECT_ID 에 공백·셸 문자가 있어도 인자 하나로만 전달된다(명령 주입 없음)", () => {
  const marker = join(mkdtempSync(join(tmpdir(), "inj-")), "pwned");
  const r = run({ PLATFORM_SA: GOOD, PROJECT_ID: `p; touch ${marker}` });
  assert.ok(!existsSync(marker), "주입된 명령이 실행됨");
  assert.ok(r.stdout.includes(`svc-observe@p; touch ${marker}.iam`) || r.status === 0);
});
