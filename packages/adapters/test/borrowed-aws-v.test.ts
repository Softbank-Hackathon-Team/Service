// V(L5b): 빌린 AWS 자격 파일 — 경계(공백 있는 경로), 폴더 분리, 갱신 뒤 모드·원자성 흔적
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { borrowedAwsCreds } from "../src/index.js";

const K = { accessKeyId: "ASIAV1", secretAccessKey: "sec-v-do-not-log", sessionToken: "tok-v" };
const AT = new Date("2026-11-03T00:15:00Z");

test("경계: 폴더 경로에 공백이 있어도 credential_process 가 따옴표로 묶여 한 경로로 읽힌다", () => {
  const root = join(mkdtempSync(join(tmpdir(), "v-")), "with space");
  mkdirSync(root);
  const f = borrowedAwsCreds(K, AT, { region: "ap-northeast-2", root });
  try {
    const cfg = readFileSync(f.env.AWS_CONFIG_FILE!, "utf8");
    const line = cfg.split("\n").find((l) => l.startsWith("credential_process"))!;
    assert.match(line, /^credential_process = cat "[^"]*with space[^"]*process\.json"$/);
  } finally { f.dispose(); }
});

test("정상: 안전한 경로는 따옴표 없이 그대로 (기존 모양 불변)", () => {
  const f = borrowedAwsCreds(K, AT, { region: "us-east-1" });
  try {
    assert.match(readFileSync(f.env.AWS_CONFIG_FILE!, "utf8"), /credential_process = cat \S+process\.json\n/);
    assert.ok(!readFileSync(f.env.AWS_CONFIG_FILE!, "utf8").includes('"'));
  } finally { f.dispose(); }
});

test("동시에 두 단계: 폴더·자격 파일이 서로 달라 한쪽 dispose 가 다른 쪽에 영향 없음", () => {
  const a = borrowedAwsCreds(K, AT, { region: "us-east-1" });
  const b = borrowedAwsCreds({ ...K, accessKeyId: "ASIAV2" }, AT, { region: "us-east-1" });
  assert.notEqual(a.dir, b.dir);
  a.dispose();
  assert.equal(JSON.parse(readFileSync(join(b.dir, "process.json"), "utf8")).AccessKeyId, "ASIAV2");
  b.dispose();
});

test("갱신을 여러 번 해도 파일 모드 0600 유지, 임시 파일(.tmp) 안 남고 마지막 값만", () => {
  const f = borrowedAwsCreds(K, AT, { region: "us-east-1" });
  try {
    for (let i = 2; i <= 6; i++)
      f.update({ accessKeyId: `ASIAV${i}`, secretAccessKey: `s${i}`, sessionToken: `t${i}` }, new Date(AT.getTime() + i * 600_000));
    const pj = join(f.dir, "process.json");
    assert.equal(statSync(pj).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(pj, "utf8")).AccessKeyId, "ASIAV6");
    assert.deepEqual(readdirSync(f.dir).sort(), ["config", "credentials", "process.json"]);
  } finally { f.dispose(); }
});

test("거부: dispose 를 두 번 불러도 던지지 않는다 (단계 끝 정리가 겹쳐도 안전)", () => {
  const f = borrowedAwsCreds(K, AT, { region: "us-east-1" });
  f.dispose();
  assert.doesNotThrow(() => f.dispose());
});
