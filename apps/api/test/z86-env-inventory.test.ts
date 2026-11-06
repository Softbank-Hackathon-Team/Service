// Z86: GET /environments/:id/resources 의 순수 함수 (DB 없음). 이전 상태 → 출발·도착 자원 상태, 트래픽 %, 응답 스키마
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { DEMO_INVENTORY, DEMO_SPEC, normalizeV2, readInventory, serviceMapV2, stubStatus, type CloudInventory } from "@svc/adapters";
import { buildEnvResources, buildPlanResources, EnvResources, footprintOf, PlanResources, stageOf, targetPct, type MigrationRow } from "../src/routes/env-inventory.js";

const SRC = "55555555-5555-4555-8555-555555555555", DST = "22222222-2222-4222-8222-222222222222";
const SPEC = DEMO_SPEC;
// DB 없는 명세 (postgres 와 그 의존성 뺌)
const NO_DB = { ...DEMO_SPEC, components: DEMO_SPEC.components.filter((c) => c.kind !== "postgres"),
  links: DEMO_SPEC.links.filter((l) => DEMO_SPEC.components.find((c) => c.id === l.to)?.kind !== "postgres") };
const row = (o: Partial<MigrationRow>): MigrationRow => ({
  id: "11111111-1111-4111-8111-111111111111", status: "approved", pausedFrom: null, failedAtStatus: null,
  updatedAt: "2026-10-31T23:00:00.000Z", sourceEnvId: SRC, targetEnvId: DST,
  sourceName: "dev-onprem", sourceProvider: "onprem", targetName: "dev-aws", targetProvider: "aws",
  specV2: SPEC, applyEvidence: null, cleanupRemoved: null, reachedPct: null, ...o });
const NO_CLOUD: CloudInventory = { provider: "aws", status: "unavailable", reason: "확인 불가: aws 명령이 없음", source: "aws-cli",
  scope: null, region: "ap-northeast-2", checkedAt: "2026-10-31T23:00:00.000Z", elapsedMs: 1, groups: [] };
const state = (rs: { type: string; state: string }[], type: string) => rs.find((r) => r.type === type)?.state;

test("이전 전: 도착 자원은 '만들 예정'(어댑터 설계표), 출발은 돌고 있음, 트래픽 출발 100%", () => {
  const t = footprintOf(DST, row({}));
  assert.equal(t.role, "target"); assert.equal(t.stage, "before"); assert.equal(t.trafficPct, 0);
  assert.ok(t.resources.length > 0);
  assert.ok(t.resources.every((r) => r.state === "planned"));
  assert.equal(state(t.resources, "aws_db_instance"), "planned");
  assert.ok(!t.resources.some((r) => r.type.startsWith("data.")), "data 원본은 자원 목록에서 뺀다");
  const s = footprintOf(SRC, row({}));
  assert.equal(s.role, "source"); assert.equal(s.trafficPct, 100);
  assert.equal(state(s.resources, "k8s.deployment"), "running");
  assert.equal(state(s.resources, "cnpg.cluster"), "running");
});

test("만드는 중 → 배포 → 전환: 단계마다 상태가 바뀐다", () => {
  assert.equal(state(footprintOf(DST, row({ status: "provisioning" })).resources, "aws_db_instance"), "creating");
  const dep = footprintOf(DST, row({ status: "deploying", applyEvidence: "terraform" }));
  assert.equal(state(dep.resources, "aws_db_instance"), "running");
  assert.equal(dep.resources.find((r) => r.type === "aws_db_instance")?.evidence, "terraform");
  assert.equal(state(dep.resources, "helm.release"), "creating");
  const sh = footprintOf(DST, row({ status: "shifting", applyEvidence: "stub", reachedPct: 50 }));
  assert.equal(sh.trafficPct, 50); assert.equal(state(sh.resources, "pg.subscription"), "running");
  assert.equal(footprintOf(SRC, row({ status: "shifting", reachedPct: 50 })).trafficPct, 50);
});

test("정리 중: 정리는 출발 앱을 걷지 않는다 → 출발 앱은 트래픽 0 대기(standby), 복제 슬롯만 걷는 중", () => {
  const s = footprintOf(SRC, row({ status: "cleanup" }));
  assert.equal(state(s.resources, "k8s.deployment"), "standby");
  assert.equal(state(s.resources, "pg.replication_slot"), "stopping");
});

test("완료: 출발 앱은 정리가 건드리지 않아 남음(사람이 내림), 출발 DB 는 남김(쓰기 막힘), 복제 객체는 걷음(감사 근거)", () => {
  const r = row({ status: "completed", applyEvidence: "stub", cleanupRemoved: ["slot x"] });
  const s = footprintOf(SRC, r);
  assert.equal(s.stage, "after"); assert.equal(s.trafficPct, 0);
  assert.equal(state(s.resources, "k8s.deployment"), "left");
  assert.equal(s.resources.find((x) => x.type === "k8s.deployment")?.evidence, "discovered");
  assert.equal(state(s.resources, "cnpg.cluster"), "standby");
  assert.equal(state(s.resources, "pg.replication_slot"), "removed");
  const t = footprintOf(DST, r);
  assert.equal(t.trafficPct, 100); assert.equal(state(t.resources, "aws_db_instance"), "running");
});

test("되돌림·취소·실패: 도착 자원은 남음/안 만듦/모름으로 정직하게", () => {
  assert.equal(state(footprintOf(DST, row({ status: "rolled_back", applyEvidence: "stub" })).resources, "aws_db_instance"), "left");
  assert.equal(footprintOf(SRC, row({ status: "rolled_back" })).trafficPct, 100);
  assert.equal(state(footprintOf(DST, row({ status: "cancelled" })).resources, "aws_db_instance"), "none");
  assert.equal(state(footprintOf(DST, row({ status: "failed", failedAtStatus: "provisioning" })).resources, "aws_db_instance"), "unknown");
  assert.equal(stageOf({ status: "failed", pausedFrom: null, failedAtStatus: "provisioning" }), "undone");
  assert.equal(state(footprintOf(DST, row({ status: "failed", failedAtStatus: "syncing", applyEvidence: "stub" })).resources, "aws_db_instance"), "left");
  // paused 는 멈춘 칸 기준
  assert.equal(targetPct(row({ status: "paused", pausedFrom: "shifting", reachedPct: 25 })), 25);
});

test("명세가 없으면(가져오기 전) 자원 목록은 비고 spec 은 null", () => {
  const f = footprintOf(DST, row({ status: "importing", specV2: null }));
  assert.equal(f.spec, null); assert.deepEqual(f.resources, []);
});

test("도착 종류표는 프로바이더별 어댑터를 따른다 (GCP → Cloud SQL)", () => {
  const f = footprintOf(DST, row({ targetProvider: "gcp", status: "syncing", applyEvidence: "stub" }));
  assert.equal(state(f.resources, "google_sql_database_instance"), "running");
  assert.ok(f.resources.find((r) => r.type === "google_sql_database_instance")?.label.includes("Cloud SQL PostgreSQL 16 · 20GB"));
});

test("응답이 strict 스키마를 통과한다 (직렬화 500 없음)", async () => {
  const body = buildEnvResources({ id: DST, name: "dev-aws", provider: "aws" },
    stubStatus({ envId: DST, provider: "aws", region: "default" }),
    [row({ status: "shifting", reachedPct: 30, applyEvidence: "stub" }), row({ id: "22222222-1111-4111-8111-111111111111", status: "completed", cleanupRemoved: [] })],
    NO_CLOUD);
  assert.equal(body.apps.length, 2);
  assert.ok(body.totals.running > 0);
  const a = Fastify({ logger: false });
  a.setValidatorCompiler(validatorCompiler); a.setSerializerCompiler(serializerCompiler);
  a.get("/x", { schema: { response: { 200: EnvResources } } as never }, async () => body as never);
  const r = await a.inject("/x");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().apps[0].trafficPct, 30);
});

// ---- 대응표 (GET /migrations/:id/plan/resources) ----

test("대응표: AWS RDS → GCP Cloud SQL, 방식은 논리 복제·재배포·트래픽 전환", () => {
  const rows = serviceMapV2("aws", "gcp", normalizeV2(DEMO_INVENTORY.aws).result.spec);
  const db = rows.find((r) => r.category === "database")!;
  assert.equal(db.source?.service, "Amazon RDS for PostgreSQL");
  assert.equal(db.target?.service, "Cloud SQL for PostgreSQL");
  assert.equal(db.method, "logical_replication"); assert.equal(db.step, "sync");
  assert.ok(db.target?.tfTypes.includes("google_sql_database_instance"));
  assert.equal(rows.find((r) => r.category === "workload")?.source?.service, "Amazon ECS 서비스");
  assert.equal(rows.find((r) => r.category === "workload")?.method, "redeploy");
  assert.equal(rows.find((r) => r.category === "ingress")?.method, "traffic_shift");
  // 명세에 없는 객체 저장소는 대상 아님
  assert.equal(rows.find((r) => r.category === "storage")?.method, "out_of_scope");
});

test("대응표: 온프레 CNPG → AWS RDS, DB 없는 명세면 DB 줄은 대상 아님", () => {
  assert.equal(serviceMapV2("onprem", "aws", SPEC).find((r) => r.category === "database")?.source?.service, "CloudNativePG (CNPG)");
  assert.equal(serviceMapV2("onprem", "aws", NO_DB).find((r) => r.category === "database")?.method, "out_of_scope");
});

test("대응표 단계 진행: shifting 이면 DB 복제 끝, 트래픽 중, 정리 전", async () => {
  const p = buildPlanResources(row({ status: "shifting", sourceProvider: "aws", targetProvider: "gcp" }));
  const st = (c: string) => p.rows.find((r) => r.category === c)?.stepState;
  assert.equal(st("database"), "done"); assert.equal(st("ingress"), "doing"); assert.equal(st("workload"), "done");
  assert.equal(buildPlanResources(row({ status: "approved" })).rows.find((r) => r.category === "database")?.stepState, "todo");
  assert.equal(buildPlanResources(row({ status: "rolled_back" })).rows.find((r) => r.category === "database")?.stepState, "undone");
  const a = Fastify({ logger: false });
  a.setValidatorCompiler(validatorCompiler); a.setSerializerCompiler(serializerCompiler);
  a.get("/x", { schema: { response: { 200: PlanResources } } as never }, async () => p as never);
  const r = await a.inject("/x");
  assert.equal(r.statusCode, 200, r.body);
});

// ---- 실자원 읽기 (가짜 exec: 이 VM 에는 자격·CLI 가 없다) ----

const fake = (table: Record<string, { code: number; stdout?: string; stderr?: string }>) =>
  async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
    const hit = table[key] ?? { code: 1, stderr: `no fake for ${key}` };
    return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", ms: 1 };
  };

test("실자원: CLI 가 없으면 가짜 값 없이 unavailable", async () => {
  const inv = await readInventory("aws", { exec: fake({ "aws sts get-caller-identity": { code: 127, stderr: "ENOENT" } }), env: {} });
  assert.equal(inv.status, "unavailable"); assert.match(inv.reason ?? "", /aws 명령이 없음/); assert.deepEqual(inv.groups, []);
  const g = await readInventory("gcp", { exec: fake({ "gcloud config get-value": { code: 0, stdout: "(unset)\n" } }), env: {} });
  assert.equal(g.status, "unavailable"); assert.match(g.reason ?? "", /프로젝트/);
  assert.equal((await readInventory("aws", { env: { INVENTORY_CLI: "0" } })).status, "unavailable");
});

test("실자원: AWS 읽기 결과를 서비스별 묶음으로, 하나 실패하면 partial", async () => {
  const inv = await readInventory("aws", { env: { AWS_REGION: "ap-northeast-2" }, exec: fake({
    "aws sts get-caller-identity": { code: 0, stdout: JSON.stringify({ Account: "123456789012" }) },
    "aws eks list-clusters": { code: 0, stdout: JSON.stringify({ clusters: ["finals-eks"] }) },
    "aws rds describe-db-instances": { code: 0, stdout: JSON.stringify({ DBInstances: [{ DBInstanceIdentifier: "shop-db", DBInstanceStatus: "available", Engine: "postgres", EngineVersion: "16.4", DBInstanceClass: "db.t4g.micro", AllocatedStorage: 20 }] }) },
    "aws ec2 describe-vpcs": { code: 0, stdout: JSON.stringify({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16", State: "available", Tags: [{ Key: "Name", Value: "finals" }] }] }) },
    "aws elbv2 describe-load-balancers": { code: 254, stderr: "AccessDenied" },
    "aws ecr describe-repositories": { code: 0, stdout: JSON.stringify({ repositories: [] }) },
  }) });
  assert.equal(inv.status, "partial"); assert.match(inv.scope ?? "", /••••9012/); assert.doesNotMatch(JSON.stringify(inv), /123456789012/);  // R8-46
  const db = inv.groups.find((x) => x.category === "database")!;
  assert.equal(db.service, "Amazon RDS for PostgreSQL");
  assert.deepEqual(db.items[0], { name: "shop-db", status: "available", detail: "postgres · 16.4 · db.t4g.micro · 20GB" });
  assert.equal(inv.groups.find((x) => x.category === "ingress")?.error, "AccessDenied");
});

test("실자원: 온프레 kubectl — CNPG 종류가 없으면 0개(오류 아님)", async () => {
  const inv = await readInventory("onprem", { env: {}, exec: fake({
    "kubectl version --client": { code: 0, stdout: "{}" },
    "kubectl get nodes": { code: 0, stdout: JSON.stringify({ items: [{ metadata: { name: "k3d-onprem-server-0" }, status: { conditions: [{ type: "Ready", status: "True" }], nodeInfo: { kubeletVersion: "v1.31" }, capacity: { cpu: "4" } } }] }) },
    "kubectl get clusters.postgresql.cnpg.io": { code: 1, stderr: "error: the server doesn't have a resource type \"clusters\"" },
    "kubectl get deployments": { code: 0, stdout: JSON.stringify({ items: [] }) },
    "kubectl get services": { code: 0, stdout: JSON.stringify({ items: [] }) },
  }) });
  assert.equal(inv.status, "ok");
  assert.equal(inv.groups.find((g) => g.category === "cluster")?.items[0]?.status, "Ready");
});
