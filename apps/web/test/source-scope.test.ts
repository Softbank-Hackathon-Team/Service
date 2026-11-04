import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_SCOPE, borrowNote, checkScopeInput, scopeChoices, scopeLabel, scopeSummary, softwareOf, softwareTitle, targetOptions, vendorLine,
} from "../src/features/migration/source";
import type { CloudInventory } from "../src/features/dashboard/model";
import type { EnvApp, EnvironmentView, Provider } from "../src/lib/types";

const env = (id: string, provider: Provider, over: Partial<EnvironmentView> = {}): EnvironmentView => ({
  id, provider, name: `env-${id}`, connectionStatus: "connected", accountId: null, lastVerifiedAt: null, failureReason: null, ...over,
});
const app = (name: string, role: EnvApp["role"], stage: EnvApp["stage"]): EnvApp => ({
  migrationId: `${name}-${role}-${stage}`, role, peer: { envId: "p", name: "peer", provider: "gcp" },
  migrationStatus: "completed", stage, trafficPct: null, spec: { app: name }, resources: [],
});
const cloud = (groups: CloudInventory["groups"], status: CloudInventory["status"] = "ok"): CloudInventory =>
  ({ status, reason: null, source: "cli", region: null, groups });

test("소프트웨어 이름: 지금 이 환경에서 서비스 중인 앱만, 이전 기록 → 네임스페이스 → 클러스터 순", () => {
  const apps = [
    app("shop-api", "source", "undone"),   // 되돌아와서 아직 여기
    app("shop-api", "source", "after"),    // 떠남
    app("old-web", "source", "after"),     // 떠남
    app("billing", "target", "after"),     // 옮겨 옴
    app("demo", "target", "undone"),       // 도착에서 되돌림 = 여기 없음
  ];
  assert.deepEqual(softwareOf("aws", { cloud: cloud([], "unavailable"), apps }), ["shop-api", "billing"]);
  const onprem = cloud([
    { category: "cluster", items: [{ name: "k3d-node-0", status: "Ready" }] },
    { category: "workload", items: [{ name: "shop/web", status: "1/1 준비" }, { name: "shop/api", status: "1/1 준비" }, { name: "pay/api", status: null }] },
  ]);
  assert.deepEqual(softwareOf("onprem", { cloud: onprem, apps: [] }), ["shop", "pay"]);
  // 온프레 클러스터 칸은 노드라 이름으로 쓰지 않는다
  assert.deepEqual(softwareOf("onprem", { cloud: cloud([{ category: "cluster", items: [{ name: "node-1", status: "Ready" }] }]), apps: [] }), []);
  assert.deepEqual(softwareOf("aws", { cloud: cloud([{ category: "cluster", items: [{ name: "shop-eks", status: null }] }]), apps: [] }), ["shop-eks"]);
  assert.deepEqual(softwareOf("aws", null), []);
});

test("소프트웨어 제목: 하나면 그대로, 여럿이면 외 N개, 없으면 null", () => {
  assert.equal(softwareTitle(["shop"]), "shop");
  assert.equal(softwareTitle(["shop", "pay", "web"]), "shop 외 2개");
  assert.equal(softwareTitle([]), null);
  assert.equal(vendorLine("aws"), "AWS EKS");
  assert.equal(vendorLine("onprem"), "온프레 k3s");
});

test("출발 범위 후보: 온프레는 네임스페이스(DB 하나면 함께), 클라우드는 클러스터", () => {
  const onprem = cloud([
    { category: "workload", items: [{ name: "shop/web", status: null }, { name: "shop/api", status: null }, { name: "Bad_NS/x", status: null }] },
    { category: "database", items: [{ name: "shop/shop-db", status: "healthy" }] },
  ]);
  const choices = scopeChoices("onprem", onprem);
  assert.equal(choices.length, 1, "규칙에 안 맞는 네임스페이스는 후보에서 뺀다");
  assert.deepEqual(choices[0]!.scope, { namespaces: ["shop"], database: "shop/shop-db" });
  assert.match(choices[0]!.detail, /Deployment 2개/);

  const aws = cloud([{ category: "cluster", service: "Amazon EKS", items: [{ name: "shop-eks", status: "ACTIVE" }, { name: "--bad", status: null }] }]);
  assert.deepEqual(scopeChoices("aws", aws).map((c) => c.scope), [{ cluster: "shop-eks" }]);
  assert.equal(scopeChoices("aws", aws)[0]!.detail, "Amazon EKS · ACTIVE");
  assert.deepEqual(scopeChoices("aws", null), []);
  assert.deepEqual(AUTO_SCOPE.scope, {});
});

test("직접 적은 범위: 서버 규칙을 먼저 보고, 빈 칸은 자동", () => {
  assert.deepEqual(checkScopeInput({ cluster: " shop-eks ", namespaces: "shop, pay shop", database: "shop-db", appName: "shop" }), {
    scope: { cluster: "shop-eks", namespaces: ["shop", "pay"], database: "shop-db", appName: "shop" }, errors: {},
  });
  assert.deepEqual(checkScopeInput({ cluster: "", namespaces: "", database: "", appName: "" }), { scope: {}, errors: {} });
  const bad = checkScopeInput({ cluster: "--x", namespaces: "Shop", database: "$db", appName: "1shop" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["appName", "cluster", "database", "namespaces"]);
  assert.deepEqual(bad.scope, {});
  const many = Array.from({ length: 11 }, (_, i) => `ns${i}`).join(",");
  assert.ok(checkScopeInput({ cluster: "", namespaces: many, database: "", appName: "" }).errors.namespaces);
});

test("범위 짧은 이름: 가장 좁은 것 하나, 비면 자동으로 고르기", () => {
  assert.equal(scopeLabel({ cluster: "shop-eks", namespaces: ["shop"] }), "shop");
  assert.equal(scopeLabel({ cluster: "shop-eks", database: "shop-db" }), "shop-eks");
  assert.equal(scopeLabel({}), "자동으로 고르기");
});

test("범위 한 줄: 비면 자동으로 고름", () => {
  assert.equal(scopeSummary({}), "자동으로 고름");
  assert.equal(scopeSummary(undefined), "자동으로 고름");
  assert.equal(scopeSummary({ cluster: "shop-eks", namespaces: ["shop"], database: "shop-db" }), "클러스터 shop-eks · 네임스페이스 shop · DB shop-db");
});

test("도착 후보: 연결된 다른 벤더만, 같은 벤더는 따로 돌려준다", () => {
  const source = env("a", "aws");
  const list = [source, env("b", "aws"), env("c", "gcp"), env("d", "onprem", { connectionStatus: "failed" }), env("e", "onprem")];
  const { options, sameVendor } = targetOptions(list, source);
  assert.deepEqual(options.map((e) => e.id), ["c", "e"]);
  assert.deepEqual(sameVendor.map((e) => e.id), ["b"]);
});

test("빌릴 권한 한 줄: GCP 전용 프로젝트가 없거나 권한이 빠지면 경고", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  assert.deepEqual(borrowNote(env("c", "gcp"), now), { text: "마이그레이션 전용 프로젝트가 없어 실행 단계에서 막힐 수 있습니다", warn: true });
  assert.equal(borrowNote(env("c", "gcp", { targetProjectId: "shop-mig" }), now).warn, false);
  assert.equal(borrowNote(env("a", "aws", { missingPermissions: ["eks:ListClusters"] }), now).warn, true);
  assert.deepEqual(borrowNote(env("a", "aws", { lastVerifiedAt: "2026-11-04T11:57:00Z" }), now), { text: "실행 역할 빌릴 수 있음 · 확인 3분 전", warn: false });
  assert.equal(borrowNote(env("a", "aws", { mock: true }), now).text, "흉내 자격으로 확인됨");
});
