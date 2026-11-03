// MAPV2: GET /migrations/:id/plan/resources 가 v2 명세(실행 방식)로 이름을 낸다. 순수 함수 (DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { DEMO_INVENTORY_V2, DEMO_SPEC, normalizeV2, serviceMapV2 } from "@svc/adapters";
import { buildPlanResources, PlanResources, type MigrationRow } from "../src/routes/env-inventory.js";

type Raw = Record<string, any>;
const SRC = "55555555-5555-4555-8555-555555555555", DST = "22222222-2222-4222-8222-222222222222";
const v2Of = (p: "aws" | "gcp" | "onprem") => normalizeV2(DEMO_INVENTORY_V2[p]!).result.spec;
const row = (o: Partial<MigrationRow>): MigrationRow => ({
  id: "11111111-1111-4111-8111-111111111111", status: "approved", pausedFrom: null, failedAtStatus: null,
  updatedAt: "2026-11-02T23:00:00.000Z", sourceEnvId: SRC, targetEnvId: DST,
  sourceName: "src", sourceProvider: "aws", targetName: "dst", targetProvider: "aws",
  spec: { ...DEMO_SPEC }, applyEvidence: null, cleanupRemoved: null, reachedPct: null, ...o });
const plan = (from: "aws" | "gcp" | "onprem", to: "aws" | "gcp" | "onprem", spec: unknown, extra: Partial<MigrationRow> = {}) =>
  buildPlanResources(row({ sourceProvider: from, targetProvider: to, specV2: spec, ...extra }));
const w = (r: ReturnType<typeof plan>, id: string) => r.rows.find((x) => x.category === "workload" && x.label.endsWith(`· ${id}`))!;

test("ECS 출발 → ECS 도착: 틀린 EKS·ALB 이름이 없고 ECS·Cloudflare LB 이름", () => {
  const r = plan("aws", "aws", v2Of("aws"));
  assert.equal(r.irVersion, "2"); assert.equal(r.specKnown, true);
  assert.ok(PlanResources.safeParse(r).success, "응답이 strict 스키마를 통과");
  const api = w(r, "shop-api");
  assert.equal(api.source?.service, "Amazon ECS 서비스");
  assert.equal(api.target?.service, "Amazon ECS 서비스 (Fargate)");
  assert.equal(api.runtimeChange ?? null, null);
  assert.ok(api.target!.tfTypes.includes("aws_ecs_service"));
  const cluster = r.rows.find((x) => x.category === "cluster")!;
  assert.equal(cluster.source?.service, "Amazon ECS 클러스터"); assert.equal(cluster.target?.service, "Amazon ECS 클러스터");
  const all = JSON.stringify(r.rows);
  assert.ok(!all.includes("EKS"), "EKS 이름 없음"); assert.ok(!all.includes("Application Load Balancer"));
  const ing = r.rows.find((x) => x.category === "ingress")!;
  assert.match(ing.target!.service, /Cloudflare LB.*풀 2개.*10→50→100/);
  assert.equal(ing.method, "traffic_shift"); assert.match(ing.target!.detail!, /ALB·Cloud Load Balancing 을 안 씀/);
});

test("ECS 출발 → GKE 도착(사람이 runtime 을 k8s 로 바꿈): 이름이 바뀐 쪽 + 실행 방식 바뀜 표시", () => {
  const o: Raw = structuredClone(v2Of("aws"));
  for (const c of o.components) if (c.kind === "service") c.props.runtime = "k8s";
  const r = plan("aws", "gcp", AppSpecV2.parse(o));
  const api = w(r, "shop-api");
  assert.equal(api.source?.service, "Amazon ECS 서비스");
  assert.equal(api.target?.service, "GKE Deployment (Helm)");
  assert.deepEqual(api.runtimeChange, { from: "managedContainer", to: "k8s" });
  assert.match(api.target!.detail!, /실행 방식 바뀜/);
  assert.equal(r.rows.find((x) => x.category === "cluster")!.target?.service, "Google Kubernetes Engine");
});

test("VM 출발 → EC2 도착, GCE 도착 / Cloud Run → Cloud Run", () => {
  const o: Raw = structuredClone(v2Of("aws"));
  for (const c of o.components) if (c.kind === "service") { c.props.origin = { runtime: "vm", product: "ec2" }; c.props.runtime = "vm"; }
  o.components = o.components.filter((c: Raw) => c.id !== "shop-web");
  o.links = o.links.filter((l: Raw) => l.from !== "shop-web" && l.to !== "shop-web");
  o.entry.hosts[0].routes = o.entry.hosts[0].routes.filter((x: Raw) => x.backends.every((b: Raw) => b.to !== "shop-web"));
  const vm = AppSpecV2.parse(o);
  const toAws = plan("aws", "aws", vm);
  assert.equal(w(toAws, "shop-api").source?.service, "Amazon EC2 인스턴스");
  assert.equal(w(toAws, "shop-api").target?.service, "Amazon EC2 인스턴스");
  assert.ok(w(toAws, "shop-api").target!.tfTypes.includes("aws_instance"));
  assert.equal(w(toAws, "shop-api").runtimeChange ?? null, null);
  assert.equal(toAws.rows.find((x) => x.category === "cluster")!.target, null, "VM 은 클러스터 없음");
  assert.equal(w(plan("aws", "gcp", vm), "shop-api").target?.service, "Compute Engine VM");
  const gcp = plan("gcp", "gcp", v2Of("gcp"));
  assert.ok(gcp.rows.some((x) => x.category === "workload" && /Cloud Run 서비스|GKE Deployment/.test(x.target?.service ?? "")));
});

test("k8s 출발 → GKE: 이름은 지금처럼 (k3s Deployment → GKE Deployment), 원점은 cloudflared", () => {
  const r = plan("onprem", "gcp", v2Of("onprem"));
  const api = w(r, "shop-api");
  assert.equal(api.source?.service, "k3s Deployment"); assert.equal(api.target?.service, "GKE Deployment (Helm)");
  assert.equal(api.method, "redeploy"); assert.equal(api.runtimeChange ?? null, null);
  assert.match(r.rows.find((x) => x.category === "ingress")!.target!.detail!, /cloudflared 터널/);
  assert.equal(r.rows.find((x) => x.category === "database")!.method, "logical_replication");
});

test("데이터 자원 줄과 경계 밖 개수 줄", () => {
  const o: Raw = structuredClone(v2Of("aws"));
  o.components.push({ id: "shop-cache", kind: "cache", props: { engine: "redis", version: "7.1", mode: "single", ha: true } });
  o.components.push({ id: "orders", kind: "queue", props: { model: "queue", visibilityTimeoutSec: 30 } });
  const spec = AppSpecV2.safeParse(o);
  const base = spec.success ? spec.data : v2Of("aws");
  const rows = serviceMapV2("aws", "gcp", base, { outOfBoundary: 3 });
  const b = rows.find((x) => x.category === "boundary")!;
  assert.equal(b.label, "경계 밖 자원 3개"); assert.equal(b.method, "out_of_scope"); assert.equal(b.target, null); assert.equal(b.step, null);
  assert.equal(serviceMapV2("aws", "gcp", base).some((x) => x.category === "boundary"), false, "0개면 줄 없음");
  if (spec.success) {
    assert.equal(rows.find((x) => x.category === "cache")!.target?.service, "Memorystore for Redis");
    assert.equal(rows.find((x) => x.category === "cache")!.source?.service, "Amazon ElastiCache");
  }
});

test("v1 판 불변: spec_v2 가 없으면 예전 응답 그대로 (irVersion·runtimeChange 키 없음, ECS 서비스 이름)", () => {
  const r = buildPlanResources(row({ sourceProvider: "aws", targetProvider: "gcp" }));
  assert.equal("irVersion" in r, false);
  assert.ok(r.rows.every((x) => !("runtimeChange" in x)));
  assert.equal(r.rows.find((x) => x.category === "workload")?.source?.service, "Amazon ECS 서비스");
  // spec_v2 모양이 틀려도(손상) v1 로
  assert.equal("irVersion" in buildPlanResources(row({ specV2: { nope: true } })), false);
});
