import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixCell, Finding } from "@svc/contracts";
import {
  CONTROLS, summarizeCells, stubScanner, checkEquivalence, checkActiveThreat,
  stubRoleIssuer, TempRoleDenied, isExpired,
} from "../src/index.js";

const now = new Date("2026-11-07T01:00:00Z");
const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const M = "44444444-4444-4444-8444-444444444444";

test("STUB 수집기 결과는 Finding 계약을 통과하고 evidence 가 STUB 로 시작한다", async () => {
  for (const p of ["aws", "gcp", "onprem"] as const) {
    const fs = await stubScanner(p).scan({ envId: E, resourcePrefix: p }, now);
    assert.ok(fs.length > 0);
    for (const f of fs) { Finding.parse(f); assert.ok(f.evidence.startsWith("STUB:")); }
  }
});

test("매트릭스: 세 환경 12/12 칸, 빈칸 없음, 계약 통과", async () => {
  for (const p of ["aws", "gcp", "onprem"] as const) {
    const cells = summarizeCells(await stubScanner(p).scan({ envId: E, resourcePrefix: p }, now),
      { envId: E, envKind: p, now, attestations: [{ controlId: "SEC-IAM-01", by: "ops", at: now.toISOString() }] });
    assert.equal(cells.length, CONTROLS.length);
    for (const c of cells) MatrixCell.parse(c);
    assert.ok(cells.every((c) => c.state === "pass" || c.state === "attested"), p);
  }
});

test("매트릭스: 실패가 이기고, 30분 지난 통과는 unknown, Azure Mock 은 전부 적용 안 됨", async () => {
  const fs = await stubScanner("aws", ["SEC-VIO-03"]).scan({ envId: E, resourcePrefix: "aws" }, now);
  const cells = summarizeCells(fs, { envId: E, envKind: "aws", now });
  assert.equal(cells.find((c) => c.controlId === "SEC-VIO-03")!.state, "fail");
  const later = summarizeCells(fs, { envId: E, envKind: "aws", now: new Date(now.getTime() + 31 * 60_000) });
  assert.equal(later.find((c) => c.controlId === "SEC-VIO-01")!.state, "unknown");
  assert.equal(later.find((c) => c.controlId === "SEC-VIO-03")!.state, "fail"); // 실패는 만료 없음
  const az = summarizeCells([], { envId: E, envKind: "azure_mock", now });
  assert.ok(az.every((c) => c.state === "not_applicable"));
});

test("가드레일: 도착에서 나빠지면 이전 일시정지, 같으면 없음, 활성 위협도 멈춤", async () => {
  const src = summarizeCells(await stubScanner("aws").scan({ envId: E, resourcePrefix: "a" }, now), { envId: E, envKind: "aws", now });
  const okDst = summarizeCells(await stubScanner("gcp").scan({ envId: E, resourcePrefix: "g" }, now), { envId: E, envKind: "gcp", now });
  assert.equal(checkEquivalence(M, src, okDst, now), null);
  const badDst = summarizeCells(await stubScanner("gcp", ["SEC-ENC-01", "SEC-VIO-04"]).scan({ envId: E, resourcePrefix: "g" }, now), { envId: E, envKind: "gcp", now });
  const ev = checkEquivalence(M, src, badDst, now)!;
  assert.equal(ev.action, "pause_migration");
  assert.match(ev.evidence, /SEC-ENC-01/);
  assert.equal(checkActiveThreat(M, badDst, now)!.controlId, "SEC-VIO-04");
});

test("임시 역할: 관찰 역할은 읽기만, 와일드카드 거부, 실행 역할은 이전 번호 필수, 1시간 뒤 만료", async () => {
  const iss = stubRoleIssuer(() => "725000000000");
  const ok = await iss.issue({ tenantId: T, envId: E, provider: "aws", purpose: "observe",
    actions: ["ec2:DescribeInstances", "ecs:ListServices", "rds:DescribeDBInstances"], ttlSec: 3600 }, now);
  assert.equal(ok.stub, true);
  assert.equal(ok.roleRef, "arn:aws:iam::725000000000:role/svc-observe");
  assert.equal(isExpired(ok, new Date(now.getTime() + 3600_000)), true);
  const deny = async (r: object, code: string) =>
    assert.rejects(iss.issue({ tenantId: T, envId: E, provider: "aws", ttlSec: 900, ...r } as never, now),
      (e: unknown) => e instanceof TempRoleDenied && e.code === code);
  await deny({ purpose: "observe", actions: ["ec2:TerminateInstances"] }, "ROLE_OBSERVE_WRITE");
  await deny({ purpose: "operate", migrationId: M, actions: ["s3:*"] }, "ROLE_WILDCARD");
  await deny({ purpose: "operate", actions: ["rds:CreateDBInstance"] }, "ROLE_OPERATE_NO_MIGRATION");
  await assert.rejects(iss.issue({ tenantId: T, envId: E, provider: "aws", purpose: "observe", actions: [], ttlSec: 7200 }, now));
});
