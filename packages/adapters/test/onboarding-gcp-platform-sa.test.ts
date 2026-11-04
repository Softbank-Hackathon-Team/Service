// GCP 플랫폼 쪽 회사 전용 SA 스크립트 (infra/onboarding/gcp-platform-tenant-sa.sh). DRY_RUN·가짜 gcloud 만, 진짜 gcloud 안 부름
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../../../infra/onboarding/gcp-platform-tenant-sa.sh", import.meta.url).pathname;
const TENANT = "11111111-1111-4111-8111-111111111111";
const WORKER = "serviceAccount:svc-worker@svc-platform.iam.gserviceaccount.com";
function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gcloud-")), log = join(dir, "log");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`); chmodSync(join(dir, "gcloud"), 0o755);
  const r = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, ...env } });
  return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("정상: 회사 SA 이름 = t- + md5(회사 UUID) 앞 28자 (DB 0029 규칙과 같음), 워커에게 그 SA 의 tokenCreator 만 (DRY_RUN 은 gcloud 0번)", () => {
  const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  const id = "t-" + createHash("md5").update(TENANT).digest("hex").slice(0, 28);
  assert.match(r.stdout, new RegExp(`service-accounts create ${id} --project=svc-platform`));
  const tc = r.stdout.split("\n").filter((l) => l.includes("serviceAccountTokenCreator"));
  assert.equal(tc.length, 1);
  assert.ok(tc[0]!.includes(`add-iam-policy-binding ${id}@svc-platform.iam.gserviceaccount.com`) && tc[0]!.includes(`--member=${WORKER}`));
  assert.doesNotMatch(r.stdout, /projects add-iam-policy-binding|keys create/);
});

test("거부: 사람 계정·allUsers 주체, UUID 아닌 회사 번호, 틀린 프로젝트 ID 는 만들기 전에 종료", () => {
  for (const env of [{ WORKER_PRINCIPAL: "user:me@example.com" }, { WORKER_PRINCIPAL: "allUsers" }, { TENANT_ID: "not-a-uuid" }, { PLATFORM_PROJECT: "Bad_Prj" }]) {
    const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1", ...env });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.doesNotMatch(r.stdout, /create|add-iam-policy-binding/);
  }
});

// 맥에는 md5sum 이 없다 (md5 -q 만). md5sum 없이 PATH 를 좁혀 맥처럼 돌린다
function runPath(tools: Record<string, string>, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mac-path-"));
  for (const t of ["cut", "tr"]) writeFileSync(join(dir, t), `#!/bin/sh\nexec /usr/bin/${t} "$@"\n`);
  for (const [n, body] of Object.entries(tools)) writeFileSync(join(dir, n), `#!/bin/sh\n${body}\n`);
  for (const n of ["cut", "tr", ...Object.keys(tools)]) chmodSync(join(dir, n), 0o755);
  return spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: dir, ...env } });
}
const BASE = { PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1" };
const ID = "t-" + createHash("md5").update(TENANT).digest("hex").slice(0, 28);

test("맥처럼 md5sum 이 없어도: md5 -q 로 같은 SA 이름, openssl 만 있어도 같은 이름", () => {
  const mac = runPath({ md5: `[ "$1" = "-q" ] || exit 9\nexec /usr/bin/md5sum | /usr/bin/cut -d' ' -f1` }, BASE);
  assert.equal(mac.status, 0, mac.stderr);
  assert.match(mac.stdout, new RegExp(`service-accounts create ${ID} --project=svc-platform`));
  const ossl = runPath({ openssl: `exec /usr/bin/md5sum | /usr/bin/sed 's/  -$/ */'` }, BASE);   // openssl md5 -r 출력 모양: "<해시> *stdin"
  assert.equal(ossl.status, 0, ossl.stderr);
  assert.match(ossl.stdout, new RegExp(`service-accounts create ${ID} --project=svc-platform`));
});

test("거부: md5 도구가 하나도 없으면 127 + 무엇이 필요한지 알림 (SA 만들기 명령 안 나감)", () => {
  const r = runPath({}, BASE);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /md5sum·md5·openssl/);
  assert.doesNotMatch(r.stdout, /service-accounts create/);
});
