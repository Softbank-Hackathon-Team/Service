// Z102: REPL_FACTS_FILES 의 사실 파일로 {tf:키} 를 채운다 (이전 폴더 값이 이긴다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTfRefs, readTfFacts } from "../src/index.js";

const MID = "4a8c0000-0000-4000-8000-0000000000cc";

test("사실 파일 값으로 채우고, 이전 폴더 값이 같은 키를 이긴다", () => {
  const root = mkdtempSync(join(tmpdir(), "z102-"));
  mkdirSync(join(root, "t-66666666", MID), { recursive: true });
  writeFileSync(join(root, "t-66666666", MID, "outputs.json"), JSON.stringify({ db_address: "rds.example", onprem_host: "from-dir" }));
  const f = join(root, "onprem.json");
  writeFileSync(f, JSON.stringify({ onprem_user: "post gres", onprem_password: "p@ss/w", onprem_host: "localhost", onprem_port: "55434", n: 3 }));
  const env = { TF_WORK_DIR: root, REPL_FACTS_FILES: ` ${f} , relative.json, /no/such.json`,
    REPL_TARGET_URL: "postgres://{tf:onprem_user}:{tf:onprem_password}@{tf:onprem_host}:{tf:onprem_port}/shop_rev_aws",
    REPL_SOURCE_URL: "postgres://u:p@{tf:db_address}:5432/shop_api" };
  const out = resolveTfRefs(env, MID);
  assert.equal(out.REPL_TARGET_URL, "postgres://post%20gres:p%40ss%2Fw@from-dir:55434/shop_rev_aws");
  assert.equal(out.REPL_SOURCE_URL, "postgres://u:p@rds.example:5432/shop_api");
  assert.equal(readTfFacts(MID, env).n, undefined);
});

test("REPL_FACTS_FILES 가 없으면 예전과 같다", () => {
  const root = mkdtempSync(join(tmpdir(), "z102b-"));
  assert.deepEqual(readTfFacts(MID, { TF_WORK_DIR: root }), {});
  const env = { TF_WORK_DIR: root, REPL_TARGET_URL: "postgres://{tf:onprem_user}@h/db" };
  assert.equal(resolveTfRefs(env, MID).REPL_TARGET_URL, "postgres://{tf:onprem_user}@h/db");
});
