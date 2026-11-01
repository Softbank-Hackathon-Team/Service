// Z70: REPL_* 의 {tf:키} 를 진짜 terraform 출력·비밀번호 파일로 채운다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTfRefs, readTfFacts, replicationFromEnv } from "../src/index.js";

const MID = "4a8c0000-0000-4000-8000-0000000000bb";
function workRoot() {
  const root = mkdtempSync(join(tmpdir(), "z70r-"));
  mkdirSync(join(root, MID));
  writeFileSync(join(root, MID, "outputs.json"), JSON.stringify({ db_address: "shop.rds.example" }));
  writeFileSync(join(root, MID, "db-secret.json"), JSON.stringify({ db_username: "postgres", db_password: "p@ss/word" }));
  return root;
}

test("{tf:키} 가 없으면 env 를 그대로 (파일도 안 읽음)", () => {
  const env = { REPL_TARGET_URL: "postgres://a:b@h/db" };
  assert.equal(resolveTfRefs(env, MID), env);
});

test("URL 안의 값은 퍼센트 인코딩, 다른 값은 그대로. 모르는 키는 남겨 둔다", () => {
  const root = workRoot();
  const env = { TF_WORK_DIR: root,
    REPL_TARGET_URL: "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/shop",
    REPL_TARGET_LABEL: "aws-{tf:db_address}", REPL_TARGET_PEER_URL: "postgres://{tf:nope}@x/db", OTHER: "{tf:db_address}" };
  const out = resolveTfRefs(env, MID);
  assert.equal(out.REPL_TARGET_URL, "postgres://postgres:p%40ss%2Fword@shop.rds.example:5432/shop");
  assert.equal(out.REPL_TARGET_LABEL, "aws-shop.rds.example");
  assert.equal(out.REPL_TARGET_PEER_URL, "postgres://{tf:nope}@x/db");
  assert.equal(out.OTHER, "{tf:db_address}");
  assert.deepEqual(readTfFacts("../bad", { TF_WORK_DIR: root }), {});
});

test("replicationFromEnv 가 이전 id 별로 채운 끝점을 쓴다", () => {
  const root = workRoot();
  const m = replicationFromEnv(MID, { TF_WORK_DIR: root, REPL_SOURCE_URL: "postgres://s/db",
    REPL_TARGET_URL: "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}/shop" });
  assert.ok(m);
  assert.equal(m.cfg.target.adminUrl, "postgres://postgres:p%40ss%2Fword@shop.rds.example/shop");
  assert.equal(m.cfg.source.adminUrl, "postgres://s/db");
});

test("Z89: 회사 폴더(<뿌리>/t-xxxxxxxx/<이전>)의 출력도 읽는다", () => {
  const root = mkdtempSync(join(tmpdir(), "z89r-"));
  mkdirSync(join(root, "t-1a2b3c4d", MID), { recursive: true });
  writeFileSync(join(root, "t-1a2b3c4d", MID, "outputs.json"), JSON.stringify({ db_address: "tenant.rds.example" }));
  assert.equal(readTfFacts(MID, { TF_WORK_DIR: root }).db_address, "tenant.rds.example");
  assert.deepEqual(readTfFacts(MID, { TF_WORK_DIR: join(root, "nope") }), {});
});
