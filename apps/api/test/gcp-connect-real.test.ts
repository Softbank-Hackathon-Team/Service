// CON-01: tools/gcp-connect-real.sh — 회사 번호 → 회사 SA → 환경·명령 → 고객 연결 → verify → "도착 환경 <id>".
//   가짜 npm(env:connect whoami·create·verify)과 가짜 gcloud(부른 것만 적고 0)를 PATH 앞에 둔다. 진짜 GCP·API 안 봄
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TID = "11111111-1111-4111-8111-111111111111";
const ENV = "44444444-4444-4444-8444-444444444444";
const SA = `t-${createHash("md5").update(TID).digest("hex").slice(0, 28)}@plat-proj.iam.gserviceaccount.com`;

function run(o: { tp?: string; sa?: string; state?: string; verify?: string; dry?: string } = {}) {
  const d = mkdtempSync(join(tmpdir(), "gcpc-"));
  const create = o.state === "connected"
    ? `echo "환경 만듦  ${ENV} (gcp, real-dst, 이어 씀: 지금 connected)"; echo "이미 connected → 링크를 다시 받지 않음"`
    : `echo "환경 만듦  ${ENV} (gcp, real-dst)"; echo "명령:"; echo "${o.sa === "" ? "" : `PLATFORM_SA='${o.sa ?? SA}' `}PROJECT_ID='cust-proj' ROLE_DIR=./permissions bash onboarding/gcp-connect.sh"`;
  writeFileSync(join(d, "npm"), `#!/bin/sh
echo "npm $*" >> "${d}/calls"
case "$*" in
  *whoami*) echo "회사  ${TID}" ;;
  *create*) ${create} ;;
  *verify*) echo "확인 요청  queued=true"; echo "+     12 ms  verifying"; echo "+  40000 ms  ${o.verify ?? "connected"}"; echo "연결 확인 결과  ${(o.verify ?? "connected").split(" ")[0]}"; [ "${o.verify ?? "connected"}" = connected ] || exit 1 ;;
esac
`);
  writeFileSync(join(d, "gcloud"), `#!/bin/sh\necho "gcloud $*" >> "${d}/calls"\ncase "$*" in "config get-value account") echo person@example.com ;; esac\nexit 0\n`);
  for (const f of ["npm", "gcloud"]) chmodSync(join(d, f), 0o755);
  const r = spawnSync("bash", ["tools/gcp-connect-real.sh"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${d}:${process.env.PATH}`, TMPDIR: d,
    GCP_PROJECT: "cust-proj", GCP_TARGET_PROJECT: o.tp ?? "cust-mig", GCP_PLATFORM_PROJECT: "plat-proj", GCP_IAM_WAIT_SEC: "0", DRY: o.dry ?? "0", WORKER_PRINCIPAL: "" } });
  const calls = existsSync(join(d, "calls")) ? readFileSync(join(d, "calls"), "utf8") : "";
  return { rc: r.status, out: r.stdout, err: r.stderr, calls };
}

test("CON-01 정상: 회사 SA → 고객 연결 → verify connected → 끝 줄 '도착 환경 <id>'", () => {
  const r = run();
  assert.equal(r.rc, 0, r.err + r.out);
  assert.match(r.out, new RegExp(`^도착 환경  ${ENV}$`, "m"));
  assert.match(r.calls, /npm run -s env:connect -- create --provider gcp --name real-dst --cluster platform-target --region asia-northeast3/);
  assert.match(r.calls, /gcloud iam service-accounts (create|describe) t-[0-9a-f]{28}/, "회사 SA 단계를 안 탐");
  assert.match(r.calls, /member=user:person@example\.com/, "워커 주체가 gcloud 계정이 아님");
  assert.match(r.calls, /npm run -s env:connect -- verify --env 44444444-4444-4444-8444-444444444444 --account cust-proj --target-project cust-mig/);
  assert.ok(!r.out.includes("person@example.com"), "계정 글자가 화면에 나옴");
});

test("CON-01 이어 쓰기: 이미 connected 면 GCP 를 안 건드리고 바로 도착 환경, dry-run 은 verify 안 함", () => {
  let r = run({ state: "connected" });
  assert.equal(r.rc, 0); assert.match(r.out, /이미 connected/); assert.match(r.out, /^도착 환경  /m);
  assert.ok(!/gcloud iam/.test(r.calls)); assert.ok(!/verify/.test(r.calls));
  r = run({ dry: "1" });
  assert.equal(r.rc, 0, r.err); assert.ok(!/gcloud iam/.test(r.calls), "dry 인데 gcloud iam 을 부름"); assert.ok(!/verify/.test(r.calls));
});

test("CON-01 거부: 링크 SA 가 다른 회사 것·SA 없음·verify 실패면 단계 이름과 함께 rc 1", () => {
  let r = run({ sa: "t-0000000000000000000000000000@plat-proj.iam.gserviceaccount.com" });
  assert.equal(r.rc, 1); assert.match(r.err, /\[회사SA\]: 만든 SA 와 연결 명령의 SA 가 다름/);
  assert.ok(!/gcp-connect|verify/.test(r.calls.replace(/env:connect/g, "")), "어긋났는데 다음 단계로 감");
  r = run({ sa: "" });
  assert.equal(r.rc, 1); assert.match(r.err, /\[명령\]/);
  r = run({ verify: "failed (ROLE_NOT_FOUND)" });
  assert.equal(r.rc, 1); assert.match(r.err, /\[verify\]: 마지막 상태 failed \(ROLE_NOT_FOUND\) rc=1/);
  assert.ok(!/^도착 환경/m.test(r.out));
  r = run({ verify: "disconnected" });   // "connected" 글자가 들어 있어도 거짓 통과 안 됨
  assert.equal(r.rc, 1); assert.match(r.err, /마지막 상태 disconnected/);
});

// FM-INT-16: 8nr2 pf22 에서 전용 프로젝트가 필수가 됨 → "없으면 안 보냄" 대신 "없으면 rc 2"(아래 CON-01 거부 시험). 이름은 TARGET_PROJECT_ID 도 받음
test("결정 3 A안: 전용 프로젝트(GCP_TARGET_PROJECT·TARGET_PROJECT_ID)를 verify 에 --target-project 로, 고객 프로젝트와 같으면 rc 2 로 멈춤", () => {
  let r = run({ tp: "tgt-proj" });
  assert.equal(r.rc, 0, r.err);
  assert.match(r.calls, /env:connect -- verify --env \S+ --account cust-proj --target-project tgt-proj/);
  r = run({ tp: "cust-proj" });
  assert.equal(r.rc, 2); assert.match(r.err, /GCP_TARGET_PROJECT 가 GCP_PROJECT 와 같음/);
  assert.doesNotMatch(r.calls, /gcloud iam/);
});

test("CON-01 거부(A안): 전용 프로젝트가 없거나 원래 프로젝트와 같으면 GCP 를 안 건드리고 rc 2", () => {
  for (const tp of ["", "cust-proj"]) {
    const r = run({ tp });
    assert.equal(r.rc, 2, r.err + r.out);
    assert.match(r.err, /GCP_TARGET_PROJECT/);
    assert.ok(!/gcloud iam|verify/.test(r.calls), "전용 프로젝트 없이 다음 단계로 감");
  }
});
