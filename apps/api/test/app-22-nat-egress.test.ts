// APP-22: 도착 GKE 고정 출구 IP — gcp/env 가 NAT 에 고정 주소를 붙여 nat_egress_ips 로 내보내고,
//   demo-day nat-env 단계가 워커 환경 파일에 TF_FACT_NAT_EGRESS_IPS_JSON(→ 계획 사실 natEgressIpsJson)으로 더한다. 클라우드·terraform 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsFromEnv } from "@svc/adapters";

const ROOT = new URL("../../../", import.meta.url).pathname;
const tf = readFileSync(join(ROOT, "infra/modules/gcp/env/main.tf"), "utf8");
const dd = readFileSync(join(ROOT, "tools/demo-day.sh"), "utf8");
const fn = dd.match(/^u_nat_env\(\) \{[\s\S]*?^\}$/m)![0];

function runNat(out: string, rc = 0) {
  const d = mkdtempSync(join(tmpdir(), "app22-"));
  const envf = join(d, "demo-day.env");
  writeFileSync(envf, "REPL_SOURCE_URL='postgres://u:secret@h/db'\nTF_FACT_NAT_EGRESS_IPS_JSON='[\"9.9.9.9\"]'\n", { mode: 0o600 });
  const script = `tfjson() { [ "$1" = "infra/modules/gcp/env" ] && [ "$2" = nat_egress_ips ] || exit 9; printf '%s\\n' '${out}'; return ${rc}; }\nTFG=infra/modules/gcp/env\nENVF='${envf}'\n${fn}\nu_nat_env`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout + r.stderr, file: readFileSync(envf, "utf8"), mode: statSync(envf).mode & 0o777 };
}

test("APP-22 정상: NAT 고정 주소 → nat_egress_ips 출력 → 환경 파일 한 줄(옛 값 바꿈·600 유지) → 계획 사실 natEgressIpsJson", () => {
  assert.match(tf, /resource "google_compute_address" "nat" \{[\s\S]*?address_type = "EXTERNAL"/);
  assert.match(tf, /nat_ip_allocate_option\s+= "MANUAL_ONLY"\s+nat_ips\s+= \[google_compute_address\.nat\[0\]\.self_link\]/);
  assert.ok(!/= "AUTO_ONLY"/.test(tf), "자동 IP(바뀔 수 있음)가 남음");
  assert.match(tf, /output "nat_egress_ips" \{ value = var\.create_gke \? \[google_compute_address\.nat\[0\]\.address\] : \[\] \}/);
  assert.equal((dd.match(/step kubeconfig u_kubeconfig[^\n]*\n\s*step nat-env u_nat_env/g) ?? []).length, 2, "두 순서 모두 GKE 뒤에 nat-env");
  const r = runNat('[\n  "34.64.10.20"\n]');
  assert.equal(r.rc, 0, r.out);
  const lines = r.file.split("\n").filter((l) => l.startsWith("TF_FACT_NAT_EGRESS_IPS_JSON="));
  assert.deepEqual(lines, [`TF_FACT_NAT_EGRESS_IPS_JSON='["34.64.10.20"]'`]);
  assert.ok(r.file.includes("REPL_SOURCE_URL="), "다른 줄이 사라짐");
  assert.equal(r.mode, 0o600);
  assert.ok(!r.out.includes("34.64"), "IP 가 화면에 나옴");
  const facts = factsFromEnv({ TF_FACT_NAT_EGRESS_IPS_JSON: '["34.64.10.20"]' });
  assert.deepEqual(JSON.parse(facts.natEgressIpsJson!), ["34.64.10.20"]);
  assert.ok(!facts.natEgressIpsJson!.includes("/32"), "/32 는 워커가 붙인다 (출력은 IP 만)");
});

test("APP-22 거부: 빈 목록·terraform 출력 실패면 rc 1, 환경 파일은 그대로", () => {
  for (const [out, rc] of [["[]", 0], ["", 1]] as const) {
    const r = runNat(out, rc);
    assert.equal(r.rc, 1, r.out);
    assert.match(r.file, /^TF_FACT_NAT_EGRESS_IPS_JSON='\["9\.9\.9\.9"\]'$/m, "실패했는데 파일을 바꿈");
  }
});
