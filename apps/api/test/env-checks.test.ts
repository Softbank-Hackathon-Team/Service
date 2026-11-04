// MACENV (FM-ENV-02·05): tools/env-checks.sh — node 큰 버전·빈 디스크·Docker 점검. 가짜 node·df·docker 를 PATH 앞에 둔다(진짜 Docker·디스크 안 봄)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// fakes: 이름 → 셸 본문. 빈 문자열이면 그 명령은 "있지만 실패"
function run(call: string, fakes: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "env-checks-"));
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const script = `ok() { echo "OK $1 $2"; }; fail() { echo "FAIL $1 $2"; }; warn() { echo "WARN $1 $2"; }; . tools/env-checks.sh; ${call}`;
  return spawnSync("bash", ["-c", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}
// BSD df -Pk 와 같은 모양 (맥: 512 대신 1024-blocks 머리줄)
const df = (availKb: number) => `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/disk1s1 488245288 100 ${availKb} 50% /"`;

test("MACENV node: 22 이상 OK, 20 은 FAIL, 못 읽으면 FAIL", () => {
  assert.match(run("ec_node", { node: "echo 22.11.0" }).stdout, /^OK node-version 22\.11\.0/m);
  assert.match(run("ec_node", { node: "echo 24.1.0" }).stdout, /^OK node-version/m);
  assert.match(run("ec_node", { node: "echo 20.18.1" }).stdout, /^FAIL node-version 20\.18\.1/m);
  assert.match(run("ec_node", { node: "exit 1" }).stdout, /^FAIL node-version/m);
});

test("MACENV disk: BSD df -Pk 4번째 칸으로 판정 (2GB FAIL, 5GB WARN, 50GB OK), 가장 적은 쪽을 본다", () => {
  assert.match(run(`ec_disk "${ROOT}"`, { df: df(2 * 1048576) }).stdout, /^FAIL disk .* 2GB/m);
  assert.match(run(`ec_disk "${ROOT}"`, { df: df(5 * 1048576) }).stdout, /^WARN disk .* 5GB/m);
  assert.match(run(`ec_disk "${ROOT}"`, { df: df(50 * 1048576) }).stdout, /^OK disk 남은 디스크 50GB/m);
  assert.match(run(`ec_disk "${ROOT}"`, { df: "exit 1" }).stdout, /^WARN disk 남은 디스크를 못 읽음/m);
  assert.equal(run(`ec_disk /nonexistent-path-xyz`, { df: df(50 * 1048576) }).stdout.trim(), "WARN disk 남은 디스크를 못 읽음 (df -Pk)");
});

test("MACENV docker: 응답·메모리 8GB OK, 2GB WARN, 꺼짐 WARN (FAIL 아님: DB 가 docker 밖일 수 있다)", () => {
  assert.match(run("ec_docker", { docker: "echo 8589934592" }).stdout, /^OK docker Docker 응답, 메모리 8GB/m);
  assert.match(run("ec_docker", { docker: "echo 2147483648" }).stdout, /^WARN docker Docker 메모리 2048MB/m);
  const off = run("ec_docker", { docker: "echo 'Cannot connect to the Docker daemon' >&2; exit 1" }).stdout;
  assert.match(off, /^WARN docker Docker 가 대답 안 함/m);
  assert.doesNotMatch(off, /^FAIL/m);
});

test("DISPOSABLE (FM-OPS-11): demo-day kv 줄·.env·이어 하는 demo-day.env 가 모두 1 이면 OK, 하나라도 아니면 FAIL", () => {
  const d = mkdtempSync(join(tmpdir(), "disp-"));
  const dd = join(d, "dd.sh"), envf = join(d, ".env"), dde = join(d, "demo-day.env");
  const call = () => `ec_disposable "${dd}" "${envf}" "${dde}"`;
  writeFileSync(dd, `  {\n    kv DB_PUBLIC "1"\n    kv DB_DISPOSABLE "1"\n  }\n`);
  writeFileSync(envf, "DATABASE_URL=postgres://x\n");
  assert.match(run(call(), {}).stdout, /^OK db-disposable/m);
  writeFileSync(dde, "DB_DISPOSABLE='1'\n");
  assert.match(run(call(), {}).stdout, /^OK db-disposable/m);
  writeFileSync(dde, "DB_PUBLIC='1'\n");
  assert.match(run(call(), {}).stdout, /^FAIL db-disposable .*없음/m);
  writeFileSync(dde, "DB_DISPOSABLE='1'\n");
  writeFileSync(envf, "DB_DISPOSABLE=0\n");
  assert.match(run(call(), {}).stdout, /^FAIL db-disposable \.env 의 DB_DISPOSABLE=0/m);
  writeFileSync(envf, "\n");
  writeFileSync(dd, `    kv DB_DISPOSABLE "0"\n`);
  assert.match(run(call(), {}).stdout, /^FAIL db-disposable .*kv DB_DISPOSABLE/m);
});
test("DISPOSABLE: 지금 레포 demo-day.sh 는 kv DB_DISPOSABLE \"1\" 을 쓴다", () => {
  assert.match(run(`ec_disposable tools/demo-day.sh /nonexistent /nonexistent`, {}).stdout, /^OK db-disposable/m);
});
