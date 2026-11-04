// E2E-v5: azure_mock 도착. 신원 2개 명세는 계획 단계 failed(UNSUPPORTED_V2) 전에 precheck 가 block 으로 막아야 한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { v2PrecheckItems } from "@svc/adapters";
import { ONE } from "./demo-one.js";

const v2: AppSpecV2 = ONE;
const svc = v2.components.find((c) => c.kind === "service")!;
if (svc.kind !== "service") throw new Error("service 없음");
const twoIds = AppSpecV2.parse({ ...v2, components: [...v2.components,
  { ...svc, id: `${svc.id}-2`, props: { ...svc.props, serviceAccount: `${svc.props.serviceAccount}-2` } }] });
const row = (s: AppSpecV2) => ({ specV2: s });
const shape = (items: { id: string; message: string }[]) => items.filter((i) => i.message.includes("신원 1개만"));

test("거부: azure_mock 도착 + 신원 2개 → precheck block (PC-V2-UNSUP)", () => {
  const items = v2PrecheckItems("azure_mock", row(twoIds));
  const hit = shape(items);
  assert.equal(hit.length, 1);
  assert.match(hit[0]!.id, /^PC-V2-UNSUP-/);
  assert.equal(items.find((i) => i.id === hit[0]!.id)!.level, "block");
});

test("정상: 신원 1개면 azure_mock 도 막지 않고, 다른 도착은 신원 2개도 이 검사로 막지 않는다", () => {
  assert.equal(shape(v2PrecheckItems("azure_mock", row(v2))).length, 0);
  for (const p of ["aws", "gcp", "onprem"] as const) assert.equal(shape(v2PrecheckItems(p, row(twoIds))).length, 0, p);
});
