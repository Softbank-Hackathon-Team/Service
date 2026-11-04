// RV-01: tools/up-preflight.sh 의 REAL_STS 점검이 워커 규칙(비움·1 = 진짜 발급기, 0 만 흉내)과 같은 판정을 하는지.
//   그 두 줄(rsts=…, 판정)만 떼어 ok/warn 흉내 함수와 같이 sh 로 돌린다. 스크립트 전체는 클라우드·DB 를 보므로 안 돌림
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("../../../tools/up-preflight.sh", import.meta.url), "utf8").split("\n");
const i = src.findIndex((l) => l.startsWith("rsts="));
const snippet = ["ok() { echo \"OK $*\"; }", "warn() { echo \"WARN $*\"; }", src[i]!, src[i + 1]!].join("\n");

function run(envLine: string | null, envVar?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rv01-"));
  if (envLine !== null) writeFileSync(join(dir, ".env"), `${envLine}\n`);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(envVar !== undefined ? { REAL_STS: envVar } : {}) };
  return execFileSync("sh", ["-c", snippet], { cwd: dir, env, encoding: "utf8" }).trim();
}

test("RV-01 REAL_STS 비움·1 은 진짜 발급기로 OK", () => {
  assert.match(run("REAL_STS="), /^OK real-sts/);
  assert.match(run("REAL_STS=1"), /^OK real-sts/);
  assert.match(run(null), /^OK real-sts/);
});

test("RV-01 REAL_STS=0 이면 흉내 발급기라 경고 (.env·환경변수 둘 다)", () => {
  assert.match(run("REAL_STS=0"), /^WARN real-sts .*REAL_STS=0/);
  assert.match(run("REAL_STS=1", "0"), /^WARN real-sts/);
  assert.match(run("REAL_STS=\"0\""), /^WARN real-sts/);
});
