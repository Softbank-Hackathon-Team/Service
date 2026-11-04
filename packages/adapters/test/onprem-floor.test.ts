// W3: 온프레 바닥(할당량)을 git 으로. 값은 차트 floor.yaml 이 읽고, 한도는 Terraform 경로와 같은 함수(quota)에서 온다. 실클라우드·클러스터 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppSpecV2, ChartValues } from "@svc/contracts";
import { DEMO_SPEC, onpremGitFloorOutputs, targetBuilderFor, type Target } from "../src/index.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "onprem", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" } as Target;
const onprem = targetBuilderFor("onprem");
const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const hasHelm = (() => { try { execFileSync("helm", ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();

// 요청량이 다 있는 명세 (할당량이 계산되게)
function withRequests(): AppSpecV2 {
  const s = structuredClone(DEMO_SPEC) as unknown as { components: Array<{ kind: string; props: { resources?: object } }> };
  s.components = s.components.map((c) => (c.kind === "service" || c.kind === "job"
    ? { ...c, props: { ...c.props, resources: { ...c.props.resources, request: { cpuMilli: 100, memMiB: 128 } } } } : c));
  return AppSpecV2.parse(s);
}

test("floor 값: 켜기는 배포 때 채우는 자리표시, 한도는 Terraform namespace_json 과 같은 숫자 (한 함수)", () => {
  const spec = withRequests();
  const v = ChartValues.parse(onprem.toWorkloadValues(spec, {}, T));
  assert.equal(v.floor?.enabled, "<env:onpremFloorViaGit>");
  const tf = onprem.toTerraformV2(spec, T);
  const ns = JSON.parse(String(tf.vars.namespace_json)) as Record<string, { quota_cpu_m: number | null; quota_memory_mi: number | null }>;
  const q = Object.values(ns)[0]!;
  assert.deepEqual(v.floor?.quota, { cpuMilli: q.quota_cpu_m, memoryMi: q.quota_memory_mi });
  // apply 가 Terraform 대신 내는 출력의 네임스페이스 = Terraform 이 만들었을 이름
  assert.equal(onpremGitFloorOutputs(spec).namespace, tf.vars.k8s_namespace);
  assert.equal(onpremGitFloorOutputs(spec).link_outputs, "{}");
});

test("거부: 요청량이 하나라도 없으면 한도를 지어내지 않는다 (quota 빈 칸 → 차트가 할당량을 안 그림), 클라우드 값에는 floor 가 없다", () => {
  const v = ChartValues.parse(onprem.toWorkloadValues(DEMO_SPEC, {}, T));
  const tfq = Object.values(JSON.parse(String(onprem.toTerraformV2(DEMO_SPEC, T).vars.namespace_json)) as Record<string, { quota_cpu_m: number | null }>)[0]!;
  if (tfq.quota_cpu_m === null) assert.equal(v.floor?.quota.cpuMilli, undefined);
  const gcp = targetBuilderFor("gcp").toWorkloadValues(DEMO_SPEC, {}, { ...T, provider: "gcp" } as Target) as Record<string, unknown>;
  assert.equal(gcp.floor, undefined);
});

test("차트 floor.yaml: \"1\" 일 때만 platform-quota 를 그리고, \"0\" 이면 아무것도 안 그린다", { skip: hasHelm ? false : "helm 없음" }, () => {
  const v = onprem.toWorkloadValues(withRequests(), {}, T) as Record<string, unknown> & { floor: { enabled: string } };
  const dir = mkdtempSync(join(tmpdir(), "floor-"));
  const render = (enabled: string) => {
    const f = join(dir, `v-${enabled}.json`);
    writeFileSync(f, JSON.stringify({ ...v, floor: { ...v.floor, enabled } }));
    return execFileSync("helm", ["template", "a", CHART, "-f", f], { encoding: "utf8" });
  };
  assert.match(render("1"), /kind: ResourceQuota\n[\s\S]*name: platform-quota[\s\S]*requests\.cpu: "\d+m"/);
  assert.doesNotMatch(render("0"), /kind: ResourceQuota/);
});
