// PERM-GATE: gcp-connect.sh 묶음 모드(ONLY_BUNDLES). 빠진 묶음만 맞추고 끝, 다시 돌리면 바꾸는 명령 0번, 다른 역할은 안 건드림.
//   상태를 가진 가짜 gcloud (onboarding-gcp-idempotent 와 같은 것 + 역할 설명 읽기·바꾸기). 진짜 gcloud 는 실행하지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url).pathname;
const SA = "t-0123456789abcdef0123456789ab@platform-prj.iam.gserviceaccount.com";
const PRJ = "cust-prj", TPRJ = "cust-mig";
const ENV_SA = `svc-env@${TPRJ}.iam.gserviceaccount.com`;

const FAKE = `#!/bin/bash
S="$GCLOUD_STATE"; echo "$*" >> "$S/calls.log"
args="$*"
pj=$(grep -o -- '--project=[^ ]*' <<<"$args" | head -1 | cut -d= -f2); r="$4@$pj"   # 역할은 프로젝트마다 따로
fail_if="$S/fail"; [ -f "$fail_if" ] && grep -qF -- "$(cat "$fail_if")" <<<"$args" && { echo "PERMISSION_DENIED" >&2; exit 1; }
case "$args" in
  "iam service-accounts describe "*) [ -f "$S/sa/$4" ] ;;
  "iam service-accounts create "*) n="$4@\${5#--project=}.iam.gserviceaccount.com"; [ -f "$S/sa/$n" ] && { echo "already exists" >&2; exit 1; }; touch "$S/sa/$n" ;;
  "iam roles describe "*"--format=value(description)"*) [ -f "$S/role/$r" ] || exit 1; cat "$S/role/$r.desc" 2>/dev/null; echo ;;
  "iam roles describe "*--format=value*) [ -f "$S/role/$r" ] || exit 1; tr ',' ';' < "$S/role/$r" ;;
  "iam roles describe "*) [ -f "$S/role/$r" ] || exit 1; [ -f "$S/role/$r.deleted" ] && echo "deleted: true"; echo "name: x" ;;
  "iam roles create "*) [ -f "$S/role/$r" ] && { echo "already exists" >&2; exit 1; }; grep -o -- '--permissions=[^ ]*' <<<"$args" | cut -d= -f2 | tr -d '\n' > "$S/role/$r" ;;
  "iam roles update "*--description=*) [ -f "$S/role/$r" ] || exit 1; echo "\${args#*--description=}" > "$S/role/$r.desc" ;;
  "iam roles update "*) [ -f "$S/role/$r" ] || exit 1; add=$(grep -o -- '--add-permissions=[^ ]*' <<<"$args" | cut -d= -f2); { cat "$S/role/$r"; echo -n ",$add"; } > "$S/role/$r.new"; mv "$S/role/$r.new" "$S/role/$r" ;;
  "iam roles undelete "*) rm -f "$S/role/$r.deleted" ;;
  "projects get-iam-policy "*)
    role=$(grep -o 'bindings.role=[^ ]*' <<<"$args" | head -1 | cut -d= -f2); mem=$(grep -o 'bindings.members=[^ "]*' <<<"$args" | head -1 | cut -d= -f2)
    if grep -q 'NOT bindings.condition' <<<"$args"; then grep -qx "$mem $role" "$S/pbind" 2>/dev/null && echo "$role"
    elif grep -q 'bindings.condition:\*' <<<"$args"; then grep -F "$mem $role cond:" "$S/pbind" 2>/dev/null | sed 's/^.* cond://'
    else grep -q "^$mem $role" "$S/pbind" 2>/dev/null && echo "$role"; fi ;;
  "projects add-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); role=$(grep -o -- '--role=[^ ]*' <<<"$args" | cut -d= -f2)
    c=""; cf=$(grep -o -- '--condition-from-file=[^ ]*' <<<"$args" | cut -d= -f2)
    if [ -n "$cf" ]; then t=$(sed -n 's/^ *"title": *"\\([^"]*\\)".*/\\1/p' "$cf" | head -1); x=$(sed -n 's/^ *"expression": *"\\(.*\\)",\\{0,1\\} *$/\\1/p' "$cf" | head -1 | sed 's/\\\\"/"/g'); c=" cond:$t"$'\t'"$x"; fi
    echo "$mem $role$c" >> "$S/pbind" ;;
  "projects remove-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); role=$(grep -o -- '--role=[^ ]*' <<<"$args" | cut -d= -f2)
    if grep -q -- '--all' <<<"$args"; then grep -vF "$mem $role cond:" "$S/pbind" | grep -vx "$mem $role" > "$S/pbind.new"
    else grep -vx "$mem $role" "$S/pbind" > "$S/pbind.new"; fi; mv "$S/pbind.new" "$S/pbind" ;;
  "iam service-accounts get-iam-policy "*)
    t="$4"; mem=$(grep -o 'bindings.members=[^ "]*' <<<"$args" | head -1 | cut -d= -f2)
    grep -q "^$t $mem" "$S/sabind" 2>/dev/null && echo "roles/iam.serviceAccountTokenCreator" ;;
  "iam service-accounts add-iam-policy-binding "*)
    mem=$(grep -o -- '--member=[^ ]*' <<<"$args" | cut -d= -f2); echo "$4 $mem" >> "$S/sabind" ;;
  "projects describe "*--format=value\\(parent.type\\)*) echo folder ;;
  "projects describe "*--format=value\\(parent.id\\)*) echo 4242 ;;
  "projects describe "*) if [ -f "$S/no-project" ] && [ "$3" = "$(cat "$S/no-project")" ]; then echo "NOT_FOUND" >&2; exit 1; fi; echo 123456 ;;
  "projects create "*) rm -f "$S/no-project" ;;
  "billing projects link "*) : ;;
  "billing projects describe "*) echo "billingAccounts/000000-AAAAAA-BBBBBB" ;;
  "services list "*) api="$*"; api=\${api##*config.name=}; api=\${api%%.googleapis.com*}; [ -f "$S/api-$api-$pj" ] && echo "$api.googleapis.com" ;;
  "services enable "*) api=\${3%%.googleapis.com}; touch "$S/api-$api-$pj" ;;
  *) echo "unexpected: $args" >&2; exit 2 ;;
esac
`;

function env() {
  const root = mkdtempSync(join(tmpdir(), "bundles-"));
  const state = join(root, "state");
  for (const d of ["sa", "role"]) mkdirSync(join(state, d), { recursive: true });
  writeFileSync(join(root, "gcloud"), FAKE); chmodSync(join(root, "gcloud"), 0o755);
  return {
    state,
    calls: () => (existsSync(join(state, "calls.log")) ? readFileSync(join(state, "calls.log"), "utf8").trim().split("\n") : []),
    run: (extra: Record<string, string> = {}) => spawnSync("bash", [script], { encoding: "utf8",
      env: { PATH: `${root}:/usr/bin:/bin`, GCLOUD_STATE: state, PLATFORM_SA: SA, PROJECT_ID: PRJ, TARGET_PROJECT_ID: TPRJ, ROLE_DIR: "./permissions", ...extra } }),
  };
}
const MUTATING = /^(services enable|iam service-accounts create|iam roles create|iam roles update|iam roles undelete|projects add-iam-policy-binding|projects remove-iam-policy-binding|iam service-accounts add-iam-policy-binding)/;
const since = (e: ReturnType<typeof env>, n: number) => e.calls().slice(n).filter((c) => MUTATING.test(c));
const roleFile = (role: string) => join("role", `${role}@${TPRJ}`);
const MEASURED = ["compute.globalAddresses.setLabels", "compute.addresses.setLabels", "compute.instanceGroupManagers.get"];

test("묶음 모드: 11/06 처럼 platform_env 에 세 권한이 없으면 그 셋만 더하고 판 표시, 다른 역할·SA 는 안 건드림, 다시 돌리면 0번", () => {
  const e = env();
  assert.equal(e.run().status, 0);
  // 예전 판 역할 재현: 전체 실행이 만든 platform_env 에서 세 권한을 뺀다
  //   (가짜 gcloud 는 --file 로 만든 역할의 권한을 기억하지 않는다 → 역할 파일 권한에서 세 개를 뺀 목록을 직접 둔다)
  const yaml = readFileSync(new URL("../../../infra/permissions/gcp-env-custom-role.yaml", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  writeFileSync(join(e.state, roleFile("platform_env")), yaml.filter((p) => !MEASURED.includes(p)).join(","));
  const n = e.calls().length;
  const r = e.run({ ONLY_BUNDLES: "gcp.env" });
  assert.equal(r.status, 0, r.stderr);
  const m = since(e, n);
  assert.deepEqual(m.map((c) => c.split(" --")[0]), ["iam roles update platform_env", "iam roles update platform_env"], m.join("\n"));
  assert.deepEqual(/--add-permissions=(\S+)/.exec(m[0]!)![1]!.split(",").sort(), [...MEASURED].sort());
  assert.match(m[1]!, /--description=.*\[perms v1\]$/);
  assert.ok(!e.calls().slice(n).some((c) => /platform_operate|platform_plan|svc-operate|svc-plan/.test(c) && MUTATING.test(c)), "다른 역할은 안 건드림");
  assert.match(r.stdout, /완료 \(묶음 모드 \[perms v1\]\): gcp\.env/);
  // 다시: 바꾸는 명령 0
  const n2 = e.calls().length;
  const r2 = e.run({ ONLY_BUNDLES: "gcp.env" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(since(e, n2), []);
  assert.match(r2.stdout, /역할 platform_env 권한 최신/);
  assert.match(r2.stdout, /역할 platform_env 권한 판 최신/);
});

test("묶음 모드: 아무것도 없는 고객이면 그 묶음의 SA·역할·바인딩·API·빌리기만 만든다 (전체 연결의 일부, 같은 끝)", () => {
  const e = env();
  const r = e.run({ ONLY_BUNDLES: "gcp.env" });
  assert.equal(r.status, 0, r.stderr);
  const m = e.calls().filter((c) => MUTATING.test(c));
  for (const want of ["iam service-accounts create svc-env", "iam roles create platform_env", "iam service-accounts create svc-gke-node",
    `projects add-iam-policy-binding ${TPRJ} --member=serviceAccount:${ENV_SA} --role=projects/${TPRJ}/roles/platform_env`,
    `iam service-accounts add-iam-policy-binding ${ENV_SA} --project=${TPRJ} --member=serviceAccount:${SA}`, "services enable container.googleapis.com"])
    assert.ok(m.some((c) => c.startsWith(want)), want);
  assert.ok(!m.some((c) => /svc-operate|svc-plan|platform_operate|platform_plan|svc-observe/.test(c)), m.join("\n"));
  assert.ok(!m.some((c) => c.includes(`--project=${PRJ}`) || c.includes(` ${PRJ} `)), "원래 프로젝트는 안 건드림");
  const n = e.calls().length;
  assert.equal(e.run({ ONLY_BUNDLES: "gcp.env" }).status, 0);
  assert.deepEqual(since(e, n), []);
});

test("묶음 모드: 조건부 묶음은 조건 파일대로 바인딩, 관찰 묶음은 확인 역할까지·관찰 SA 빌리기는 원래 프로젝트에", () => {
  const e = env();
  const r = e.run({ ONLY_BUNDLES: "gcp.operate.dbsecret,gcp.observe.target" });
  assert.equal(r.status, 0, r.stderr);
  const m = e.calls().filter((c) => MUTATING.test(c));
  assert.ok(m.some((c) => c.includes("roles/platform_operate_db_secret") && c.includes("--condition-from-file=")), m.join("\n"));
  assert.ok(m.some((c) => c.startsWith("iam roles create platform_observe_verify --project=cust-mig")));
  assert.ok(m.some((c) => c.startsWith(`iam service-accounts add-iam-policy-binding svc-observe@${PRJ}.iam.gserviceaccount.com --project=${PRJ}`)));
  const n = e.calls().length;
  assert.equal(e.run({ ONLY_BUNDLES: "gcp.operate.dbsecret,gcp.observe.target" }).status, 0);
  assert.deepEqual(since(e, n), []);
});

test("묶음 모드 거부: 모르는 묶음·이상한 글자면 아무것도 바꾸기 전에 exit 2", () => {
  for (const bad of ["gcp.env,gcp.nope", "gcp.env;touch x", "aws.operate"]) {
    const e = env();
    const r = e.run({ ONLY_BUNDLES: bad });
    assert.equal(r.status, 2, `${bad}: ${r.stdout}`);
    assert.deepEqual(e.calls().filter((c) => MUTATING.test(c)), [], bad);
  }
});

test("묶음 모드 DRY_RUN: 명령만 출력하고 gcloud 는 부르지 않는다", () => {
  const e = env();
  const r = e.run({ ONLY_BUNDLES: "gcp.plan", DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(e.calls(), []);
  assert.match(r.stdout, /\+ gcloud iam roles create platform_plan --project=cust-mig/);
});
