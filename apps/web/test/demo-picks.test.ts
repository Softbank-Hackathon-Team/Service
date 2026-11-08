import { test } from "node:test";
import assert from "node:assert/strict";
import { demoPicks, demoRole, isDemoAccount } from "../src/features/migration/source";
import type { EnvironmentView } from "../src/lib/types";

const env = (name: string, provider: EnvironmentView["provider"], connectionStatus: EnvironmentView["connectionStatus"] = "connected") =>
  ({ id: name, name, provider, connectionStatus }) as EnvironmentView;
const ENVS = [
  env("demo1-aws-source", "aws"), env("demo1-gcp-target", "gcp"), env("demo2-aws-source", "aws"), env("demo2-onprem-target", "onprem", "unstable"),
  env("jun-aws-src", "aws"), env("GCP-sample", "gcp"), env("onprem-vm", "onprem"),
];

test("시연 계정: 출발은 시연 AWS 둘, 도착은 시연 GCP·온프레 둘 (온프레 신호가 잠깐 불안정해도 보임)", () => {
  const picks = demoPicks(ENVS, "DHCORJS063@gmail.com ")!;
  assert.deepEqual(picks.sources.map((e) => e.name), ["demo1-aws-source", "demo2-aws-source"]);
  assert.deepEqual(picks.targets(ENVS[0]!).map((e) => e.name), ["demo1-gcp-target", "demo2-onprem-target"]);
});

test("시연 계정이 아니거나 시연 환경이 없으면 규칙을 쓰지 않는다 (예전 목록 그대로)", () => {
  assert.equal(demoPicks(ENVS, "someone@example.com"), null);
  assert.equal(demoPicks(ENVS, null), null);
  assert.equal(demoPicks(ENVS.slice(4), "dhcorjs063@gmail.com"), null);
  assert.equal(isDemoAccount("dhcorjs063@gmail.com"), true);
});

test("시연 환경 쓰임: 이름의 source·target 먼저, 없으면 AWS 는 출발·나머지는 도착", () => {
  assert.equal(demoRole(env("demo1aws", "aws")), "source");
  assert.equal(demoRole(env("demo1gcp", "gcp")), "target");
  assert.equal(demoRole(env("demo2onprem", "onprem")), "target");
  assert.equal(demoRole(env("demo-gcp-source", "gcp")), "source");
  assert.equal(demoRole(env("jun-aws-src", "aws")), null);
});
