// ecs-check 시험 (정상 1 + 거부들). 클라우드 호출 0. 대상: tools/real/flow/ecs-check.ts (레포 안 실측 흐름)
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeV2, DEMO_INVENTORY as DEMO_INVENTORY_V2 } from "@svc/adapters";
import { checkEcs } from "../../../tools/real/flow/ecs-check.js";

const view = () => { const r = normalizeV2(DEMO_INVENTORY_V2.aws!).result; return { specV2: structuredClone(r.spec), fieldMetaV2: structuredClone(r.fieldMeta) }; };
const demo = { service: "shop-api", replicas: { min: 2, max: 6 }, targetCpuPct: 70, serviceAccount: "shop-api-task" };

test("정상: ECS 데모 shop-api 가 기대대로면 FAIL 0", () => {
  const rows = checkEcs(view(), demo);
  assert.deepEqual(rows.filter((r) => r.result === "FAIL"), []);
  assert.ok(rows.some((r) => r.item.startsWith("실행 방식") && r.result === "PASS"));
});
test("거부: 서비스 이름이 다르면 FAIL, 복제 수가 다르면 FAIL, runtime 이 k8s 면 FAIL, 비밀 글자가 있으면 FAIL", () => {
  assert.ok(checkEcs(view(), { service: "nope" }).some((r) => r.result === "FAIL"));
  assert.ok(checkEcs(view(), { ...demo, replicas: { min: 1, max: 2 } }).some((r) => r.result === "FAIL"));
  const v = view(); const c = (v.specV2 as any).components.find((x: any) => x.id === "shop-api"); c.props.runtime = "k8s";
  assert.ok(checkEcs(v, demo).some((r) => r.item.startsWith("실행 방식") && r.result === "FAIL" || r.item === "spec_v2 모양 (AppSpecV2)" && r.result === "FAIL"));
  assert.ok(checkEcs(view(), demo, "shop-api").some((r) => r.item.startsWith("비밀 값") && r.result === "FAIL"));
  assert.ok(checkEcs({ specV2: { nope: 1 } }, demo).some((r) => r.result === "FAIL"));
});
