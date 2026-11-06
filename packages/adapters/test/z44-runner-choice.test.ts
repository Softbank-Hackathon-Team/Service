import { test } from "node:test";
import assert from "node:assert/strict";
import type { TargetEnv } from "@svc/contracts";
import { oneService } from "./one-service.js";
import {
  adapterFor, aws, chooseRunner, runnerFor, stubStatus, STUB_TF_OUTPUTS, AdapterError, RunnerUnavailable,
  isAdapterError, DEMO_INVENTORY,
} from "../src/index.js";
import { actionsFor } from "../src/common/actions.js";
import { boundedName } from "../src/common/names.js";

// Z44: 실행기/STUB/막힘 판단 한 곳(chooseRunner) + 어댑터 오류 한 종류(AdapterError)
const spec = oneService();   // DB 있는 API 하나 (Azure Mock 은 신원 하나만 그림)

test("chooseRunner: aws·gcp·onprem = stub, azure = runner, AZURE_MOCK=0 = unavailable", () => {
  for (const p of ["aws", "gcp", "onprem"] as const) assert.deepEqual(chooseRunner(p, {}), { kind: "stub", provider: p });
  const az = chooseRunner("azure_mock", {});
  assert.equal(az.kind, "runner");
  const off = chooseRunner("azure_mock", { AZURE_MOCK: "0" });
  assert.equal(off.kind, "unavailable");
  if (off.kind === "unavailable") {
    assert.equal(off.error.code, "AZURE_MOCK_DISABLED");
    assert.ok(off.error instanceof RunnerUnavailable && off.error instanceof AdapterError && off.error instanceof Error);
  }
});

test("runnerFor 는 예전 모양 그대로 (null | 실행기 | throw)", () => {
  assert.equal(runnerFor("gcp", {}), null);
  assert.equal(runnerFor("azure_mock", {})?.provider, "azure_mock");
  assert.throws(() => runnerFor("azure_mock", { AZURE_MOCK: "0" }), (e) => e instanceof RunnerUnavailable);
});

test("STUB 값: 출력 10칸, 상태는 unknown + 받은 region 그대로", () => {
  assert.equal(Object.keys(STUB_TF_OUTPUTS).length, 10);
  assert.ok(Object.isFrozen(STUB_TF_OUTPUTS));
  const s = stubStatus({ envId: "e", provider: "gcp", region: "default" } as TargetEnv, () => new Date(0));
  assert.deepEqual(s, { provider: "gcp", mock: false, envId: "e", region: "default", health: "unknown",
                        checkedAt: "1970-01-01T00:00:00.000Z", resources: [] });
});

test("어댑터 오류는 전부 AdapterError + 코드, 메시지는 예전 글자", () => {
  const cases: Array<[() => unknown, string, RegExp]> = [
    [() => actionsFor({}, ["x"], "apply"), "PERM_TABLE_MISSING", /^권한표에 없는 자원 종류: x$/],
    [() => boundedName({ app: "a", seed: ["s"], max: 3 }), "NAME_SPACE_EXHAUSTED", /^이름 공간 부족: max=3$/],
    [() => adapterFor("aws").imageRef("ghcr.io/x/y:1", { envId: "e", provider: "aws", region: "default" }), "IMAGE_DIGEST_MISSING", /^digest 없는 이미지/],
  ];
  for (const [f, code, msg] of cases)
    assert.throws(f, (e) => isAdapterError(e) && e.code === code && msg.test(e.message), code);
  assert.ok(aws.sessionPolicy({ database: true, secrets: true }, "apply").length <= 2048);
});

test("aws.repoName 은 옮긴 뒤에도 같은 이름으로 보인다", () => {
  assert.equal(aws.repoName("registry/foo/bar@sha256:1"), "bar");
  assert.equal(aws.repoName("bar:1"), "bar");
});
