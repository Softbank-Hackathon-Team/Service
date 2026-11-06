// 충실도 표: 온프레 이전 묶음의 NetworkPolicy·db-tunnel 은 샌드박스에서 실제와 다르게 돈다는 것을 콘솔에 그대로 보인다
//   NetworkPolicy = 가상 API 에만 적용(vCluster 가 호스트로 안 내림), db-tunnel = 돌리지도 연결을 보지도 않음
import { test } from "node:test";
import assert from "node:assert/strict";
import { workerFidelity, type FidelityFacts } from "../src/rehearsal/fidelity.js";
import type { Presence } from "../src/rehearsal/substitute.js";

const facts = (present: Presence[]): FidelityFacts => ({ target: "onprem-k3s", bundleSha256: "a".repeat(64), refs: {}, present: new Set(present),
  databases: 0, k8sMinor: { value: "1.33", known: true }, imagesMirrored: true, quota: undefined as unknown as FidelityFacts["quota"] });
const item = (present: Presence[], id: string) => workerFidelity(facts(present)).items.find((x) => x.id === id)!;

test("NetworkPolicy 가 있으면: 도착은 CNI 가 적용, 샌드박스는 가상 API 에만 적용하고 막지 않는다고 쓴다", () => {
  const n = item(["network_policy"], "network");
  assert.match(n.real, /NetworkPolicy \(도착 CNI 가 적용\)/);
  assert.match(n.sandbox, /호스트로 내리지 않아 막지 않는다/);
  assert.doesNotMatch(item([], "network").sandbox, /NetworkPolicy/, "없으면 예전 문구");
});

test("db-tunnel 만 있으면 '연결도 보지 않음', cloudflared 터널이 같이 있으면 둘을 나눠 쓴다", () => {
  const only = item(["db_tunnel"], "tunnel");
  assert.equal(only.status, "not_checked");
  assert.match(only.sandbox, /db-tunnel 은 돌리지 않음, 연결도 보지 않음/);
  assert.doesNotMatch(only.sandbox, /터널 대상 Service 연결만/);
  const both = item(["tunnel", "db_tunnel"], "tunnel");
  assert.match(both.sandbox, /cloudflared 는 돌리지 않음, 터널 대상 Service 연결만 본다/);
  assert.match(both.sandbox, /db-tunnel 은 돌리지 않음/);
});
