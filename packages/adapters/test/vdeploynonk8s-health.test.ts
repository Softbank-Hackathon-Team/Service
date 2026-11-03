// VDEPLOYNONK8S: 재시도 시간 상한·섞인 명세 가정·기본값 (가짜 CLI, 실클라우드 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { checkTerraformRuntime, DEMO_INVENTORY_V2, normalizeV2, stubTfOutputsV2, targetBuilderFor, terraformRuntimeOf, v2Blockers, type Exec } from "../src/index.js";

type Raw = Record<string, any>;
const ecs = () => normalizeV2(DEMO_INVENTORY_V2.aws!).result.spec as AppSpecV2;

test("기본 재시도: 20번, 사이 15초 → 잠은 19번 합 285초. 건강 조회가 모두 즉시 끝난다면 deploy 큐 만료(기본 900초) 안", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const exec: Exec = async () => { calls++; return { code: 0, stdout: JSON.stringify({ services: [] }), stderr: "", ms: 1 }; };
  const r = await checkTerraformRuntime({ provider: "aws", runtime: "managedContainer", spec: ecs(), tfOutputs: stubTfOutputsV2(ecs()), live: true }, { exec, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.ok, false);
  assert.equal(calls, 20);
  assert.deepEqual([sleeps.length, new Set(sleeps).size, sleeps[0]], [19, 1, 15_000]);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 285_000);
  // 최악: ECS 는 시도마다 CLI 1번(20초 제한) → 285 + 20×20 = 685초 < 900초. Cloud Run·GCE 는 서비스마다 1번이라 서비스 3개면 285 + 20×3×20 = 1485초 (전부 느리게 성공할 때만)
  assert.ok(285 + 20 * 20 < 900);
});

test("CLI 가 한 번이라도 던지면 더 안 기다리고 바로 RUNTIME_CHECK_FAILED (시도 번호 기록)", async () => {
  let n = 0; const sleeps: number[] = [];
  const exec: Exec = async () => { n++; return n < 3 ? { code: 0, stdout: JSON.stringify({ services: [] }), stderr: "", ms: 1 } : { code: 1, stdout: "", stderr: "boom", ms: 1 }; };
  const r = await checkTerraformRuntime({ provider: "aws", runtime: "managedContainer", spec: ecs(), tfOutputs: stubTfOutputsV2(ecs()), live: true }, { exec, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(r.ok ? null : [r.code, r.attempts], ["RUNTIME_CHECK_FAILED", 3]);
  assert.equal(sleeps.length, 2);
});

test("섞인 명세(k8s 서비스 + ECS 서비스): terraformRuntimeOf 는 비k8s 라고 답하므로 계획 단계 막힘(v2Blockers)이 반드시 잡아야 한다 — 막힘 확인", () => {
  const o: Raw = structuredClone(ecs());
  const svc = o.components.find((c: Raw) => c.id === "shop-web");
  svc.props.runtime = "k8s"; svc.props.origin = { runtime: "k8s", product: "k8s" };
  const mixed = AppSpecV2.parse(o);
  assert.equal(terraformRuntimeOf(mixed), "managedContainer");
  for (const p of ["aws", "gcp"] as const) {
    const b = v2Blockers(mixed, targetBuilderFor(p).capabilities());
    assert.ok(b.unsupported.length + b.needsHuman.length > 0, `${p}: 섞인 명세가 안 막힘 → 배포 단계가 k8s 서비스를 조용히 건너뜀`);
  }
});

test("k8s 명세는 null: Helm 워크로드가 있으면 gitops 길", () => {
  assert.equal(terraformRuntimeOf(normalizeV2(DEMO_INVENTORY_V2.gcp!).result.spec as AppSpecV2), null);
});
