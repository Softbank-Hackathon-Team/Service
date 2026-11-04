// G3b-6: 정확도에 args·limits·프로브 시간·보조 컨테이너 수를 더 보고, 경계 밖 워크로드는 빼고, 비교한 칸·안 본 칸 목록을 싣는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportAccuracy, type RawInventory } from "@svc/contracts";
import { ACCURACY_NOT_COMPARED, DEMO_INVENTORY, measureImportAccuracy, normalizeV2, targetBuilderFor } from "../src/index.js";

type O = Record<string, any>;
const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "aws", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" } as never;
const run = (i: RawInventory, mutate?: (r: O) => void) => {
  const result = normalizeV2(i).result;
  const rendered = targetBuilderFor("aws").toWorkloadValues(result.spec, {}, T) as O;
  mutate?.(rendered);
  return measureImportAccuracy({ inventory: i, result, rendered });
};
const withExtras = (): RawInventory => {
  const i = structuredClone(DEMO_INVENTORY.gcp!);
  const d = (i.items as O[]).find((x) => x.kind === "k8s.deployment" && x.metadata.name === "shop-api")!;
  const c = d.spec.template.spec.containers[0];
  c.args = ["--mode", "api"];
  c.resources.limits = { cpu: "1", memory: "1Gi" };
  c.readinessProbe = { ...c.readinessProbe, periodSeconds: 7, failureThreshold: 4 };
  return i;
};
const pick = (a: ImportAccuracy, component: string, field: string) => a.fields.find((f) => f.component === component && f.field === field);

test("정상: 새 칸(args·limits·프로브 시간)이 일치로 잡히고, 목록 두 개가 실린다", () => {
  const a = run(withExtras());
  ImportAccuracy.parse(a);
  for (const f of ["args", "resources.cpuLimit", "resources.memoryLimit", "probes.readiness"]) assert.equal(pick(a, "shop-api", f)?.result, "match", `${f} ${JSON.stringify(pick(a, "shop-api", f))}`);
  assert.ok(a.compared?.includes("args"));
  assert.deepEqual(a.notCompared, [...ACCURACY_NOT_COMPARED]);
});

test("거부: args·limits·프로브 주기가 바뀌면 불일치, 묶음 밖 워크로드는 불일치로 안 셈", () => {
  const a = run(withExtras(), (r) => {
    // PB-1: 렌더 값은 차트 모양 (name·k8s 프로브 …Seconds)
    const w = (r.workloads as O[]).find((x) => x.name === "shop-api")!;
    w.args = ["--mode", "worker"]; w.resources.limits.cpu = "500m"; w.probes.readiness.periodSeconds = 30;
  });
  for (const f of ["args", "resources.cpuLimit", "probes.readiness"]) assert.equal(pick(a, "shop-api", f)?.result, "mismatch", f);
  // 앱 묶음 밖 워크로드: part-of 라벨이 다른 Deployment 를 하나 더
  const i = structuredClone(DEMO_INVENTORY.gcp!);
  for (const x of i.items as O[]) if (x.kind === "k8s.deployment") x.metadata.labels = { ...(x.metadata.labels ?? {}), "app.kubernetes.io/part-of": "shop" };
  const other = structuredClone((i.items as O[]).find((x) => x.kind === "k8s.deployment" && x.metadata.name === "shop-web")!);
  other.metadata.name = "billing"; other.metadata.labels = { app: "billing", "app.kubernetes.io/part-of": "billing" };
  (i.items as O[]).push(other);
  const b = run(i);
  assert.ok(!b.fields.some((f) => f.field === "workload" && f.result === "mismatch"), JSON.stringify(b.fields.filter((f) => f.result === "mismatch")));
});
