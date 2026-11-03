// VI3bfix: 감사 sourceInventory 사본에서 DB·캐시 주소 값을 가린다 (Cloud SQL·RDS·ElastiCache·Memorystore). 종류·이름은 남음
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawInventory } from "@svc/contracts";
import { inventoryForAudit } from "@svc/adapters";

const inv = (items: Array<Record<string, unknown>>): RawInventory => ({ provider: "aws", coverage: {}, items } as unknown as RawInventory);

test("RDS Endpoint 값은 <hidden>, 식별자·엔진은 남음 (예전엔 주소 그대로 감사에 남았음)", () => {
  const src = inv([{ kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres",
    Endpoint: "shop-db.abcdefgh1234.ap-northeast-2.rds.amazonaws.com" }]);
  const out = JSON.stringify(inventoryForAudit(src));
  assert.ok(!out.includes("rds.amazonaws.com"), out);
  assert.ok(out.includes('"Endpoint":"<hidden>"'));
  assert.ok(out.includes("shop-db") && out.includes("postgres"));
});

test("ElastiCache 두 주소·Memorystore host 도 가림, 값이 null 이면 null 그대로 (없던 주소를 있다고 안 함)", () => {
  const out = inventoryForAudit(inv([
    { kind: "elasticache.replicationGroup", ReplicationGroupId: "sess", PrimaryEndpoint: "sess.x.cache.amazonaws.com", ConfigurationEndpoint: null },
    { kind: "memorystore.instance", name: "projects/p/locations/r/instances/m", host: "10.30.0.4", port: 6379 },
  ])).items as Array<Record<string, unknown>>;
  assert.equal(out[0]!.PrimaryEndpoint, "<hidden>");
  assert.equal(out[0]!.ConfigurationEndpoint, null);
  assert.equal(out[1]!.host, "<hidden>");
  assert.equal(out[1]!.port, 6379);
});

test("Cloud SQL: ipAddresses 는 종류만, 단일 ipAddress 칸은 지움", () => {
  const out = inventoryForAudit(inv([{ kind: "cloudsql.instance", name: "db",
    ipAddresses: [{ type: "PRIVATE", ipAddress: "10.20.0.5" }, { type: "PRIMARY", ipAddress: "34.1.2.3" }], ipAddress: "10.20.0.5" }]));
  const i = out.items[0] as Record<string, unknown>;
  assert.deepEqual(i.ipAddresses, [{ type: "PRIVATE" }, { type: "PRIMARY" }]);
  assert.equal("ipAddress" in i, false);
});

test("원본은 그대로, 주소 칸이 없는 항목은 같은 객체 그대로(예전 동작)", () => {
  const plain = { kind: "eks.cluster", name: "c" };
  const rds = { kind: "rds.dbInstance", DBInstanceIdentifier: "d", Endpoint: "d.x.rds.amazonaws.com" };
  const src = inv([plain, rds]);
  const before = JSON.stringify(src);
  const out = inventoryForAudit(src);
  assert.equal(JSON.stringify(src), before);
  assert.equal(out.items[0], plain);
  assert.notEqual(out.items[1], rds);
});
