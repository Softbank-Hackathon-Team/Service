// Z61: 임시 자격 10분 재발급 (중개자 renew + 주기 장치 startRenewal). 클라우드 호출 없음 (Mock 발급기)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createTempRoleBroker, loadPermissionSet, mockIssuer, memoryLedger, startRenewal, renewIntervalSec, CredRenewFailed,
  VaultMiss, type AuditRecord, type TempCredential,
} from "../src/index.js";

const PERM_DIR = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const M1 = "44444444-4444-4444-8444-444444444444";

function make(o: { fault?: boolean } = {}) {
  let clock = new Date("2026-11-07T01:00:00Z");
  const ledger = memoryLedger({ durable: true });
  const log: AuditRecord[] = [];
  const broker = createTempRoleBroker({
    issuers: { aws: mockIssuer("aws") }, now: () => clock, owner: "worker-a", ledger,
    permissions: loadPermissionSet(PERM_DIR),
    resolveEnv: async (_t, _e, p) => ({ roleRef: `arn:aws:iam::000000000000:role/svc-${p}` }),
    audit: async (_t, a) => { log.push(a); },
    renewFault: () => !!o.fault,
  });
  return { broker, ledger, log, tick: (sec: number) => { clock = new Date(clock.getTime() + sec * 1000); } };
}
const op = { tenantId: T, envId: E, provider: "aws", purpose: "operate", stage: "apply", migrationId: M1,
  actions: ["rds:CreateDBInstance"], ttlSec: 900 };

test("주기: 기본 600초, 수명 2/3(900초 → 600초)를 넘지 못한다, 시험용 짧은 값은 그대로", () => {
  assert.equal(renewIntervalSec(600, 900), 600);
  assert.equal(renewIntervalSec(1200, 900), 600);
  assert.equal(renewIntervalSec(Number("abc"), 900), 600);
  assert.equal(renewIntervalSec(0.05, 900), 0.05);
  assert.equal(renewIntervalSec(600, 3600), 600);
});

test("renew: 10분 뒤 새 참조·새 만료(15분 뒤), 장부가 renewed_from 으로 이어지고 옛 줄은 revoked(renewed), 옛 값은 보관함에서 빠짐", async () => {
  const { broker, ledger, log, tick } = make();
  const c0 = await broker.issue(op, { step: "apply" });
  tick(600);
  const c1 = await broker.renew(c0.credentialRef, T);
  assert.notEqual(c1.credentialRef, c0.credentialRef);
  assert.equal(c1.expiresAt, "2026-11-07T01:25:00.000Z");
  const old = ledger.rows.get(c0.credentialRef)!, neu = ledger.rows.get(c1.credentialRef)!;
  assert.deepEqual([old.status, old.reason], ["revoked", "renewed"]);
  assert.deepEqual([neu.status, neu.renewedFrom, neu.renewSeq, neu.step], ["active", c0.credentialRef, 1, "apply"]);
  assert.throws(() => broker.use(c0.credentialRef, T, M1), VaultMiss);
  assert.equal(broker.use(c1.credentialRef, T, M1).kind, "aws");
  assert.deepEqual(log.slice(-3).map((a) => a.action), ["temp_role.issued", "temp_role.revoked", "temp_role.renewed"]);
  assert.equal(log.at(-1)!.detail!.renewSeq, 1);
  // 두 번째 재발급은 seq 2. 단계 끝 회수 대상은 늘 마지막 1개
  tick(600);
  const c2 = await broker.renew(c1.credentialRef, T);
  assert.equal(ledger.rows.get(c2.credentialRef)!.renewSeq, 2);
  assert.equal(await ledger.activeOperate(T, M1, new Date("2026-11-07T01:21:00Z")), 1);
  assert.doesNotMatch(JSON.stringify(log), /mock-secret|mock-token|ASIAMOCK/);
});

test("renew 실패(발급기 오류 흉내): CredRenewFailed + 감사 renew_failed, 옛 자격은 만료 전까지 그대로", async () => {
  const { broker, log } = make({ fault: true });
  const c0 = await broker.issue(op, { step: "apply" });
  await assert.rejects(broker.renew(c0.credentialRef, T), (e) => e instanceof CredRenewFailed && e.reason === "STUB_RENEW_FAULT");
  assert.equal(log.at(-1)!.action, "temp_role.renew_failed");
  assert.equal(log.at(-1)!.result, "error");
  assert.equal(broker.use(c0.credentialRef, T, M1).kind, "aws");
});

test("renew 거부: 회수 요청이 와 있는 자격은 다시 살리지 않는다, 모르는 참조도 실패", async () => {
  const { broker, ledger } = make();
  const c0 = await broker.issue(op, { step: "apply" });
  await ledger.requestRevoke(T, M1, "emergency", "someone-else");
  await assert.rejects(broker.renew(c0.credentialRef, T), (e) => e instanceof CredRenewFailed && e.reason === "ROLE_RENEW_REVOKE_REQUESTED");
  await assert.rejects(broker.renew("cred/aws/nope", T), (e) => e instanceof CredRenewFailed && e.reason === "ROLE_RENEW_UNKNOWN");
});

const fake = (ref: string) => ({ credentialRef: ref }) as TempCredential;

test("startRenewal: 주기마다 creds 칸을 제자리에서 바꾸고, stop 은 도는 재발급을 기다린다", async () => {
  const creds = [fake("a0")];
  let n = 0;
  const h = startRenewal({ creds, everyMs: 10, renew: async (c) => { await new Promise((r) => setTimeout(r, 5)); return fake(`${c.credentialRef[0]}${++n}`); } });
  // 부하가 큰 기계에서도 흔들리지 않게 시간 대신 "2번 될 때까지"(최대 3초) 기다린다
  for (const t0 = Date.now(); h.renewals() < 2 && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 10));
  await h.stop();
  assert.ok(h.renewals() >= 2, `renewals=${h.renewals()}`);
  assert.equal(creds[0]!.credentialRef, `a${n}`);   // 마지막 재발급까지 배열에 들어갔다 (회수에서 빠지는 자격 없음)
  assert.equal(h.signal.aborted, false);
});

test("startRenewal: 재발급 실패 → signal abort + failed reject, 더는 안 돈다", async () => {
  let calls = 0;
  const keep = setTimeout(() => undefined, 1000);   // 주기 타이머는 unref 라 일(여기선 이 타이머)이 루프를 붙잡아야 한다
  const h = startRenewal({ creds: [fake("a0")], everyMs: 5, renew: async () => { calls++; throw new Error("sts down"); } });
  await assert.rejects(h.failed, /sts down/);
  clearTimeout(keep);
  assert.equal(h.signal.aborted, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  await h.stop();
});

test("startRenewal: 멈출 때 진행 중이던 재발급이 성공하면 creds 에도 들어가고 renewals 에도 센다 (장부 줄 수와 같게)", async () => {
  const keep = setTimeout(() => undefined, 1000);   // 주기 타이머는 unref 라 이 타이머가 루프를 붙잡는다
  const creds = [fake("a0")];
  let started!: () => void;
  const inFlight = new Promise<void>((r) => { started = r; });
  const h = startRenewal({ creds, everyMs: 5, renew: async () => { started(); await new Promise((r) => setTimeout(r, 30)); return fake("a1"); } });
  await inFlight;            // 첫 재발급이 도는 중
  await h.stop();            // 멈춤은 그걸 기다린다
  clearTimeout(keep);
  assert.deepEqual([creds[0]!.credentialRef, h.renewals()], ["a1", 1]);
});
