// Z81: buildApp(app.ts) 시험. DB 없이 Fastify inject 로 돈다 (pool 은 /readyz 만 쓰고 여기선 안 부른다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
import { API_PREFIX, ROUTE_PLUGINS } from "../src/routes/index.js";

test("buildApp: 진짜 등록 순서로 뜨고(ready) /healthz 가 답한다", async () => {
  const { app } = await buildApp();
  try {
    await app.ready();
    const r = await app.inject({ url: "/healthz" });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });
    // 인증 플러그인이 전체에 걸린다 (fp 로 감싼 효과): 헤더 없는 업무 경로는 401 + 우리 오류 모양
    const u = await app.inject({ url: `${API_PREFIX}/migrations` });
    assert.equal(u.statusCode, 401);
    assert.equal(u.json().code, "UNAUTHENTICATED");
  } finally { await app.close(); }
});

test("경로 목록: routes/*.ts 에서 내보낸 *Routes 는 모두 ROUTE_PLUGINS 에 한 번씩 (빠뜨린 경로 파일 없음)", () => {
  const dir = new URL("../src/routes/", import.meta.url);
  const exported = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .filter((f) => /export async function \w+Routes\(/.test(readFileSync(new URL(f, dir), "utf8")))
    .map((f) => `apps/api/src/routes/${f}`).sort();
  const listed = ROUTE_PLUGINS.map((r) => r.file);
  assert.equal(new Set(listed).size, listed.length, "같은 파일이 두 번");
  assert.deepEqual([...listed].sort(), exported);
});
