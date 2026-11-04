// CL-2·CL-3·CL-4: 계획 전 도착 capability 검사 줄 (warn). 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { DEMO_SPEC } from "../src/index.js";
import { capabilityPlanLines, irDemand, secretStoreName } from "../src/target/capability-checks.js";

const withSvc = (f: (p: any) => void) => {
  const s = structuredClone(DEMO_SPEC) as any;
  for (const c of s.components) if (c.kind === "service") f(c.props);
  return AppSpecV2.parse(s);
};

test("CL-2: HPA 가 있는 명세는 EKS 도착에서만 metrics-server 없음 줄", () => {
  const s = withSvc((p) => { p.replicas = { min: 2, max: 4 }; });
  assert.ok(capabilityPlanLines(s, "aws").some((l) => l.includes("metrics-server")));
  assert.ok(!capabilityPlanLines(s, "gcp").some((l) => l.includes("metrics-server")));
});

test("CL-2 거부: HPA 가 없으면 metrics-server 줄이 없다", () => {
  const s = withSvc((p) => { p.replicas = { min: 2, max: 2 }; delete p.scale; });
  assert.ok(!capabilityPlanLines(s, "aws").some((l) => l.includes("metrics-server")));
});

test("CL-3: IR 요구량이 도착 노드풀을 넘으면 줄, 온프레는 비교 못 함 줄", () => {
  const big = withSvc((p) => { p.replicas = { min: 20, max: 20 }; p.resources = { request: { cpuMilli: 500, memMiB: 512 } }; });
  assert.ok(irDemand(big).pods >= 20);
  assert.ok(capabilityPlanLines(big, "aws").some((l) => l.startsWith("노드 용량: IR 요구량이 도착 노드풀") && l.includes("CPU")));
  assert.ok(capabilityPlanLines(big, "onprem").some((l) => l.includes("비교 못 함")));
});

test("CL-3 거부: 작은 명세는 용량 초과 줄이 없다", () => {
  const small = withSvc((p) => { p.replicas = { min: 1, max: 1 }; p.resources = { request: { cpuMilli: 100, memMiB: 128 } }; });
  assert.ok(!capabilityPlanLines(small, "gcp").some((l) => l.includes("넘음")));
});

test("CL-4: env 출력 secret_store_name 이 있으면 그 이름, 없으면 도착별 기본 + 비밀이 있는 명세엔 warn 줄", () => {
  assert.equal(secretStoreName("aws", { secret_store_name: "tenant-store" }), "tenant-store");
  assert.equal(secretStoreName("gcp", {}), "gcp-secret-manager");
  const s = withSvc((p) => { p.env = [...p.env, { name: "K", fromSecret: { secret: "app-sec", key: "k" } }]; });
  assert.ok(capabilityPlanLines(s, "onprem").some((l) => l.includes('"vault"')));
});

test("CL-4 거부: 비밀을 안 쓰는 명세엔 store 줄이 없다", () => {
  const s = withSvc((p) => { p.env = p.env.filter((e: any) => !("fromSecret" in e)); delete p.envFrom; delete p.secretMounts; });
  for (const c of s.components) if (c.kind === "service" || c.kind === "job") { (c.props as any).env = (c.props as any).env.filter((e: any) => !("fromSecret" in e)); }
  assert.ok(!capabilityPlanLines(AppSpecV2.parse(s), "aws").some((l) => l.startsWith("비밀 저장소")));
});
