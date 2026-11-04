import { test } from "node:test";
import assert from "node:assert/strict";
import { backTarget, nextDepth } from "../src/app/nav";
import { parentOf, parseRoute } from "../src/app/routes";

test("(←) 기록: 기록 칸에 깊이가 있으면 그대로(앞뒤 이동), 없으면 새 화면이라 하나 더", () => {
  assert.equal(nextDepth(undefined, 0), 1);
  assert.equal(nextDepth(undefined, 3), 4);
  assert.equal(nextDepth(1, 3), 1, "브라우저 뒤로 가기로 돌아온 칸");
  assert.equal(nextDepth(0, 2), 0);
});

test("(←) 윗 화면: 주소를 바로 열어 앱 안 기록이 없을 때만 쓴다", () => {
  const up = (hash: string) => parentOf(parseRoute(hash));
  assert.equal(up("#/migrations/abc"), "migrations");
  assert.equal(up("#/migrations/abc/cost"), "migrations/abc");
  assert.equal(up("#/migrations/new"), "migrations");
  assert.equal(up("#/environments/connect"), "environments");
  assert.equal(up("#/environments/connect/e1"), "environments");
  assert.equal(up("#/environments/e1"), "environments");
  for (const root of ["#/", "#/migrations", "#/environments", "#/settings", "#/audit/abc", "#/agent"]) assert.equal(up(root), null, root);
});

test("(←) 갈 곳: 대시보드는 앞 화면이 있어도 없음, 그 밖은 앞 화면 → 윗 화면 → 없음", () => {
  const at = (hash: string, depth: number) => backTarget(parseRoute(hash), depth);
  assert.equal(at("#/", 3), null);
  assert.equal(at("", 0), null);
  assert.equal(at("#/migrations", 1), "history");
  assert.equal(at("#/migrations", 0), null);
  assert.equal(at("#/migrations/abc", 0), "migrations");
  assert.equal(at("#/migrations/abc", 2), "history");
});
