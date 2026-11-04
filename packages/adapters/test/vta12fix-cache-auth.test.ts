// VTA12fix: 출발 캐시 auth=true 를 AWS 가 AUTH 없이 조용히 그리지 않는다 → 사전 점검 사람 확인(needsHuman). GCP·azure_mock 은 옮기므로 그대로
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2Blockers, v2PrecheckItems } from "../src/index.js";

// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
type Raw = Record<string, any>;
function withCache(auth: boolean | null, extra?: (s: Raw) => void): AppSpecV2 {
  const s: Raw = structuredClone(BASE);
  const svc = s.components.find((c: Raw) => c.kind === "service").id as string;
  s.components.push({ id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth } });
  s.links.push({ from: svc, to: "shop-cache", intent: "connect" });
  extra?.(s);
  return AppSpecV2.parse(s);
}
const human = (p: "aws" | "gcp" | "azure_mock", spec: AppSpecV2) => v2Blockers(spec, targetBuilderFor(p).capabilities()).needsHuman.filter((x) => /AUTH/.test(x));

test("AWS: auth=true 캐시 → needsHuman (어느 캐시인지·어떻게 푸는지), unsupported 아님", () => {
  const b = v2Blockers(withCache(true), targetBuilderFor("aws").capabilities());
  assert.deepEqual(b.unsupported, []);
  const h = b.needsHuman.filter((x) => /AUTH/.test(x));
  assert.equal(h.length, 1);
  assert.match(h[0]!, /^shop-cache: .*auth=false/);
});

test("AWS: auth=false 는 알림 없음 (사람이 AUTH 없이 가기로 함). CA-1: null(출발에서 못 읽음)은 켬·끔으로 몰지 않고 모든 도착에서 사람 확인", () => {
  assert.deepEqual(human("aws", withCache(false)), []);
  for (const p of ["aws", "gcp", "azure_mock"] as const) assert.match(human(p, withCache(null)).join(), /AUTH 사용 여부를 못 읽음/, p);
});

test("GCP·azure_mock: AUTH 를 옮기므로 auth=true 도 알림 없음, GCP 모듈은 auth_enabled 로 옮김", () => {
  assert.deepEqual(human("gcp", withCache(true)), []);
  assert.deepEqual(human("azure_mock", withCache(true)), []);
  assert.ok(targetBuilderFor("gcp").capabilities().includes("kind.cache.auth"));
  assert.ok(!targetBuilderFor("aws").capabilities().includes("kind.cache.auth"), "AWS 가 AUTH 를 옮기게 되면 이 시험과 needsHuman 을 같이 고친다");
  assert.match(readFileSync(new URL("../../../infra/modules/gcp/kinds/cache/main.tf", import.meta.url), "utf8"), /auth_enabled\s*=\s*local\.auth/);
  assert.doesNotMatch(readFileSync(new URL("../../../infra/modules/aws/kinds/cache/main.tf", import.meta.url), "utf8"), /auth_token\s*=/);
});

test("캐시 여러 개: auth=true 인 것마다 한 줄, id 순 (결정적)", () => {
  const spec = withCache(true, (s) => {
    s.components.push({ id: "a-cache", kind: "cache", props: { engine: "valkey", memoryMiB: null, tls: null, auth: true } },
      { id: "z-cache", kind: "cache", props: { engine: "redis", memoryMiB: null, tls: null, auth: false } });
  });
  const h = human("aws", spec);
  assert.deepEqual(h.map((x) => x.split(":")[0]), ["a-cache", "shop-cache"]);
  assert.deepEqual(human("aws", spec), h);
});

test("사전 점검 v2 항목: AWS 도착이면 block 'FAIL 사람 확인 필요', 렌더 자체는 그대로(auth 값 true 를 변수로 보냄 — 지어내지 않음)", () => {
  const spec = withCache(true);
  const items = v2PrecheckItems("aws", { specV2: spec });
  const it = items.find((i) => /AUTH/.test(i.message))!;
  assert.equal(it.level, "block");
  assert.match(it.message, /^FAIL 사람 확인 필요 — shop-cache:/);
  assert.ok(!v2PrecheckItems("gcp", { specV2: spec }).some((i) => /AUTH/.test(i.message)));
  const tf = targetBuilderFor("aws").toTerraformV2(spec, T("aws"));
  assert.equal(JSON.parse(String(tf.vars.cache_json))[0].auth, true);
});
