// VL7sb: gcp-connect.sh 멱등 시험. 상태를 가진 가짜 gcloud(진짜 gcloud 는 실행하지 않음)로 처음 실행·재실행·부분 상태를 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url).pathname;
const SA = "t-0123456789abcdef0123456789ab@platform-prj.iam.gserviceaccount.com";
const PRJ = "cust-prj";
const OBS = `svc-observe@${PRJ}.iam.gserviceaccount.com`, OPR = `svc-operate@${PRJ}.iam.gserviceaccount.com`;

// 가짜 gcloud: state/ 아래 파일로 SA·역할·바인딩을 기억한다. 이미 있는 것을 또 만들면 실패(진짜 gcloud 처럼). 모든 호출은 calls.log
const FAKE = `#!/bin/bash
S="$GCLOUD_STATE"; echo "$*" >> "$S/calls.log"
args="$*"
fail_if="$S/fail"; [ -f "$fail_if" ] && grep -qF -- "$(cat "$fail_if")" <<<"$args" && { echo "PERMISSION_DENIED" >&2; exit 1; }
case "$args" in
  "iam service-accounts describe "*) [ -f "$S/sa/$4" ] ;;
  "iam service-accounts create "*) n="$4@\${5#--project=}.iam.gserviceaccount.com"; [ -f "$S/sa/$n" ] && { echo "already exists" >&2; exit 1; }; touch "$S/sa/$n" ;;
  "iam roles describe "*) [ -f "$S/role/$4" ] || exit 1; [ -f "$S/role/$4.deleted" ] && echo "deleted: true"; echo "name: x" ;;
  "iam roles create "*) [ -f "$S/role/$4" ] && { echo "already exists" >&2; exit 1; }; touch "$S/role/$4" ;;
  "iam roles undelete "*) rm -f "$S/role/$4.deleted" ;;
  "projects get-iam-policy "*)
    role=$(grep -o 'bindings.role=[^ ]*' <<<"$args" | head -1 | cut -d= -f2); mem=$(grep -o 'bindings.members=[^ "]*' <<<"$args" | head -1 | cut -d= -f2)
    if grep -q 'condition.expression' <<<"$args"; then pat="^$mem $role cond$"; else pat="^$mem $role"; fi
    grep -q "$pat" "$S/pbind" 2>/dev/null && echo "$role" ;;
  "projects add-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); role=$(grep -o -- '--role=[^ ]*' <<<"$args" | cut -d= -f2)
    c=""; grep -q -- '--condition-from-file' <<<"$args" && c=" cond"; echo "$mem $role$c" >> "$S/pbind" ;;
  "iam service-accounts get-iam-policy "*)
    t="$4"; mem=$(grep -o 'bindings.members=[^ "]*' <<<"$args" | head -1 | cut -d= -f2)
    grep -q "^$t $mem" "$S/sabind" 2>/dev/null && echo "roles/iam.serviceAccountTokenCreator" ;;
  "iam service-accounts add-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); echo "$4 $mem" >> "$S/sabind" ;;
  "projects describe "*) echo 123456 ;;
  *) echo "unexpected: $args" >&2; exit 2 ;;
esac
`;

function env() {
  const root = mkdtempSync(join(tmpdir(), "idem-"));
  const state = join(root, "state");
  for (const d of ["sa", "role"]) mkdirSync(join(state, d), { recursive: true });
  writeFileSync(join(root, "gcloud"), FAKE); chmodSync(join(root, "gcloud"), 0o755);
  return {
    state,
    calls: () => (existsSync(join(state, "calls.log")) ? readFileSync(join(state, "calls.log"), "utf8").trim().split("\n") : []),
    run: (extra: Record<string, string> = {}) => spawnSync("bash", [script], { encoding: "utf8",
      env: { PATH: `${root}:/usr/bin:/bin`, GCLOUD_STATE: state, PLATFORM_SA: SA, PROJECT_ID: PRJ, ROLE_DIR: "./permissions", ...extra } }),
  };
}
const MUTATING = /^(iam service-accounts create|iam roles create|iam roles undelete|projects add-iam-policy-binding|iam service-accounts add-iam-policy-binding)/;
const mutations = (calls: string[]) => calls.filter((c) => MUTATING.test(c));

test("처음 실행: SA 2 + 역할 3 + 프로젝트 바인딩 3 + tokenCreator 2 = 변경 10번", () => {
  const e = env();
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mutations(e.calls()).length, 10);
  assert.match(r.stdout, /123456/);
  assert.ok(!r.stdout.includes("건너뜀"));
});

test("재실행: 변경 명령 0번, 전부 '건너뜀', 종료 0 (확인 명령만 부름)", () => {
  const e = env();
  assert.equal(e.run().status, 0);
  const before = e.calls().length;
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const second = e.calls().slice(before);
  assert.equal(mutations(second).length, 0, "재실행에서 변경 명령: " + mutations(second).join(" | "));
  assert.equal((r.stdout.match(/이미 있음, 건너뜀/g) ?? []).length, 10);
  assert.ok(second.length >= 10, "각 항목을 먼저 확인");
});

test("부분 상태: 관찰 SA·관찰 역할만 있으면 나머지만 만든다", () => {
  const e = env();
  writeFileSync(join(e.state, "sa", OBS), ""); writeFileSync(join(e.state, "role", "platform_observe"), "");
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const m = mutations(e.calls());
  assert.equal(m.length, 8);
  assert.ok(!m.some((c) => c.includes("service-accounts create svc-observe")) && !m.some((c) => c.includes("roles create platform_observe ")));
  assert.ok(m.some((c) => c.includes("service-accounts create svc-operate")));
});

test("삭제 표시된 역할은 create 가 아니라 undelete 로 되살린다", () => {
  const e = env();
  writeFileSync(join(e.state, "role", "platform_operate"), ""); writeFileSync(join(e.state, "role", "platform_operate.deleted"), "");
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const m = mutations(e.calls());
  assert.ok(m.some((c) => c.startsWith("iam roles undelete platform_operate ")));
  assert.ok(!m.some((c) => c.startsWith("iam roles create platform_operate ")));
});

test("조건부 바인딩: 조건 없는 같은 역할 바인딩이 있어도 조건부는 따로 추가한다", () => {
  const e = env();
  appendFileSync(join(e.state, "pbind"), `serviceAccount:${OPR} projects/${PRJ}/roles/platform_operate_iam\n`);
  assert.equal(e.run().status, 0);
  const iam = mutations(e.calls()).filter((c) => c.includes("platform_operate_iam") && c.startsWith("projects add"));
  assert.equal(iam.length, 1);
  assert.ok(iam[0]!.includes("--condition-from-file"));
});

test("tokenCreator 는 SA 단위로 확인: 한쪽만 있으면 다른 쪽만 추가", () => {
  const e = env();
  appendFileSync(join(e.state, "sabind"), `${OBS} serviceAccount:${SA}\n`);
  assert.equal(e.run().status, 0);
  const tc = mutations(e.calls()).filter((c) => c.startsWith("iam service-accounts add-iam-policy-binding"));
  assert.equal(tc.length, 1);
  assert.ok(tc[0]!.includes(OPR));
});

test("거부: 다른 회사 SA 가 이미 tokenCreator 여도 이 회사 SA 는 추가된다(주체 구분)", () => {
  const e = env();
  const other = "t-ffffffffffffffffffffffffffff@platform-prj.iam.gserviceaccount.com";
  appendFileSync(join(e.state, "sabind"), `${OBS} serviceAccount:${other}\n${OPR} serviceAccount:${other}\n`);
  assert.equal(e.run().status, 0);
  assert.equal(mutations(e.calls()).filter((c) => c.startsWith("iam service-accounts add-iam-policy-binding")).length, 2);
});

test("확인이 권한 오류로 실패하면 '없다'로 보고 만들기를 시도, 만들기 오류는 그대로 종료(비0)", () => {
  const e = env();
  writeFileSync(join(e.state, "fail"), "iam roles create platform_observe");
  const r = e.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PERMISSION_DENIED/);
  assert.ok(!e.calls().some((c) => c.startsWith("projects add-iam-policy-binding")), "실패 뒤 권한 연결로 넘어가면 안 됨");
});

test("DRY_RUN 은 확인 명령도 안 부르고, 이미 있어도 전부 출력(있다고 가정 안 함)", () => {
  const e = env();
  assert.equal(e.run().status, 0);
  const before = e.calls().length;
  const r = e.run({ DRY_RUN: "1" });
  assert.equal(r.status, 0);
  assert.equal(e.calls().length, before, "DRY_RUN 중 gcloud 호출 없음");
  assert.equal((r.stdout.match(/^\+ gcloud/gm) ?? []).length, 10);
});
