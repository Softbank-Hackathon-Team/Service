// IR-04: api-flow 의 출발 범위가 contracts SourceScope 에 맞는지 (tools/real/m-import/scope.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceScope } from "@svc/contracts";
import { scopeFromEnv } from "../../../tools/real/m-import/scope.js";

test("IR-04 MI_NAMESPACES·MI_DATABASE·MI_ECS_CLUSTER → sourceScope (SourceScope.parse 통과)", () => {
  const s = scopeFromEnv({ MI_NAMESPACES: "real-app, shop ", MI_DATABASE: "shop/shop-db", MI_ECS_CLUSTER: "realecs-src" });
  assert.deepEqual(s, { namespaces: ["real-app", "shop"], database: "shop/shop-db", ecsCluster: "realecs-src" });
  assert.deepEqual(SourceScope.parse(s), s);
});

test("IR-04 거부: 아무것도 없으면 안 보냄(예전 자동 고르기), 잘못된 네임스페이스는 계약이 막음", () => {
  assert.equal(scopeFromEnv({}), undefined);
  assert.equal(scopeFromEnv({ MI_NAMESPACES: " , " }), undefined);
  assert.throws(() => SourceScope.parse(scopeFromEnv({ MI_NAMESPACES: "Bad_NS" })));
});
