// 결정 3 A안(GCP 이전 전용 프로젝트): demo-day 가 도착 GKE·VPC(gcp/env)를 TARGET_PROJECT_ID 에 만들고, up-preflight 가 그 값을 검사한다.
//   demo-day 는 --dry-run(명령을 진행 파일에만 적음), up-preflight 는 그 블록만 떼어 가짜 tmo·gcloud 로 돌린다. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function dry(cmd: string, env: Record<string, string>) {
  const h = mkdtempSync(join(tmpdir(), "tgtp-"));
  const r = spawnSync("bash", ["tools/demo-day.sh", cmd, "--dry-run", "--fg"], { cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, HOME: h, DEMO_DAY_STATE: join(h, "s"), DEMO_DAY_LOG_DIR: join(h, "log"), GCP_PROJECT: "orig-proj", ...env } });
  const logs = existsSync(join(h, "log")) ? readdirSync(join(h, "log"), { recursive: true }).map(String).map((f) => join(h, "log", f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, "utf8")).join("\n") : "";
  return { rc: r.status, all: r.stdout + r.stderr + logs };
}

test("A안 demo-day: TARGET_PROJECT_ID 가 있으면 gcp/env apply·get-credentials·GKE 문맥이 전용 프로젝트", () => {
  const r = dry("up", { TARGET_PROJECT_ID: "tgt-proj-01" });
  assert.equal(r.rc, 0, r.all.slice(-800));
  assert.match(r.all, /project_id=tgt-proj-01 -var zone=/);
  assert.doesNotMatch(r.all, /project_id=orig-proj/);
  assert.match(r.all, /get-credentials platform-target --zone \S+ --project tgt-proj-01/);
  assert.match(r.all, /도착=tgt-proj-01/);
});

test("A안 demo-day: 없으면 예전처럼 GCP_PROJECT 하나 (동결 실측 판과 같음)", () => {
  const r = dry("up", { TARGET_PROJECT_ID: "" });
  assert.equal(r.rc, 0);
  assert.match(r.all, /project_id=orig-proj -var zone=/);
});

function pre(env: Record<string, string>, describe = "ACTIVE") {
  const blk = spawnSync("bash", ["-c", "sed -n '/^# 결정 3 A안: 전용 프로젝트가 있는지/,/^case \"\\$GCP_ZONE\"/p' tools/up-preflight.sh | sed '$d'"], { cwd: ROOT, encoding: "utf8" }).stdout;
  assert.match(blk, /fail target-project/);
  const body = `ok() { echo "OK $1 $2"; }; fail() { echo "FAIL $1 $2"; }; warn() { echo "WARN $1 $2"; }; tmo() { shift; "$@"; }
gcloud() { echo ${describe}; }; GCP_PROJECT=orig-proj; ${blk}`;
  return spawnSync("bash", ["-c", body], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } }).stdout;
}

test("A안 up-preflight: 있고 다르고 ACTIVE 면 OK", () => {
  assert.match(pre({ TARGET_PROJECT_ID: "tgt-proj-01" }), /^OK target-project tgt-proj-01 ACTIVE/m);
});

test("A안 up-preflight 거부: 없음·같음·모양 틀림·못 읽음은 FAIL, 예전 방식은 GCP_SAME_PROJECT_OK=1 로만 WARN", () => {
  assert.match(pre({ TARGET_PROJECT_ID: "" }), /^FAIL target-project TARGET_PROJECT_ID 없음/m);
  assert.match(pre({ TARGET_PROJECT_ID: "", GCP_SAME_PROJECT_OK: "1" }), /^WARN target-project/m);
  assert.match(pre({ TARGET_PROJECT_ID: "orig-proj" }), /^FAIL target-project .*같음/m);
  assert.match(pre({ TARGET_PROJECT_ID: "Bad_Proj" }), /^FAIL target-project .*모양/m);
  assert.match(pre({ TARGET_PROJECT_ID: "tgt-proj-01" }, "DELETE_REQUESTED"), /^FAIL target-project tgt-proj-01 를 못 읽음/m);
});
