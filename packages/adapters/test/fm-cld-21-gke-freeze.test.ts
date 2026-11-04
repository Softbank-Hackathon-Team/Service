// FM-CLD-21: GKE 업그레이드 멈춤 옵션 (gcp/env). 기본은 끔(실클라우드 미확인), 켜면 NO_UPGRADES 제외 기간 + 뒤 plan 에서 안 바뀜
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tf = readFileSync(new URL("../../../infra/modules/gcp/env/main.tf", import.meta.url), "utf8");

test("upgrade_freeze_hours: 기본 0(끔), 0~720 만 받음, 켜면 NO_UPGRADES·날짜는 레포에 없음", () => {
  assert.match(tf, /variable "upgrade_freeze_hours" \{[\s\S]*?default = 0[\s\S]*?upgrade_freeze_hours >= 0 && var\.upgrade_freeze_hours <= 720/);
  assert.match(tf, /dynamic "maintenance_policy" \{\s*for_each = var\.upgrade_freeze_hours > 0 \? \[1\] : \[\]/);
  assert.match(tf, /scope = "NO_UPGRADES"/);
  assert.match(tf, /ignore_changes = \[maintenance_policy\]/);
  assert.doesNotMatch(tf, /20\d\d-\d\d-\d\dT/, "날짜를 레포에 적지 않음");
});
