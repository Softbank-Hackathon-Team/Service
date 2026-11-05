// 트래픽 판정 지표 (#245): 클라우드 도착은 cloudflared 파드 안 수집기로 보낸다. 배포 권한에 RBAC·NetworkPolicy 가 없어서다
//   빌더 → 계약(ChartValues) → 차트(ingress.yaml) 를 이어서 본다. helm template 만 쓴다 (클러스터·네트워크 호출 없음)
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
const URL_ = "https://metrics.example.com/v1/metrics";
const T = (provider: "aws" | "gcp" | "onprem", extra: Partial<Target> = {}): Target => ({ envId: "33333333-3333-4333-8333-333333333333", provider, region: "asia-northeast3",
  tenantId: "11111111-1111-4111-8111-111111111111", projectId: "demo-target", accountId: "123456789012", migrationId: MIG, ...extra }) as Target;
const build = (t: Target) => ChartValues.parse(targetBuilderFor(t.provider).toWorkloadValues(DEMO_SPEC, {}, t));
const render = (v: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-")); const f = join(dir, "values.json"); writeFileSync(f, JSON.stringify(v));
  return execFileSync(HELM, ["template", "rel", CHART, "-f", f, "--show-only", "templates/ingress.yaml"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};
const renderErr = (v: unknown) => { try { render(v); return ""; } catch (e: any) { return String(e.stderr ?? e.message); } };
const doc = (out: string, kind: string) => out.split(/^---$/m).find((d) => new RegExp(`^kind: ${kind}$`, "m").test(d)) ?? "";

test("빌더: 주소가 있으면 AWS·GCP 도착에 수집기를 붙이고 토큰 비밀을 만든다", () => {
  for (const p of ["aws", "gcp"] as const) {
    const v = build(T(p, { metricsEndpoint: URL_ }));
    assert.equal(v.ingress?.metrics?.migration, MIG, p);
    assert.equal(v.ingress?.metrics?.env, "target", p);
    assert.equal(v.ingress?.metrics?.sidecar?.endpoint, URL_, p);
    assert.ok(v.externalSecrets?.secrets.some((s) => s.name === "svc-metric-token" && s.keys.includes("token")), p);
    assert.ok(v.warnings?.some((w) => w.includes("지표 토큰")), p);
  }
});

test("기본: 주소가 없으면 수집기도 토큰 비밀도 없다 (지금과 같다)", () => {
  const v = build(T("gcp"));
  assert.equal(v.ingress?.metrics, undefined);
  assert.ok(!v.externalSecrets?.secrets.some((s) => s.name === "svc-metric-token"));
});

test("거부: 이전 번호가 없으면(시험·상태 조회) 안 붙인다, 온프레는 Agent 수집기를 그대로 쓴다", () => {
  assert.equal(build(T("gcp", { metricsEndpoint: URL_, migrationId: undefined })).ingress?.metrics, undefined);
  const onprem = build(T("onprem", { metricsEndpoint: URL_ }));
  assert.equal(onprem.ingress?.metrics?.sidecar, undefined);
  assert.ok(!onprem.externalSecrets?.secrets.some((s) => s.name === "svc-metric-token"));
});

test("거부: 계약이 digest 없는 이미지와 https 아닌 주소를 막는다", () => {
  const v = build(T("gcp", { metricsEndpoint: URL_ }));
  const side = v.ingress!.metrics!.sidecar!;
  const withSide = (s: object) => ({ ...v, ingress: { ...v.ingress, metrics: { ...v.ingress!.metrics, sidecar: { ...side, ...s } } } });
  assert.throws(() => ChartValues.parse(withSide({ image: "otel/collector:latest" })));
  assert.throws(() => ChartValues.parse(withSide({ endpoint: "http://metrics.example.com/v1/metrics" })));
});

test("차트: 수집기는 같은 파드, 지표는 127.0.0.1, NetworkPolicy 없음, 토큰이 없어도 cloudflared 는 뜬다", { skip }, () => {
  const out = render(build(T("gcp", { metricsEndpoint: URL_ })));
  const dep = doc(out, "Deployment");
  assert.match(dep, /"--metrics", "127\.0\.0\.1:2000"/);
  assert.match(dep, /- name: metrics\r?\n\s+image: otel\/opentelemetry-collector-contrib:[^@]+@sha256:/);
  assert.match(dep, /secretName: svc-metric-token, optional: true/);
  assert.match(dep, /readOnlyRootFilesystem: true/);
  assert.equal(doc(out, "NetworkPolicy"), "", "배포 권한에 networkpolicies 가 없다");
  const cm = doc(out, "ConfigMap");
  assert.match(cm, new RegExp(`migration: "${MIG}"`));
  assert.match(cm, /env: "target"/);
  assert.match(cm, /replica: \$\{env:POD_NAME\}/);
  assert.match(cm, /set\(name, "svc_ingress_requests_total"\)/);
  assert.ok(cm.includes(`metrics_endpoint: "${URL_}"`));
});

test("차트: 지표가 없으면 수집기·ConfigMap 이 없고, 온프레 방식은 그대로 NetworkPolicy 를 쓴다", { skip }, () => {
  const plain = render(build(T("gcp")));
  assert.doesNotMatch(plain, /--metrics|name: metrics|kind: ConfigMap/);
  const onprem = render(build(T("onprem")));
  assert.match(onprem, /"--metrics", "0\.0\.0\.0:2000"/);
  assert.notEqual(doc(onprem, "NetworkPolicy"), "");
  assert.equal(doc(onprem, "ConfigMap"), "");
});

test("거부: 차트도 digest 없는 이미지를 그리지 않는다", { skip }, () => {
  const v = build(T("gcp", { metricsEndpoint: URL_ }));
  const bad = { ...v, ingress: { ...v.ingress, metrics: { ...v.ingress!.metrics, sidecar: { ...v.ingress!.metrics!.sidecar!, image: "otel/collector:latest" } } } };
  assert.match(renderErr(bad), /digest 고정/);
});
