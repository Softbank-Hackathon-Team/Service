import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type TargetEnv } from "@svc/contracts";
import { DbNetworkError, fillTfVars, targetBuilderFor, withDbNetworkV2, resourceTypesV2For } from "../src/index.js";

// VTA11: TA11 경계값·거부·멱등 (withDbNetworkV2 · fillTfVars JSON 자리표시 · 모르는 종류)
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default" }) as TargetEnv;
const v2tf = (p: "aws" | "gcp") => targetBuilderFor(p).toTerraformV2(structuredClone(BASE), T(p));
const FACTS = { dbPublicSubnetIdsJson: `["subnet-a","subnet-b"]`, accountId: "000000000000", clusterName: "c", vpcId: "vpc-1", dbSubnetIdsJson: `["subnet-c"]`, tenantId: "t" };

test("withDbNetworkV2 멱등: 두 번 적용해도 허용 주소가 늘지 않고 결과가 같음", () => {
  const env = { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32,198.51.100.0/24", DB_DISPOSABLE: "1" };
  const once = withDbNetworkV2(v2tf("aws"), "aws", env);
  const twice = withDbNetworkV2(once, "aws", env);
  assert.equal(twice.vars.postgres_json, once.vars.postgres_json);
  const pg = JSON.parse(String(twice.vars.postgres_json))[0];
  assert.deepEqual(JSON.parse(pg.peer_cidrs_json), ["198.51.100.0/24", "203.0.113.7/32"]);   // 정렬·중복 없음
});

test("withDbNetworkV2: postgres 항목이 없으면(빈 목록) 에러 없이 빈 목록 그대로", () => {
  const tf = { moduleRef: { path: "x", gitSha: "y" }, vars: { postgres_json: "[]" } };
  const out = withDbNetworkV2(tf, "aws", { DB_DISPOSABLE: "1" });
  assert.equal(out.vars.postgres_json, "[]");
});

test("withDbNetworkV2 거부: postgres_json 이 JSON 이 아니면 오류로 멈춤 (조용히 통과하지 않음, 지금은 SyntaxError 그대로 — 설계 어긋남 절 참고)", () => {
  const tf = { moduleRef: { path: "x", gitSha: "y" }, vars: { postgres_json: "not-json" } };
  assert.throws(() => withDbNetworkV2(tf, "aws", { DB_DISPOSABLE: "1" }));
});

test("fillTfVars: 값에 따옴표·역슬래시·줄바꿈이 있어도 JSON 이 깨지지 않음 (문자열이 그대로 보존)", () => {
  const nasty = `a"b\\c\nd`;
  const vars = { postgres_json: JSON.stringify([{ name: "db", note: "<env:tenantId>" }]) };
  const f = fillTfVars(vars, { tenantId: nasty });
  assert.deepEqual(f.missing, []);
  assert.equal(JSON.parse(String(f.vars.postgres_json))[0].note, nasty);
});

test("fillTfVars: JSON 안에서 못 채운 자리표시는 missing 에 올라가고 자리표시는 그대로 (지어내지 않음)", () => {
  const vars = { postgres_json: JSON.stringify([{ a: "<env:vpcId>", b: ["<env:nopeA>", "x"] }]), plain: "<env:nopeB>" };
  const f = fillTfVars(vars, { vpcId: "vpc-1" });
  assert.deepEqual(f.missing, ["nopeA", "nopeB"]);
  const pg = JSON.parse(String(f.vars.postgres_json))[0];
  assert.equal(pg.a, "vpc-1");
  assert.deepEqual(pg.b, ["<env:nopeA>", "x"]);
  assert.equal(f.vars.plain, "<env:nopeB>");
});

test("fillTfVars: 자리표시가 없는 JSON·깨진 JSON·숫자·불리언 값은 그대로, 입력 객체는 안 바뀜", () => {
  const vars = { a: `{"x":1}`, b: `{broken <env:vpcId>`, c: 3, d: true };
  const before = JSON.stringify(vars);
  const f = fillTfVars(vars, { vpcId: "vpc-1" });
  assert.equal(f.vars.a, `{"x":1}`);
  assert.equal(f.vars.b, `{broken vpc-1`);   // 깨진 JSON 은 글자 바꾸기 (예전 동작)
  assert.equal(f.vars.c, 3);
  assert.equal(f.vars.d, true);
  assert.equal(JSON.stringify(vars), before);
});

test("fillTfVars: 값이 JSON 문자열(서브넷 목록)이어도 JSON 안에서는 글자 하나로 들어감 (이중 해석 없음)", () => {
  const tf = withDbNetworkV2(v2tf("aws"), "aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32" });
  const f = fillTfVars(tf.vars, FACTS);
  const pg = JSON.parse(String(f.vars.postgres_json))[0];
  assert.equal(pg.public_subnet_ids_json, FACTS.dbPublicSubnetIdsJson);
  assert.deepEqual(JSON.parse(pg.public_subnet_ids_json), ["subnet-a", "subnet-b"]);
});

test("resourceTypesV2For: 아직 Builder 가 모르는 종류(cache·objectStore·queue)가 있어도 던지지 않고 같은 입력이면 같은 목록", () => {
  for (const p of ["aws", "gcp", "onprem", "azure_mock"] as const) {
    const mk = () => { const s: any = structuredClone(BASE); s.components.push({ id: "c1", kind: "cache", props: { engine: "redis", version: "7", memoryMiB: 512, clusterMode: false, tls: true, auth: true, ha: false } }); return s; };
    assert.deepEqual(resourceTypesV2For(p, mk()), resourceTypesV2For(p, mk()), p);
  }
});
