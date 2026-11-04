import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type TargetEnv } from "@svc/contracts";
import { DbNetworkError, fillTfVars, targetBuilderFor, withDbNetworkV2 } from "../src/index.js";

// TA11: tf:real --v2 가 쓰는 조각 — withDbNetworkV2(데모 DB 네트워크 v2 판) · fillTfVars(JSON 안 자리표시)
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default" }) as TargetEnv;
const v2tf = (p: "aws" | "gcp") => targetBuilderFor(p).toTerraformV2(structuredClone(BASE), T(p));

test("withDbNetworkV2: 아무것도 안 켰으면 같은 객체 (지문 안 바뀜), 켜면 postgres 항목에 공개·허용·삭제 보호", () => {
  const tf = v2tf("aws");
  assert.equal(withDbNetworkV2(tf, "aws", {}), tf);
  const on = withDbNetworkV2(tf, "aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32", DB_DISPOSABLE: "1" });
  const [pg] = JSON.parse(String(on.vars.postgres_json));
  assert.equal(pg.public, true);
  assert.deepEqual(JSON.parse(pg.peer_cidrs_json), ["203.0.113.7/32"]);
  assert.equal(pg.public_subnet_ids_json, "<env:dbPublicSubnetIdsJson>");
  assert.equal(pg.deletion_protection, false);
  const g = JSON.parse(String(withDbNetworkV2(v2tf("gcp"), "gcp", { DB_DISPOSABLE: "1" }).vars.postgres_json))[0];
  assert.equal(g.deletion_protection, false);
  assert.equal(g.public, false);
  // postgres_json 이 없는 호출은 안 건드림
  const v1 = { moduleRef: { path: "x", gitSha: "y" }, vars: { a: 1 } };
  assert.equal(withDbNetworkV2(v1, "aws", { DB_DISPOSABLE: "1" }), v1);
});

test("withDbNetworkV2 거부: 넓은 CIDR·허용 주소 없는 공개는 v1 과 DbNetworkError", () => {
  assert.throws(() => withDbNetworkV2(v2tf("aws"), "aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: "0.0.0.0/0" }), DbNetworkError);
  assert.throws(() => withDbNetworkV2(v2tf("gcp"), "gcp", { DB_PUBLIC: "1" }), DbNetworkError);
});

test("fillTfVars: JSON 문자열 안 자리표시는 JSON 을 깨지 않고 채움, v1 통째 자리표시는 예전 그대로", () => {
  const tf = withDbNetworkV2(v2tf("aws"), "aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32" });
  const f = fillTfVars(tf.vars, { dbPublicSubnetIdsJson: `["subnet-a","subnet-b"]`, accountId: "000000000000", clusterName: "c", vpcId: "vpc-1",
    dbSubnetIdsJson: `["subnet-c"]`, tenantId: "t" });
  assert.deepEqual(f.missing, []);
  const [pg] = JSON.parse(String(f.vars.postgres_json));
  assert.deepEqual(JSON.parse(pg.public_subnet_ids_json), ["subnet-a", "subnet-b"]);
  assert.equal(f.vars.db_subnet_ids_json, `["subnet-c"]`, "통째 자리표시는 글자 그대로 바꿈");
  // 빠진 사실은 missing 으로 (JSON 안이어도)
  assert.deepEqual(fillTfVars(tf.vars, {}).missing.includes("dbPublicSubnetIdsJson"), true);
  // 자리표시 없는 JSON 은 글자 하나 안 바뀜
  assert.equal(fillTfVars({ x_json: `{"b":1, "a":2}` }, {}).vars.x_json, `{"b":1, "a":2}`);
});
