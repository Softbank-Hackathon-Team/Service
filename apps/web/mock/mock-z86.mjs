// Z86: 환경 보기 페이지용 가짜 경로 (mock-api.mjs 가 부른다). 모양은 통합본 API 와 같다
//   GET /environments/:id/inventory     — cloud(실자원) + base(환경 자체) + apps(이전마다 이 환경 쪽 자원)
//   GET /migrations/:id/plan/resources  — 서비스 대응표 (출발 서비스 → 도착 서비스, 방식, 단계)
// apps·대응표 값은 손으로 다시 쓰지 않고, 실제 서버 함수(apps/api/src/routes/env-inventory.ts)로 만든 표(z86-fixture.json.gz)에서 꺼낸다.
//   다시 만들기: parallel/Z86/logs/gen-z86-fixture.ts (출발·도착 12쌍 × 상태 32가지, 명세 = demo-shop + Postgres 16 · 20GB)
// cloud 칸은 모의 API 라 클라우드를 못 읽는다. 기본은 "모의 API 예시"라고 밝힌 예시 값, MOCK_INVENTORY=0 이면 실서버의 "확인 불가"와 같은 모양
// MOCK_SEED=1 이면 온프레 환경(dev-onprem)과 온프레 → AWS 전환 중 이전 1건을 더한다
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

const FX = JSON.parse(gunzipSync(readFileSync(new URL("./z86-fixture.json.gz", import.meta.url))).toString("utf8"));
const ONPREM = { id: "55555555-5555-4555-8555-555555555555", provider: "onprem", name: "dev-onprem", connectionStatus: "connected",
  accountId: null, lastVerifiedAt: null, failureReason: null };

export function seed(migrations, envs, logMove) {
  if (process.env.MOCK_SEED !== "1") return;
  if (!envs.some((e) => e.id === ONPREM.id)) envs.push(ONPREM);
  const aws = envs.find((e) => e.provider === "aws");
  if (!aws) return;
  const m = { id: randomUUID(), status: "shifting", version: 7, sourceEnvId: ONPREM.id, targetEnvId: aws.id,
    updatedAt: new Date(Date.now() - 30_000).toISOString(), failedAtStatus: null, failureCode: null, pausedFrom: null };
  migrations.set(m.id, m); logMove(m, null, "draft"); logMove(m, "draft", "shifting");
}

const now = () => new Date().toISOString();
const it = (name, status, detail) => ({ name, status, detail });
const SAMPLE = {
  aws: { source: "aws-cli", scope: "모의 API 예시 (계정 ••••9012)", region: "ap-northeast-2", groups: [
    ["cluster", "Amazon EKS", [it("finals-eks", "ACTIVE", "1.31 · 노드 2개")]],
    ["database", "Amazon RDS for PostgreSQL", [it("shop-db", "available", "postgres · 16.4 · db.t4g.micro · 20GB")]],
    ["network", "Amazon VPC", [it("finals-vpc", "available", "vpc-0a1b · 10.20.0.0/16")]],
    ["ingress", "Application Load Balancer", [it("shop-alb", "active", "application · internet-facing")]],
    ["registry", "Amazon ECR", [it("platform/1111/shop", null, null)]],
  ] },
  gcp: { source: "gcloud", scope: "모의 API 예시 (프로젝트 finals-demo)", region: "asia-northeast3", groups: [
    ["cluster", "Google Kubernetes Engine", [it("finals-gke", "RUNNING", "asia-northeast3-a · 1.31 · 노드 2개")]],
    ["database", "Cloud SQL for PostgreSQL", []],
    ["network", "VPC 네트워크", [it("default", null, "자동 서브넷")]],
    ["ingress", "Cloud Load Balancing", []],
    ["registry", "Artifact Registry", [it("platform", null, "DOCKER")]],
  ] },
  onprem: { source: "kubectl", scope: "모의 API 예시 (context k3d-onprem)", region: "local", groups: [
    ["cluster", "k3s (온프레)", [it("k3d-onprem-server-0", "Ready", "v1.31 · CPU 4"), it("k3d-onprem-agent-0", "Ready", "v1.31 · CPU 4")]],
    ["database", "CloudNativePG (CNPG)", [it("shop/shop-db", "Cluster in healthy state", "인스턴스 1개 · 20Gi")]],
    ["workload", "k3s Deployment (Helm)", [it("shop/shop-api", "2/2 준비", "ghcr.io/demo/shop-api:1.4.2")]],
    ["ingress", "k8s Service + cloudflared", [it("shop/shop-api", "ClusterIP", "8080")]],
  ] },
};

function cloudOf(env, base) {
  const t0 = Date.now();
  if (env.provider === "azure_mock") {
    const cat = (t) => /kubernetes_cluster/.test(t) ? "cluster" : /container_registry/.test(t) ? "registry" : "network";
    const svc = { cluster: "AKS (Mock)", registry: "Azure Container Registry (Mock)", network: "가상 네트워크 (Mock)" };
    const by = new Map();
    for (const r of base.resources) by.set(cat(r.type), [...(by.get(cat(r.type)) ?? []), it(r.name, r.state, r.type)]);
    return { provider: env.provider, status: "ok", reason: "Mock: 실제 Azure 계정이 아니라 모양만 맞춘 가짜 자원", source: "azure-mock",
      scope: "Mock 구독", region: base.region, checkedAt: now(), elapsedMs: 0,
      groups: [...by].map(([category, items]) => ({ category, service: svc[category], items, error: null })) };
  }
  const s = SAMPLE[env.provider];
  if (!s || process.env.MOCK_INVENTORY === "0")
    return { provider: env.provider, status: "unavailable", reason: "확인 불가: 모의 API 는 클라우드를 읽지 않음 (MOCK_INVENTORY=0)",
      source: "none", scope: null, region: null, checkedAt: now(), elapsedMs: Date.now() - t0, groups: [] };
  return { provider: env.provider, status: "ok", reason: "모의 API 예시 값이야. 실제 값은 실 API(맥 5173)에서 aws·gcloud·kubectl 로 읽어",
    source: s.source, scope: s.scope, region: s.region, checkedAt: now(), elapsedMs: 0,
    groups: s.groups.map(([category, service, items]) => ({ category, service, items, error: null })) };
}

const keyOf = (m, src, dst) => `${src.provider}>${dst.provider}|${m.status}|${m.status === "paused" ? (m.pausedFrom ?? "deploying") : ""}|${m.status === "failed" ? (m.failedAtStatus ?? "provisioning") : ""}`;
function fxOf(m, envs) {
  const src = envs.find((e) => e.id === m.sourceEnvId), dst = envs.find((e) => e.id === m.targetEnvId);
  if (!src || !dst || src.provider === dst.provider) return null;
  // 명세가 생기기 전(draft·importing)은 실서버처럼 자원 목록이 빈다
  const f = FX[keyOf(m, src, dst)] ?? FX[`${src.provider}>${dst.provider}|${m.status}||`];
  return f ? { src, dst, f, specKnown: !["draft", "importing"].includes(m.status) } : null;
}

export function handle(req, p, _body, { migrations, envs, send, err, envStatus }) {
  const res = req._res;
  let r;
  if ((r = p.match(/^\/environments\/([^/]+)\/inventory$/)) && req.method === "GET") {
    const env = envs.find((e) => e.id === r[1]);
    if (!env) return err(res, 404, "NOT_FOUND", "environment " + r[1]), true;
    const base = envStatus(env);
    const apps = [];
    for (const m of [...migrations.values()].reverse()) {
      if (m.sourceEnvId !== env.id && m.targetEnvId !== env.id) continue;
      const x = fxOf(m, envs);
      if (!x) continue;
      const role = m.targetEnvId === env.id ? "target" : "source";
      const side = x.specKnown ? x.f[role] : { stage: x.f[role].stage, trafficPct: x.f[role].trafficPct, spec: null, resources: [] };
      const peer = role === "target" ? x.src : x.dst;
      apps.push({ migrationId: m.id, role, peer: { envId: peer.id, name: peer.name, provider: peer.provider }, migrationStatus: m.status,
        updatedAt: m.updatedAt, ...side });
      if (apps.length >= 20) break;
    }
    const all = apps.flatMap((a) => a.resources);
    const n = (xs) => all.filter((x) => xs.includes(x.state)).length;
    return send(res, 200, { envId: env.id, name: env.name, provider: env.provider, generatedAt: now(), cloud: cloudOf(env, base), base, apps,
      totals: { running: n(["running", "standby"]) + base.resources.filter((x) => x.state === "Succeeded").length,
        changing: n(["creating", "stopping"]), planned: n(["planned"]), gone: n(["removed", "stopped"]) } }), true;
  }
  if ((r = p.match(/^\/migrations\/([^/]+)\/plan\/resources$/)) && req.method === "GET") {
    const m = migrations.get(r[1]);
    if (!m) return err(res, 404, "NOT_FOUND", "migration " + r[1]), true;
    const x = fxOf(m, envs);
    if (!x) return err(res, 404, "NOT_FOUND", "plan resources " + r[1]), true;
    return send(res, 200, { migrationId: m.id, status: m.status,
      source: { envId: x.src.id, name: x.src.name, provider: x.src.provider }, target: { envId: x.dst.id, name: x.dst.name, provider: x.dst.provider },
      specKnown: x.specKnown, rows: x.f.rows }), true;
  }
  return false;
}
