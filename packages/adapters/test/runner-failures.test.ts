// Z53: 어댑터 실행기 실패 경로 빈 곳. azure-mock-runner.test.ts 는 failOn=apply 와 AZURE_MOCK=0 만 봤다
//   - failOn=destroy (정리 화면 실패 연습용) 결과 모양
//   - 장애 주입은 그 단계만 망가뜨린다 (apply 실패여도 plan·status·destroy 는 정상)
//   - 환경 변수 해석: AZURE_MOCK_FAIL 알 수 없는 값 무시, AZURE_MOCK_LATENCY_MS 이상한 값 → 기본값
//   - 실패 로그에 비밀값 모양이 없다 (감사 기록에 그대로 들어가므로)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, type TargetEnv } from "@svc/contracts";
import { adapterFor, azureRunner, runnerFor, DEMO_INVENTORY } from "../src/index.js";

const spec = AppSpec.parse(adapterFor("aws").normalize(DEMO_INVENTORY.aws).spec);
const t: TargetEnv = { envId: "44444444-4444-4444-8444-444444444444", provider: "azure_mock", region: "default" };

test("장애 주입 destroy: ok:false, 지운 수 0, 실패 로그 1줄", async () => {
  const r = await azureRunner.createAzureMockRunner({ latencyMs: 0, failOn: "destroy" }).destroy(spec, t);
  assert.equal(r.ok, false);
  assert.equal(r.destroyed, 0);
  assert.equal(r.log.length, 1);
  assert.match(r.log[0]!, /Error/);
});

test("장애 주입은 그 단계만: failOn=apply 여도 plan·status·destroy 는 정상", async () => {
  const run = azureRunner.createAzureMockRunner({ latencyMs: 0, failOn: "apply" });
  const p = await run.plan(spec, t);
  assert.ok(p.summary.add > 0);
  assert.equal((await run.status(t)).health, "healthy");
  assert.equal((await run.destroy(spec, t)).ok, true);
});

test("장애 주입은 그 단계만: failOn=destroy 여도 apply 는 성공하고 출력이 있다", async () => {
  const a = await azureRunner.createAzureMockRunner({ latencyMs: 0, failOn: "destroy" }).apply(spec, t);
  assert.equal(a.ok, true);
  assert.ok(Object.keys(a.tfOutputs).length > 0);
});

test("runnerFor 환경 변수: AZURE_MOCK_FAIL=apply/destroy 만 받고, 다른 값은 무시", async () => {
  const env = (fail: string) => ({ AZURE_MOCK_LATENCY_MS: "0", AZURE_MOCK_FAIL: fail });
  assert.equal((await runnerFor("azure_mock", env("apply"))!.apply(spec, t)).ok, false);
  assert.equal((await runnerFor("azure_mock", env("destroy"))!.destroy(spec, t)).ok, false);
  for (const junk of ["1", "APPLY", "yes", ""]) {
    const r = runnerFor("azure_mock", env(junk))!;
    assert.equal((await r.apply(spec, t)).ok, true, `AZURE_MOCK_FAIL=${junk}`);
    assert.equal((await r.destroy(spec, t)).ok, true, `AZURE_MOCK_FAIL=${junk}`);
  }
});

test("runnerFor 환경 변수: AZURE_MOCK_LATENCY_MS 가 숫자가 아니거나 음수면 기본값(300ms)으로 기다린다", async () => {
  // 하한만 본다(상한을 보면 느린 CI 에서 흔들린다). plan = 대기 1번
  for (const bad of ["abc", "-5"]) {
    const p = await runnerFor("azure_mock", { AZURE_MOCK_LATENCY_MS: bad })!.plan(spec, t);
    assert.ok(p.elapsedMs >= azureRunner.DEFAULT_LATENCY_MS - 20, `${bad}: ${p.elapsedMs}ms`);
  }
});

test("실패 로그·자원 ID 에 비밀값 모양이 없다 (감사 기록에 그대로 남는다)", async () => {
  const a = await azureRunner.createAzureMockRunner({ latencyMs: 0, failOn: "apply" }).apply(spec, t);
  const text = JSON.stringify(a);
  assert.doesNotMatch(text, /password|secret=|AKIA[0-9A-Z]{16}|-----BEGIN/i);
});
