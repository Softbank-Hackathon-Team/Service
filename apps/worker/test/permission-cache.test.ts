// #373 B2 단위 시험: 재사용 손잡이·묶음 정의 지문·저장 모양·"묶음마다 따로 견주나" (DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { StoredPermissionCheck, type PermissionBundle, type PermissionGap } from "@svc/contracts";
import { bundleDef, checkedEntries, permissionCacheSec, PERMISSION_CACHE_SEC_DEFAULT, storedResult } from "../src/permission-cache.js";
import { checksEach } from "../src/permission-gate.js";

const bundles = JSON.parse(readFileSync(new URL("../../../infra/permissions/permission-bundles.json", import.meta.url), "utf8")).bundles as PermissionBundle[];
const b = bundles.find((x) => x.id === "aws.observe")!;

test("PERMISSION_CACHE_SEC: 기본 600, 0·음수·숫자 아님 = 끔", () => {
  assert.equal(PERMISSION_CACHE_SEC_DEFAULT, 600);
  assert.equal(permissionCacheSec({}), 600);
  assert.equal(permissionCacheSec({ PERMISSION_CACHE_SEC: "" }), 600);
  assert.equal(permissionCacheSec({ PERMISSION_CACHE_SEC: "120" }), 120);
  for (const v of ["0", "-5", "abc"]) assert.equal(permissionCacheSec({ PERMISSION_CACHE_SEC: v }), 0, v);
});

test("묶음 정의 지문: 이전마다 다른 onSide 는 무시, 권한·API·주체가 바뀌면 다름", () => {
  assert.equal(bundleDef({ ...b, onSide: "source" } as PermissionBundle), bundleDef({ ...b, onSide: "target" } as PermissionBundle));
  assert.notEqual(bundleDef({ ...b, permissions: [...b.permissions, "iam:GetUser"] }), bundleDef(b));
  assert.notEqual(bundleDef({ ...b, principal: "svc-operate" }), bundleDef(b));
  assert.notEqual(bundleDef({ ...b, requiredWhen: ["postgres"] }), bundleDef(b), "gap 에 실리는 필요 조건도");
  const [c] = checkedEntries([b], new Date("2026-11-07T00:00:00Z"));
  assert.deepEqual(c, { bundleId: "aws.observe", at: "2026-11-07T00:00:00.000Z", def: bundleDef(b) });
});

test("저장 모양: permission-check 와 같은 판 규칙 + checked 는 있을 때만 (옛 줄 모양 그대로 읽힘)", () => {
  const g: PermissionGap = { bundleId: b.id, envId: randomUUID(), cloud: "aws", stage: "observe", side: "target", principal: b.principal, role: b.role,
    requiredWhen: b.requiredWhen, level: "warn", missing: [], missingApis: [], unverified: "x", grantedVersion: 3, requiredVersion: 4 };
  assert.deepEqual(storedResult(4, []), { requiredVersion: 4, grantedVersion: 4, gaps: [] });
  assert.equal(storedResult(4, [g]).grantedVersion, 3);
  assert.equal(storedResult(4, [{ ...g, grantedVersion: null }]).grantedVersion, null);
  const withChecked = storedResult(4, [g], checkedEntries([b]));
  assert.equal(StoredPermissionCheck.safeParse(withChecked).success, true);
  assert.equal(StoredPermissionCheck.safeParse({ requiredVersion: 4, grantedVersion: 4, gaps: [] }).success, true, "checked 없는 옛 줄");
  assert.equal(StoredPermissionCheck.safeParse({ ...withChecked, checked: [{ bundleId: "x", at: "y" }] }).success, false, "지문 없는 기록은 거부");
});

test("묶음마다 따로 견주나: 빌린 자격·계정이 다 있어야 (아니면 '확인 못 함' 한 줄로 접힘 → 저장·재사용 안 함)", () => {
  const base = { envId: randomUUID(), targetProject: null, region: null };
  assert.equal(checksEach({ ...base, provider: "aws", accountId: "111122223333", awsEnv: {} }), true);
  assert.equal(checksEach({ ...base, provider: "aws", accountId: "111122223333" }), false, "자격 없음");
  assert.equal(checksEach({ ...base, provider: "aws", accountId: "1234", awsEnv: {} }), false, "계정 번호 모양 아님");
  assert.equal(checksEach({ ...base, provider: "gcp", accountId: "cust-prj", gcpToken: "t" }), true);
  assert.equal(checksEach({ ...base, provider: "gcp", accountId: null, gcpToken: "t" }), false);
  assert.equal(checksEach({ ...base, provider: "onprem", accountId: null }), false);
});
