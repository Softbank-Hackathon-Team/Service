// FM-GCP-14 (실측 11/4): 연결 확인(verify/gcp.ts)이 실제로 부르는 권한이 관찰 SA 가 받는 역할 권한 목록에 다 있는지 소스 대조로 고정한다.
//   필수 단계(step("권한", …))는 작은 확인 역할(VERIFY_PERMS)과 큰 관찰 역할(OBSERVE_PERMS) 둘 다에, 선택 찌르기(OPTIONAL_PROBES)는 관찰 역할에. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GCP_COMMAND_PERMISSIONS, OPTIONAL_PROBES } from "../src/index.js";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const sh = read("infra/onboarding/gcp-connect.sh");
function permsOf(name: string): Set<string> {
  const out = new Set<string>();
  for (const m of sh.matchAll(new RegExp(`^${name}="([^"]*)"`, "gm")))
    for (const p of m[1]!.replace(`\${${name}},`, "").split(",")) if (p) out.add(p);
  return out;
}
const verifySrc = read("packages/adapters/src/verify/gcp.ts").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const STEPS = [...verifySrc.matchAll(/step\("([a-z]+\.[A-Za-z.]+)"/g)].map((m) => m[1]!);

test("verify 필수 단계 권한이 확인 역할·관찰 역할 둘 다에 있다 (projects describe 가 첫 단계)", () => {
  assert.ok(STEPS.length >= 5, STEPS.join(","));
  assert.equal(STEPS[0], "resourcemanager.projects.get");
  const verify = permsOf("VERIFY_PERMS"), observe = permsOf("OBSERVE_PERMS");
  assert.deepEqual(STEPS.filter((p) => !verify.has(p)), [], "VERIFY_PERMS 에 빠짐");
  assert.deepEqual(STEPS.filter((p) => !observe.has(p)), [], "OBSERVE_PERMS 에 빠짐");
  assert.deepEqual([...verify].filter((p) => !STEPS.includes(p)), [], "확인 역할은 verify 가 부르는 것만 (넓히지 않음)");
});

test("verify 선택 찌르기 권한은 관찰 역할에 다 있다", () => {
  const observe = permsOf("OBSERVE_PERMS");
  const need = OPTIONAL_PROBES.flatMap((p) => GCP_COMMAND_PERMISSIONS[p.key] ?? []);
  assert.ok(need.length > 0);
  assert.deepEqual(need.filter((p) => !observe.has(p)), []);
});

test("확인 역할은 svc-observe 에 조건 없이 붙고, roles/browser 같은 넓은 기본 역할은 붙이지 않는다", () => {
  assert.match(sh, /ensure_role platform_observe_verify .*--permissions="\$\{VERIFY_PERMS\}"/);
  assert.match(sh, /ensure_project_binding "\$\{OBSERVE_SA\}" "projects\/\$\{PROJECT_ID\}\/roles\/platform_observe_verify"/);
  assert.ok(!/add-iam-policy-binding[^\n]*roles\/(browser|viewer)/.test(sh));
});
