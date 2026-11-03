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
  "iam roles describe "*--format=value*) [ -f "$S/role/$4" ] || exit 1; tr ',' ';' < "$S/role/$4" ;;
  "iam roles describe "*) [ -f "$S/role/$4" ] || exit 1; [ -f "$S/role/$4.deleted" ] && echo "deleted: true"; echo "name: x" ;;
  "iam roles create "*) [ -f "$S/role/$4" ] && { echo "already exists" >&2; exit 1; }; grep -o -- '--permissions=[^ ]*' <<<"$args" | cut -d= -f2 | tr -d '\n' > "$S/role/$4" ;;
  "iam roles update "*) [ -f "$S/role/$4" ] || exit 1; add=$(grep -o -- '--add-permissions=[^ ]*' <<<"$args" | cut -d= -f2); { cat "$S/role/$4"; echo -n ",$add"; } > "$S/role/$4.new"; mv "$S/role/$4.new" "$S/role/$4" ;;
  "iam roles undelete "*) rm -f "$S/role/$4.deleted" ;;
  "projects get-iam-policy "*)
    role=$(grep -o 'bindings.role=[^ ]*' <<<"$args" | head -1 | cut -d= -f2); mem=$(grep -o 'bindings.members=[^ "]*' <<<"$args" | head -1 | cut -d= -f2)
    if grep -q 'condition.expression' <<<"$args"; then pat="^$mem $role cond$"; elif grep -q 'NOT bindings.condition' <<<"$args"; then pat="^$mem $role$"; else pat="^$mem $role"; fi
    grep -q "$pat" "$S/pbind" 2>/dev/null && echo "$role" ;;
  "projects add-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); role=$(grep -o -- '--role=[^ ]*' <<<"$args" | cut -d= -f2)
    c=""; grep -q -- '--condition-from-file' <<<"$args" && c=" cond"; echo "$mem $role$c" >> "$S/pbind" ;;
  "projects remove-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); role=$(grep -o -- '--role=[^ ]*' <<<"$args" | cut -d= -f2)
    grep -vx "$mem $role" "$S/pbind" > "$S/pbind.new"; mv "$S/pbind.new" "$S/pbind" ;;
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
const MUTATING = /^(iam service-accounts create|iam roles create|iam roles update|iam roles undelete|projects add-iam-policy-binding|projects remove-iam-policy-binding|iam service-accounts add-iam-policy-binding)/;
const mutations = (calls: string[]) => calls.filter((c) => MUTATING.test(c));

test("처음 실행: SA 3 + 역할 5 + 프로젝트 바인딩 5 + tokenCreator 3 = 변경 16번 (ID-7 plan SA·역할, ID-2 DB 비밀번호 역할 포함)", () => {
  const e = env();
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mutations(e.calls()).length, 16);
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
  assert.equal((r.stdout.match(/이미 있음, 건너뜀/g) ?? []).length, 16);
  assert.ok(second.length >= 10, "각 항목을 먼저 확인");
});

test("부분 상태: 관찰 SA·관찰 역할만 있으면 나머지만 만든다", () => {
  const e = env();
  writeFileSync(join(e.state, "sa", OBS), ""); writeFileSync(join(e.state, "role", "platform_observe"), "");
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const m = mutations(e.calls());
  // OBSROLE3: 있는 관찰 역할에 권한이 비어 있으면 create 가 아니라 update(add-permissions) 1번이 더해진다 (8 → 9)
  assert.equal(m.length, 15);
  assert.equal(m.filter((c) => c.startsWith("iam roles update platform_observe ")).length, 1);
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

test("ID-4: 실행 역할은 조건부로 묶고, 예전 조건 없는 바인딩은 걷어낸다 (관찰·plan 은 조건 없음 그대로)", () => {
  const e = env();
  appendFileSync(join(e.state, "pbind"), `serviceAccount:${OPR} projects/${PRJ}/roles/platform_operate\n`);
  assert.equal(e.run().status, 0);
  const m = mutations(e.calls());
  const add = m.filter((c) => c.startsWith("projects add") && c.includes("roles/platform_operate "));
  assert.equal(add.length, 1); assert.ok(add[0]!.includes("--condition-from-file=./permissions/gcp-operate-binding-condition.json"));
  const rm = m.filter((c) => c.startsWith("projects remove-iam-policy-binding"));
  assert.equal(rm.length, 1); assert.ok(rm[0]!.includes("roles/platform_operate ") && rm[0]!.includes("--condition=None"));
  const left = readFileSync(join(e.state, "pbind"), "utf8").split("\n").filter((l) => l.includes("roles/platform_operate "));
  assert.deepEqual(left, [`serviceAccount:${OPR} projects/${PRJ}/roles/platform_operate cond`]);
  const b = e.calls().length; e.run();   // 다시 실행해도 지우기·추가 없음
  assert.equal(mutations(e.calls().slice(b)).length, 0);
});

test("tokenCreator 는 SA 단위로 확인: 한쪽만 있으면 다른 쪽만 추가", () => {
  const e = env();
  appendFileSync(join(e.state, "sabind"), `${OBS} serviceAccount:${SA}\n`);
  assert.equal(e.run().status, 0);
  const tc = mutations(e.calls()).filter((c) => c.startsWith("iam service-accounts add-iam-policy-binding"));
  assert.equal(tc.length, 2);
  assert.ok(tc.some((c) => c.includes(OPR)) && tc.some((c) => c.includes("svc-plan@")) && !tc.some((c) => c.includes(OBS)));
});

test("거부: 다른 회사 SA 가 이미 tokenCreator 여도 이 회사 SA 는 추가된다(주체 구분)", () => {
  const e = env();
  const other = "t-ffffffffffffffffffffffffffff@platform-prj.iam.gserviceaccount.com";
  appendFileSync(join(e.state, "sabind"), `${OBS} serviceAccount:${other}\n${OPR} serviceAccount:${other}\n`);
  assert.equal(e.run().status, 0);
  assert.equal(mutations(e.calls()).filter((c) => c.startsWith("iam service-accounts add-iam-policy-binding")).length, 3);
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
  assert.equal((r.stdout.match(/^\+ gcloud/gm) ?? []).length, 16);
});

// ── OBSROLE3: 이미 만든 관찰 역할 권한 갱신 ──
// GCP 권한 이름은 cloudsql.instances.* (예전 sql.instances.* 는 없는 권한이라 역할 만들기가 거절됐다)
const OLD7 = "container.clusters.list,container.clusters.get,cloudsql.instances.list,cloudsql.instances.get,iam.serviceAccounts.get,iam.serviceAccounts.list,resourcemanager.projects.get";
const permsOf = (e: ReturnType<typeof env>) => readFileSync(join(e.state, "role", "platform_observe"), "utf8").split(",").filter(Boolean);
const wanted = (e: ReturnType<typeof env>) => { const f = env(); f.run(); return permsOf(f); };

test("갱신: 예전 스크립트로 만든 관찰 역할(권한 7개)은 빠진 권한만 --add-permissions 로 더하고, 다시 실행하면 0번", () => {
  const e = env();
  assert.equal(e.run().status, 0);
  const want = wanted(e);
  assert.ok(want.length >= 21);
  writeFileSync(join(e.state, "role", "platform_observe"), OLD7);   // 예전 버전 상태로 되돌림
  const before = e.calls().length;
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const second = e.calls().slice(before);
  const upd = second.filter((c) => c.startsWith("iam roles update"));
  assert.equal(upd.length, 1, upd.join("|"));
  assert.match(upd[0]!, /^iam roles update platform_observe --project=cust-prj --add-permissions=/);
  assert.ok(!upd[0]!.includes("--permissions=") || upd[0]!.includes("--add-permissions="), "통째 교체(--permissions) 금지");
  const added = /--add-permissions=(\S+)/.exec(upd[0]!)![1]!.split(",");
  for (const p of OLD7.split(",")) assert.ok(!added.includes(p), `이미 있는 권한을 또 더함: ${p}`);
  assert.deepEqual([...new Set([...OLD7.split(","), ...added])].sort(), [...want].sort());
  assert.deepEqual(permsOf(e).sort(), [...want].sort());
  assert.equal(second.filter((c) => MUTATING.test(c)).length, 1, "다른 변경은 없음");
  assert.match(r.stdout, /역할 platform_observe 에 빠진 읽기 권한 추가: /);
  // 다시 실행: 권한 최신 → 변경 0
  const b2 = e.calls().length;
  const r2 = e.run();
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(e.calls().slice(b2).filter((c) => MUTATING.test(c)).length, 0);
  assert.match(r2.stdout, /역할 platform_observe 권한 최신/);
});

test("갱신: 고객이 따로 넣은 권한은 지우지 않는다 (더하기만)", () => {
  const e = env();
  e.run();
  const want = wanted(e);
  writeFileSync(join(e.state, "role", "platform_observe"), [...want.filter((p) => p !== "compute.networks.list"), "custom.extra.permission"].join(","));
  assert.equal(e.run().status, 0);
  const now = permsOf(e);
  assert.ok(now.includes("custom.extra.permission"));
  assert.ok(now.includes("compute.networks.list"));
});

test("갱신 거부: 권한 목록을 못 읽으면 바꾸지 않고 알린다 (종료 0), 실행 역할은 자동으로 안 바꾼다", () => {
  const e = env();
  e.run();
  writeFileSync(join(e.state, "role", "platform_observe"), OLD7);
  writeFileSync(join(e.state, "fail"), "--format=value(includedPermissions)");
  const before = e.calls().length;
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const second = e.calls().slice(before);
  assert.equal(second.filter((c) => c.startsWith("iam roles update")).length, 0);
  assert.match(r.stderr, /권한 목록을 못 읽음/);
  assert.ok(!second.some((c) => /^iam roles update platform_operate/.test(c)), "실행 역할 자동 갱신 금지");
});

test("DRY_RUN: 역할을 새로 만드는 명령만 나오고 describe·update 는 안 부름", () => {
  const e = env();
  const r = e.run({ DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(e.calls().length, 0, "DRY_RUN 은 gcloud 를 아무것도 부르지 않는다");
  assert.ok(!r.stdout.includes("roles update"));
});

// ---- VOBSROLE3: 갱신 경계 ----
const NOT_ALLOWED_ON_UPDATE = /--remove-permissions|(^|\s)--permissions=|--file=|^iam roles delete/;

test("VOBSROLE3: 삭제 표시된 예전 역할(권한 7개)은 undelete 뒤 빠진 권한만 더하고, 다시 실행하면 0번", () => {
  const e = env();
  e.run();
  const want = wanted(e);
  writeFileSync(join(e.state, "role", "platform_observe"), OLD7);
  writeFileSync(join(e.state, "role", "platform_observe.deleted"), "");
  const before = e.calls().length;
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  const second = e.calls().slice(before);
  assert.deepEqual(second.filter((c) => MUTATING.test(c)).map((c) => c.split(" ").slice(0, 4).join(" ")),
    ["iam roles undelete platform_observe", "iam roles update platform_observe"]);
  assert.deepEqual(permsOf(e).sort(), [...want].sort());
  const b2 = e.calls().length;
  assert.equal(e.run().status, 0);
  assert.equal(mutations(e.calls().slice(b2)).length, 0);
});

test("VOBSROLE3: 권한 비교는 이름 전체로 (순서 무관, 앞뒤가 붙은 비슷한 이름은 다른 권한)", () => {
  const e = env();
  e.run();
  const want = wanted(e);
  // 순서 뒤집고, 두 개는 비슷한 이름으로 바꿔 둔다 (substring 비교면 '있다'로 착각)
  const fake = [...want].reverse().map((p) => p === "compute.regions.get" ? "compute.regions.getIamPolicy"
    : p === "container.clusters.list" ? "xcontainer.clusters.list" : p);
  writeFileSync(join(e.state, "role", "platform_observe"), fake.join(","));
  const before = e.calls().length;
  assert.equal(e.run().status, 0);
  const upd = e.calls().slice(before).filter((c) => c.startsWith("iam roles update"));
  assert.equal(upd.length, 1);
  assert.deepEqual(/--add-permissions=(\S+)/.exec(upd[0]!)![1]!.split(",").sort(), ["compute.regions.get", "container.clusters.list"]);
  // 다 있으면(순서만 다름) 0번
  writeFileSync(join(e.state, "role", "platform_observe"), [...want].reverse().join(","));
  const b2 = e.calls().length;
  const r = e.run();
  assert.equal(mutations(e.calls().slice(b2)).length, 0);
  assert.match(r.stdout, /권한 최신/);
});

test("VOBSROLE3 거부: 권한 추가(update)가 거절돼도 나머지 연결 단계는 끝까지 하고 종료 0, 할 일을 알린다 (예전 스크립트 재실행보다 나빠지지 않음)", () => {
  const e = env();
  // 예전 버전으로 SA·관찰 역할만 만든 고객(바인딩 전): update 가 거절되어도 바인딩·tokenCreator 는 만들어져야 한다
  mkdirSync(join(e.state, "sa"), { recursive: true });
  writeFileSync(join(e.state, "sa", OBS), ""); writeFileSync(join(e.state, "role", "platform_observe"), OLD7);
  writeFileSync(join(e.state, "fail"), "iam roles update");
  const r = e.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /권한 추가 실패/);
  const calls = e.calls();
  assert.equal(calls.filter((c) => c.startsWith("projects add-iam-policy-binding")).length, 5);
  assert.equal(calls.filter((c) => c.startsWith("iam service-accounts add-iam-policy-binding")).length, 3);
  assert.deepEqual(permsOf(e).sort(), OLD7.split(",").sort(), "실패했으니 권한은 그대로");
});

test("VOBSROLE3: 어떤 경우에도 지우는 명령이 없고, update 는 관찰 역할에만 --add-permissions 로", () => {
  const e = env();
  const all: string[] = [];
  e.run();
  writeFileSync(join(e.state, "role", "platform_observe"), OLD7 + ",custom.extra.permission"); e.run();
  writeFileSync(join(e.state, "role", "platform_operate"), "only.one"); e.run();   // 실행 역할이 모자라도 자동 갱신 안 함
  all.push(...e.calls());
  const upd = all.filter((c) => /^iam roles (update|delete)/.test(c));
  assert.ok(upd.length >= 1);
  assert.equal(upd.some((c) => NOT_ALLOWED_ON_UPDATE.test(c)), false, upd.join("|"));
  for (const c of all.filter((x) => x.startsWith("iam roles update"))) assert.match(c, /^iam roles update platform_observe --project=cust-prj --add-permissions=\S+$/);
  assert.equal(readFileSync(join(e.state, "role", "platform_operate"), "utf8"), "only.one");
});
