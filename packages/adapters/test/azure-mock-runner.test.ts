import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppSpec, type TargetEnv } from "@svc/contracts";
import { adapterFor, azure, azureRunner, runnerFor, RunnerUnavailable, DEMO_INVENTORY } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const spec = AppSpec.parse(adapterFor("aws").normalize(DEMO_INVENTORY.aws).spec);   // DB 있는 3티어 API
const t: TargetEnv = { envId: "44444444-4444-4444-8444-444444444444", provider: "azure_mock", region: "default" };
const fast = azureRunner.createAzureMockRunner({ latencyMs: 0, now: () => new Date("2026-11-07T00:00:00Z") });

test("Azure Mock apply: 모듈 output 3개를 같은 키로 돌려주고, 같은 입력이면 같은 값", async () => {
  const a = await fast.apply(spec, t);
  const b = await fast.apply(structuredClone(spec), { ...t });
  assert.equal(a.ok, true); assert.equal(a.mock, true);
  const outputs = [...readFileSync(join(root, "infra/modules/azure/app/main.tf"), "utf8")
    .matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(a.tfOutputs).sort(), outputs);
  assert.deepEqual(a.tfOutputs, b.tfOutputs);
  assert.match(a.tfOutputs.db_fqdn!, /\.postgres\.database\.azure\.com$/);
  assert.match(a.tfOutputs.app_identity_client_id!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  // 자원 종류 = 번역 함수가 말한 종류. 전부 Succeeded, ID는 Azure 모양
  assert.deepEqual(a.resources.map((r) => r.type), azure.resourceTypes(spec));
  for (const r of a.resources) {
    assert.equal(r.state, "Succeeded");
    assert.match(r.id, /^\/subscriptions\/0{8}-0{4}-0{4}-0{4}-0{12}\/resourceGroups\/rg-platform-[0-9a-f]{6}\/providers\/Microsoft\./);
  }
});

test("Azure Mock apply 출력을 Helm 값에 넣으면 자리표시가 사라진다", async () => {
  const { tfOutputs } = await fast.apply(spec, t);
  const values = JSON.stringify(adapterFor("azure_mock").toHelmValues(spec, tfOutputs, t));
  assert.doesNotMatch(values, /<tf-output:/);
});

test("Azure Mock plan: 리전은 koreacentral, 추가만 있고 이름은 번역 결과와 같다", async () => {
  const p = await fast.plan(spec, t);
  assert.equal(p.region, "koreacentral");
  assert.deepEqual(p.summary, { add: p.resources.length, change: 0, destroy: 0 });
  assert.equal(p.vars.location, "koreacentral");
  assert.ok(p.resources.some((r) => r.name === p.vars.name_key_vault && r.state === "Creating"));
});

test("Azure Mock status: 환경 기반 자원 4개(RG·VNet·AKS·ACR), healthy, 시계 주입", async () => {
  const s = await fast.status(t);
  assert.equal(s.health, "healthy"); assert.equal(s.region, "koreacentral");
  assert.equal(s.checkedAt, "2026-11-07T00:00:00.000Z");
  assert.deepEqual(s.resources.map((r) => r.type),
    ["azurerm_resource_group", "azurerm_virtual_network", "azurerm_kubernetes_cluster", "azurerm_container_registry"]);
});

test("Azure Mock destroy: 만든 수만큼 지운다", async () => {
  const d = await fast.destroy(spec, t);
  assert.equal(d.ok, true); assert.equal(d.destroyed, (await fast.plan(spec, t)).resources.length);
});

test("가짜 지연: latencyMs만큼 기다린다 (apply = 3번)", async () => {
  const r = await azureRunner.createAzureMockRunner({ latencyMs: 20 }).apply(spec, t);
  assert.ok(r.elapsedMs >= 55, `elapsed ${r.elapsedMs}`);
});

test("장애 주입: failOn=apply 면 ok:false, 출력 없음", async () => {
  const r = await azureRunner.createAzureMockRunner({ latencyMs: 0, failOn: "apply" }).apply(spec, t);
  assert.equal(r.ok, false); assert.deepEqual(r.tfOutputs, {});
  assert.ok(r.resources.every((x) => x.state === "Failed"));
});

test("runnerFor: Azure만 실행기, AZURE_MOCK 기본 켜짐, 0이면 막는다", () => {
  assert.equal(runnerFor("aws", {}), null);
  assert.equal(runnerFor("gcp", {}), null);
  assert.equal(runnerFor("azure_mock", {})?.mock, true);
  assert.equal(runnerFor("azure_mock", { AZURE_MOCK: "1" })?.provider, "azure_mock");
  assert.throws(() => runnerFor("azure_mock", { AZURE_MOCK: "0" }),
    (e: unknown) => e instanceof RunnerUnavailable && e.code === "AZURE_MOCK_DISABLED");
});
