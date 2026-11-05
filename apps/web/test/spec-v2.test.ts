import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accuracyView, boundaryRows, canConfirmSpec, confirmChunks, confirmLabel, firewallDecision, firewallRows, isFirewallBlock, resolveKey, sourceText, specPatchBody, specRowsV2, specV2Of,
  type AppSpecV2, type MigrationSpecViewV2,
} from "../src/features/migration/specV2";
import { createClient } from "../src/lib/http";

// 명세 v2 검토 화면의 판단 (GET /migrations/:id/spec 의 v2 칸 → 검토 줄·근거·경계 밖·정확도)

test("출발 방화벽: 서버가 막을 줄만 보이고, 결정하면 그 자원만 막힘이 풀린다", () => {
  const network = [
    { scope: "namespace", name: "app" },
    { scope: "component", subject: "unread", mode: "mirror", ingress: "unknown" as const, public: null },
    { scope: "component", subject: "sg", mode: "mirror", ingress: [{ from: "10.0.0.0/8", port: 5432 }, { from: "sg:sg-1" }], public: false },
    { scope: "component", subject: "open", mode: "mirror", ingress: [], public: true },
    { scope: "component", subject: "fine", mode: "mirror", ingress: [{ from: "10.0.0.0/8" }], public: true },
  ];
  const base = { schemaVersion: "2" as const, app: { name: "shop" }, components: [], links: [] };
  const rows = firewallRows({ ...base, posture: { network } });
  assert.deepEqual(rows.map((r) => [r.subject, r.reason]), [["unread", "unknown"], ["sg", "uncopyable"], ["open", "publicNoCidr"]]);
  assert.deepEqual(rows[1]!.sources, ["sg:sg-1"]);
  assert.deepEqual(rows[1]!.kept, ["10.0.0.0/8"], "결정해도 남는 주소를 사람에게 보인다");
  assert.deepEqual(rows[0]!.kept, []);

  const unread = firewallDecision({ network, egress: { source: "nat" } } as never, "unread");
  assert.deepEqual(unread.network![1]!.ingress, []);
  assert.equal(unread.network![2], network[2], "다른 자원은 그대로");
  assert.deepEqual((unread as unknown as { egress: unknown }).egress, { source: "nat" }, "다른 칸도 그대로");
  assert.deepEqual(firewallDecision({ network }, "sg").network![2]!.ingress, [{ from: "10.0.0.0/8", port: 5432 }], "CIDR 는 남김");
  assert.equal(firewallDecision({ network }, "open").network![3]!.public, false, "허용 주소 없는 공개는 비공개로");

  let posture: AppSpecV2["posture"] = { network };
  for (const row of firewallRows({ ...base, posture })) posture = firewallDecision(posture, row.subject);
  assert.deepEqual(firewallRows({ ...base, posture }), []);
  assert.equal(firewallRows({ ...base }).length, 0, "posture 없는 명세는 줄 없음");
});

test("출발 방화벽 막힘 문구를 서버 문구로 알아본다 (다른 사람 확인 막힘은 아님)", () => {
  assert.equal(isFirewallBlock("FAIL 사람 확인 필요 — shop-db: 출발 방화벽을 못 읽음 → 의존성만 열지 사람이 정함"), true);
  assert.equal(isFirewallBlock("FAIL 사람 확인 필요 — db: 출발은 공개였는데 허용 주소(CIDR)가 없음 → 도착은 비공개로 두고 사람이 정함"), true);
  assert.equal(isFirewallBlock("FAIL 사람 확인 필요 — cache: 출발 캐시 AUTH 사용 여부를 못 읽음"), false);
});

const spec: AppSpecV2 = {
  schemaVersion: "2", app: { name: "shop" },
  components: [
    { id: "web", kind: "service", props: {
      runtime: "k8s", replicas: { min: 2, max: 4 }, resources: { request: { cpuMilli: 500, memMiB: null } },
      image: { source: "registry", repository: "ghcr.io/x/web", digest: "sha256:abc" },
      env: [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "DB_HOST", fromLink: { to: "db", output: "host" } }],
    } },
    { id: "db", kind: "postgres", props: { majorVersion: null, storageGb: 20 } },
  ],
  links: [{ from: "web", to: "db", intent: "readwrite" }],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], routes: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "web", port: 8080, weight: 1 }] }] }] },
};

const view = (over: Partial<MigrationSpecViewV2> = {}): MigrationSpecViewV2 => ({
  migrationId: "m", version: 3, createdAt: "t", source: "accepted", complete: true, spec: {}, needsReview: [],
  specV2: spec,
  needsReviewV2: ["components.db.majorVersion", "components.web.env.DB_PASSWORD", "check.reviews[0]"],
  fieldMetaV2: {
    "components.db.majorVersion": { source: "rds:db", confidence: 0.6, needs_review: true, rationale: "엔진 버전을 읽지 못함" },
    "components.web.env.DB_PASSWORD": { source: "source.env", confidence: 0.6, needs_review: true, rationale: "평문 비밀로 보임" },
    "check.reviews[0]": { source: "checkV2", confidence: 0.6, needs_review: true, rationale: "실행 방식이 출발과 다릅니다" },
    "components.web.image": { source: "ecs:task-def/web", confidence: 1, needs_review: false },
    "components.web.replicas": { source: "ecs:service/web", confidence: 0.9, needs_review: false, rationale: "단계로 올림" },
  },
  ...over,
});

test("v1 판(specV2 없음)은 v2 줄을 만들지 않는다 → 지금 화면 그대로", () => {
  assert.equal(specV2Of(view({ specV2: undefined })), null);
  assert.deepEqual(specRowsV2(view({ specV2: undefined })), []);
});

test("v2 줄: 검토 칸이 서버 순서대로 먼저, 나머지는 키 순서. null 은 비우고 읽지 못함으로 표시, 기본값을 지어내지 않는다", () => {
  const rows = specRowsV2(view());
  assert.deepEqual(rows.map((row) => row.key), [
    "components.db.majorVersion", "components.web.env.DB_PASSWORD", "check.reviews[0]", "components.web.image", "components.web.replicas",
  ]);
  const db = rows[0]!;
  assert.equal(db.name, "db · 버전");
  assert.equal(db.value, "");
  assert.equal(db.unread, true);
  assert.equal(db.review, true);
  assert.equal(db.provenance, "값을 읽지 못했습니다 · rds:db · 신뢰도 60% · 엔진 버전을 읽지 못함");
});

test("v2 줄: 환경변수 값은 보이지 않고 출처만, 점검 줄은 이유가 곧 내용", () => {
  const rows = specRowsV2(view());
  const env = rows.find((row) => row.key === "components.web.env.DB_PASSWORD")!;
  assert.equal(env.name, "web · 환경변수 DB_PASSWORD");
  assert.doesNotMatch(env.value, /hunter2/);
  assert.equal(env.prose, true);
  assert.equal(env.provenance, "출발 환경변수 · 신뢰도 60% · 평문 비밀로 보임");
  const check = rows.find((row) => row.key === "check.reviews[0]")!;
  assert.equal(check.value, "실행 방식이 출발과 다릅니다");
  assert.equal(check.provenance, "명세 점검 · 신뢰도 60%");     // 이유를 두 번 쓰지 않는다
});

test("v2 줄: 정상 칸(신뢰도 1·검토 아님)은 근거 줄을 붙이지 않는다. 신뢰도가 낮으면 붙인다", () => {
  const rows = specRowsV2(view());
  assert.equal(rows.find((row) => row.key === "components.web.image")!.provenance, null);
  assert.equal(rows.find((row) => row.key === "components.web.image")!.value, "ghcr.io/x/web@sha256:abc");
  const replicas = rows.find((row) => row.key === "components.web.replicas")!;
  assert.equal(replicas.value, "2~4개");
  assert.equal(replicas.provenance, "ECS service/web · 신뢰도 90% · 단계로 올림");
});

test("키 풀기: 연결·진입·자원 요청·모르는 키", () => {
  assert.deepEqual(resolveKey(spec, "links.web->db"), { name: "연결 web → db", value: "읽기·쓰기" });
  assert.deepEqual(resolveKey(spec, "entry.shop.example.com.routes[0]"), { name: "진입 shop.example.com · 경로 1", value: "/ → web:8080" });
  assert.deepEqual(resolveKey(spec, "entry.shop.example.com.hostnames"), { name: "진입 shop.example.com · 호스트 이름", value: "shop.example.com" });
  assert.equal(resolveKey(spec, "components.web.resources").value, "요청 500m · ?MiB");
  assert.equal(resolveKey(spec, "components.web.env.DB_HOST").value, "연결 db.host");
  assert.deepEqual(resolveKey(spec, "components.gone.replicas"), { name: "gone · 복제 수", value: undefined });
  assert.deepEqual(resolveKey(spec, "posture.something"), { name: "posture.something", value: undefined });
  assert.equal(sourceText("human"), "사람이 정함");
  assert.equal(sourceText("k8s:ingress.shop/"), "쿠버네티스 ingress.shop/");
});

test("확인 키는 서버 상한(20개)씩 나눠 보낸다", () => {
  const keys = Array.from({ length: 45 }, (_, i) => `components.c${i}.x`);
  const chunks = confirmChunks(keys);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [20, 20, 5]);
  assert.deepEqual(chunks.flat(), keys);
  assert.deepEqual(confirmChunks([]), []);
  assert.equal(confirmLabel(false, 3), "3칸 확인하고 명세 확정");
  assert.equal(confirmLabel(false, 0), "명세 확정");
  assert.equal(confirmLabel(true, 3), "보내는 중");
});

test("PATCH 본문: AI 초안 판이면 확인·끌어오기·보안·방화벽 어느 것이든 그 판을 받아들인다(acceptDraft)", () => {
  const draft = { version: 4, source: "ai_draft" as const };
  const accepted = { version: 5, source: "accepted" as const };
  // 서버(apps/api spec.ts)는 초안만 있을 때 acceptDraft 가 없으면 409 SPEC_DRAFT_NOT_ACCEPTED
  assert.deepEqual(specPatchBody(draft, { confirm: ["components.web.image"] }), { baseVersion: 4, confirm: ["components.web.image"], acceptDraft: 4 });
  assert.deepEqual(specPatchBody(draft, { include: ["rds:shop-db"] }), { baseVersion: 4, include: ["rds:shop-db"], acceptDraft: 4 });
  assert.deepEqual(specPatchBody(draft, { changes: [{ path: "security", value: null }] }), { baseVersion: 4, changes: [{ path: "security", value: null }], acceptDraft: 4 });
  assert.deepEqual(specPatchBody(draft, { changes: [{ path: "posture", value: { network: [] } }] }).acceptDraft, 4);
  // 받아들인 판에는 싣지 않는다 (옛 초안으로 사람 판을 덮지 않게 서버가 막는 값이라)
  assert.deepEqual(specPatchBody(accepted, { include: ["rds:shop-db"] }), { baseVersion: 5, include: ["rds:shop-db"] });
});

test("명세 확정: 정하지 않은 출발 방화벽 줄이 있으면 막고 이유를 버튼에 쓴다 (확정해도 사전 점검이 되돌려 보냄)", () => {
  assert.equal(canConfirmSpec(0), true);
  assert.equal(canConfirmSpec(2), false);
  assert.equal(confirmLabel(false, 3, 2), "출발 방화벽 2개를 먼저 정해 주세요");
  assert.equal(confirmLabel(false, 0, 0), "명세 확정");
  assert.equal(confirmLabel(true, 3, 2), "보내는 중");
});

test("경계 밖: 칸이 없으면 모름(null), 빈 목록은 없음. 데이터 자원만 끌어올 수 있다", () => {
  assert.equal(boundaryRows(undefined), null);
  assert.deepEqual(boundaryRows([]), []);
  const rows = boundaryRows([
    { resource: "rds:analytics", kind: "postgres", reason: "닿지 않음" },
    { resource: "ecs:cron", kind: "job", reason: "다른 묶음" },
  ])!;
  assert.deepEqual(rows.map((row) => [row.name, row.kind, row.pullable]), [["analytics", "DB", true], ["cron", "예약 잡", false]]);
  assert.equal(rows[0]!.resource, "rds:analytics");     // PATCH include 에는 resource 이름 그대로
});

test("가져오기 정확도: 비교할 칸이 없으면 0% 가 아니라 '비교할 칸 없음', 불일치만 줄로", () => {
  const base = { schemaVersion: "1" as const, basis: "render" as const, total: 4, matched: 2, mismatched: 1, unverifiable: 1, comparable: 3, percent: 66.7 };
  const got = accuracyView({ ...base, fields: [
    { component: "web", field: "replicas", result: "mismatch", detail: "3 · 2" },
    { component: "web", field: "ports", result: "match" },
  ] });
  assert.equal(got.summary, "66.7%");
  assert.equal(got.rows[0]!.value, "도착에 내보낼 값과 비교");
  assert.equal(got.rows[1]!.value, "3칸 · 일치 2 · 불일치 1");
  assert.deepEqual(got.mismatches, [{ name: "web · 복제 수", value: "3 · 2" }]);
  assert.equal(accuracyView({ ...base, comparable: 0, percent: null, basis: "spec", fields: [] }).summary, "비교할 칸 없음");
});

test("PATCH 도 버튼 한 번에 Idempotency-Key 하나, 본문은 JSON", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"version":4}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  let n = 0;
  const c = createClient({ base: "/api", fetch, newKey: () => `k${++n}` });
  assert.deepEqual(await c.patch("/migrations/m/spec", { baseVersion: 3, confirm: ["check.reviews[0]"] }), { version: 4 });
  await c.get("/migrations/m/spec");
  const h = (i: number) => calls[i]!.init.headers as Record<string, string>;
  assert.equal(calls[0]!.init.method, "PATCH");
  assert.equal(h(0)["idempotency-key"], "k1");
  assert.equal(h(0)["content-type"], "application/json");
  assert.equal(calls[0]!.init.body, '{"baseVersion":3,"confirm":["check.reviews[0]"]}');
  assert.equal(h(1)["idempotency-key"], undefined);
});
