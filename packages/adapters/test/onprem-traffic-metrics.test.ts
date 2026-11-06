// 트래픽 판정 지표 (#245): 온프레 도착 cloudflared 가 응답 수를 내고, 고객 클러스터 수집기가 그 파드 표시로 긁는다
//   빌더 → 계약(ChartValues) → 차트(ingress.yaml) 를 이어서 본다. helm template 만 쓴다 (클러스터·네트워크 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChartValues } from "@svc/contracts";
import { DEMO_SPEC, targetBuilderFor, type Target } from "../src/index.js";

const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const HELM = process.env.HELM_BIN ?? "helm";
const hasHelm = (() => { try { execFileSync(HELM, ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasHelm ? false : "helm 없음";

const MIG = "22222222-2222-4222-8222-222222222222";
const T = (migrationId?: string): Target => ({ envId: "33333333-3333-4333-8333-333333333333", provider: "onprem", region: "default",
  tenantId: "11111111-1111-4111-8111-111111111111", ...(migrationId ? { migrationId } : {}) }) as Target;
const build = (migrationId?: string) => ChartValues.parse(targetBuilderFor("onprem").toWorkloadValues(DEMO_SPEC, {}, T(migrationId)));
const render = (v: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-")); const f = join(dir, "values.json"); writeFileSync(f, JSON.stringify(v));
  return execFileSync(HELM, ["template", "rel", CHART, "-f", f, "--show-only", "templates/ingress.yaml"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};
const renderErr = (v: unknown) => { try { render(v); return ""; } catch (e: any) { return String(e.stderr ?? e.message); } };
const doc = (out: string, kind: string) => out.split(/^---$/m).find((d) => new RegExp(`^kind: ${kind}$`, "m").test(d)) ?? "";

test("빌더: 온프레 도착 cloudflared 입구는 이전 번호가 있으면 지표 표시(env=target, migration)를 단다", () => {
  const v = build(MIG);
  assert.equal(v.ingress?.mode, "cloudflared");
  assert.deepEqual(v.ingress?.metrics, { migration: MIG, env: "target" });
});

test("빌더: 이전 번호가 없으면(시험·상태 조회) 지표를 켜지 않는다 (migration 라벨 없는 지표는 게이트웨이가 버린다)", () => {
  assert.equal(build().ingress?.metrics, undefined);
});

test("계약: metrics 는 이전 uuid·env(source|target)만, 다른 칸은 거부", () => {
  const v = build(MIG) as any;
  assert.throws(() => ChartValues.parse({ ...v, ingress: { ...v.ingress, metrics: { migration: MIG, env: "both" } } }));
  assert.throws(() => ChartValues.parse({ ...v, ingress: { ...v.ingress, metrics: { migration: "not-a-uuid", env: "target" } } }));
  assert.throws(() => ChartValues.parse({ ...v, ingress: { ...v.ingress, metrics: { migration: MIG, env: "target", token: "x" } } }));
});

test("차트: 지표를 켜면 cloudflared 가 파드 주소 :2000 에 지표를 내고 수집기 표시·주석이 붙는다", { skip }, () => {
  const dep = doc(render(build(MIG)), "Deployment");
  // --metrics 는 tunnel 단계 옵션이라 run 앞에 와야 한다 (cloudflared 2025.9.1 에서 이 순서 확인)
  assert.match(dep, /args: \["tunnel", "--no-autoupdate", "--metrics", "0\.0\.0\.0:2000", "run", "--url", /);
  assert.match(dep, /svc\.platform\/metrics: cloudflared/);
  assert.match(dep, /svc\.platform\/metrics-port: "2000"/);
  assert.match(dep, new RegExp(`svc\\.platform/migration: "${MIG}"`));
  assert.match(dep, /svc\.platform\/env: "target"/);
});

test("차트: :2000 은 수집기 네임스페이스(기본 svc-agent)의 수집기 파드에서만 들어온다", { skip }, () => {
  const np = doc(render(build(MIG)), "NetworkPolicy");
  assert.match(np, /policyTypes: \["Ingress"\]/);
  assert.match(np, /namespaceSelector: \{ matchLabels: \{ kubernetes\.io\/metadata\.name: svc-agent \} \}\n\s+podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/name: svc-metrics \} \}/);
  assert.match(np, /- \{ protocol: TCP, port: 2000 \}/);
  const v = build(MIG) as any;
  const other = doc(render({ ...v, ingress: { ...v.ingress, metrics: { ...v.ingress.metrics, collectorNamespace: "observability" } } }), "NetworkPolicy");
  assert.match(other, /kubernetes\.io\/metadata\.name: observability/);
});

test("차트: 지표를 안 켜면 예전 그대로 (--metrics·표시·NetworkPolicy 없음)", { skip }, () => {
  const out = render(build());
  assert.match(doc(out, "Deployment"), /args: \["tunnel", "--no-autoupdate", "run", "--url", /);
  assert.doesNotMatch(out, /--metrics|svc\.platform\/|kind: NetworkPolicy/);
});

test("차트: 이전 번호·env 모양이 틀리면 렌더가 멈춘다", { skip }, () => {
  const v = build(MIG) as any;
  assert.match(renderErr({ ...v, ingress: { ...v.ingress, metrics: { migration: "x", env: "target" } } }), /이전 uuid/);
  assert.match(renderErr({ ...v, ingress: { ...v.ingress, metrics: { migration: MIG, env: "both" } } }), /source 또는 target/);
});
