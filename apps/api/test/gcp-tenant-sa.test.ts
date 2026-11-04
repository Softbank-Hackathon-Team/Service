// HUNT-CLD-01 (상태: AI 초안): 플랫폼 회사 전용 SA(t-*)와 그 SA 를 주체로 한 IAM 바인딩을 cloud-zero 가 세고,
//   tools/gcp-tenant-sa.sh purge(demo-day down 의 connect-gcp 단계)가 바인딩 → SA 순서로 지워 0 이 되는지. 가짜 gcloud 로만 돈다 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PURGE = fileURLToPath(new URL("../../../tools/gcp-tenant-sa.sh", import.meta.url));
const ZERO = fileURLToPath(new URL("../../../tools/cloud-zero.sh", import.meta.url));
const P = "finals-demo";
const T = `t-${"a".repeat(28)}@${P}.iam.gserviceaccount.com`;
const OPERATE = `svc-operate@${P}.iam.gserviceaccount.com`;

// 상태(JSON 파일)를 가진 가짜 gcloud. 지운 SA 를 주체로 한 바인딩은 실제 GCP 처럼 deleted:serviceAccount:<이메일>?uid=1 로 바뀐다
const FAKE = `#!/usr/bin/env node
const fs = require("fs"); const f = process.env.FAKE_STATE; const s = JSON.parse(fs.readFileSync(f, "utf8"));
const a = process.argv.slice(2); const j = a.join(" "); const save = () => fs.writeFileSync(f, JSON.stringify(s));
const opt = (k) => { const x = a.find((v) => v.startsWith(k + "=")); if (x) return x.slice(k.length + 1); const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const rows = (pol) => pol.map(([r, m]) => r + "\\t" + m).join("\\n");
if (s.deny && j.includes("get-iam-policy")) { console.error("PERMISSION_DENIED: getIamPolicy"); process.exit(1); }
if (j.startsWith("iam service-accounts list")) {
  let l = s.sas; const fl = opt("--filter"); if (fl && fl.includes("svc-")) l = l.filter((e) => /^svc-/.test(e)); else if (fl && fl.includes("app-")) l = l.filter((e) => /^app-/.test(e));
  console.log(l.join("\\n")); process.exit(0);
}
if (j.startsWith("projects get-iam-policy")) { console.log(rows(s.project)); process.exit(0); }
if (j.startsWith("iam service-accounts get-iam-policy")) { const t = a[3]; if (!s.sas.includes(t)) { console.error("NOT_FOUND: " + t); process.exit(1); } console.log(rows(s.saPol[t] || [])); process.exit(0); }
if (j.startsWith("projects remove-iam-policy-binding")) { const m = opt("--member"), r = opt("--role"); s.project = s.project.filter(([x, y]) => !(x === r && y === m)); save(); process.exit(0); }
if (j.startsWith("iam service-accounts remove-iam-policy-binding")) { const t = a[3], m = opt("--member"), r = opt("--role"); s.saPol[t] = (s.saPol[t] || []).filter(([x, y]) => !(x === r && y === m)); save(); process.exit(0); }
if (j.startsWith("iam service-accounts delete")) {
  const t = a[3]; s.sas = s.sas.filter((e) => e !== t); s.deleted.push(t);
  const dz = (pol) => pol.map(([r, m]) => [r, m === "serviceAccount:" + t ? "deleted:serviceAccount:" + t + "?uid=1" : m]);
  s.project = dz(s.project); for (const k of Object.keys(s.saPol)) s.saPol[k] = dz(s.saPol[k]); delete s.saPol[t]; save(); process.exit(0);
}
if (j.startsWith("config get-value project")) { console.log("${P}"); process.exit(0); }
// cloud-zero 의 나머지 GCP 조회는 빈 목록
process.exit(0);
`;

function setup(state: object) {
  const bin = mkdtempSync(join(tmpdir(), "gts-"));
  writeFileSync(join(bin, "gcloud"), FAKE); chmodSync(join(bin, "gcloud"), 0o755);
  const sf = join(bin, "state.json"); writeFileSync(sf, JSON.stringify(state));
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: sf, GCP_PROJECT: P, HOME: bin, TMPDIR: bin };
  return {
    run: (script: string, ...args: string[]) => { const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env }); return { code: r.status, out: r.stdout + r.stderr }; },
    state: () => JSON.parse(readFileSync(sf, "utf8")),
  };
}
const leftover = () => ({
  sas: [T, OPERATE, `svc-observe@${P}.iam.gserviceaccount.com`],
  project: [["roles/viewer", "user:owner@example.com"], ["roles/logging.viewer", `serviceAccount:${T}`]],
  saPol: { [OPERATE]: [["roles/iam.serviceAccountTokenCreator", `serviceAccount:${T}`]], [T]: [["roles/iam.serviceAccountTokenCreator", "serviceAccount:svc-worker@p.iam.gserviceaccount.com"]] },
  deleted: [] as string[],
});

test("정상: cloud-zero 가 남은 t-* SA 와 그 바인딩을 세고(끝 코드 1), purge 뒤엔 0 (고객 SA·남의 바인딩은 그대로)", () => {
  const h = setup(leftover());
  const before = h.run(ZERO, "gcp");
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, /회사 전용 SA\(t-\*\): +1/);
  assert.match(before.out, /t-\* 주체 IAM 바인딩: +2/);
  const p = h.run(PURGE, "purge");
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /회사 전용 SA·바인딩 0/);
  const s = h.state();
  assert.deepEqual(s.deleted, [T]);
  assert.ok(s.sas.includes(OPERATE), "고객 연결 SA 는 안 지운다");
  assert.deepEqual(s.project, [["roles/viewer", "user:owner@example.com"]], "남의 바인딩은 그대로");
  assert.deepEqual(s.saPol[OPERATE], [], "deleted: 주체도 남지 않는다");
  const after = h.run(ZERO, "gcp");
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /OK zero/);
  assert.equal(h.run(PURGE, "purge").code, 0, "다시 돌려도 안전");
});

test("정상: SA 가 이미 지워져 deleted: 주체만 남은 바인딩도 세고 걷는다", () => {
  const st = leftover(); st.sas = [OPERATE];
  st.saPol[OPERATE] = [["roles/iam.serviceAccountTokenCreator", `deleted:serviceAccount:${T}?uid=9`]]; st.project = [];
  const h = setup(st);
  assert.match(h.run(ZERO, "gcp").out, /t-\* 주체 IAM 바인딩: +1/);
  assert.equal(h.run(PURGE, "purge").code, 0);
  assert.deepEqual(h.state().saPol[OPERATE], []);
});

test("거부: 정책 조회가 안 되면 0 이라고 하지 않는다 (cloud-zero 끝 코드 2, purge 는 지우지 않고 2)", () => {
  const st = { ...leftover(), deny: true };
  const h = setup(st);
  const z = h.run(ZERO, "gcp");
  assert.equal(z.code, 2, z.out);
  assert.match(z.out, /t-\* 주체 IAM 바인딩: +조회 실패/);
  assert.equal(h.run(PURGE, "purge").code, 2);
  assert.deepEqual(h.state().deleted, [], "조회 실패면 SA 도 안 지운다");
});
