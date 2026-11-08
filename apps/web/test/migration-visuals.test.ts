import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecRowV2 } from "../src/features/migration/specV2";
import { flowRows, metricScale, rollbackCause, specCardsV1, specCardsV2, sweepStepMs } from "../src/features/migration/visuals";
import type { ResourceRow } from "../src/lib/resourceMap";
import type { TimelineItem } from "../src/lib/types";

const row = (key: string, name: string, over: Partial<SpecRowV2> = {}): SpecRowV2 => ({ key, name, value: "v", unread: false, review: false, prose: false, provenance: null, ...over });

test("명세 카드: 칸을 요소마다 묶고, 구성요소는 명세 순서, 그 뒤 진입·연결·점검, 카드 안은 확인할 칸이 먼저", () => {
  const spec = { components: [{ id: "web", kind: "service" as const, props: {} }, { id: "db", kind: "postgres" as const, props: {} }] };
  const cards = specCardsV2([
    row("check.db.x.y.z", "명세 점검", { prose: true }),
    row("components.db.engine", "db · 엔진"),
    row("links.web->db", "연결 web → db"),
    row("components.web.image", "web · 이미지"),
    row("components.web.replicas", "web · 복제 수", { review: true }),
    row("entry.shop.example.com.hostnames", "진입 shop.example.com · 호스트 이름"),
  ], spec);
  assert.deepEqual(cards.map((card) => card.id), ["c:web", "c:db", "e:shop.example.com", "links", "check"]);
  const web = cards[0]!;
  assert.equal(web.title, "web");
  assert.equal(web.kind, "서비스");
  assert.equal(web.icon, "box");
  assert.equal(web.review, 1);
  assert.deepEqual(web.rows.map((r) => r.name), ["복제 수", "이미지"], "확인할 칸 먼저, 앞머리(요소 이름)는 뗀다");
  assert.equal(cards[1]!.icon, "database");
  assert.equal(cards[2]!.rows[0]!.name, "호스트 이름");
  assert.equal(cards[3]!.rows[0]!.name, "연결 web → db", "연결은 이름 그대로");
});

test("명세 카드 v1: 경로 맨 앞 칸으로 묶는다", () => {
  const cards = specCardsV1([
    { path: "app.name", name: "앱 이름", value: "shop", review: false },
    { path: "service.image", name: "이미지", value: "x", review: true },
    { path: "service.port", name: "포트", value: "8080", review: false },
    { path: "database", name: "데이터베이스", value: "postgres 16", review: false },
  ]);
  assert.deepEqual(cards.map((card) => [card.id, card.rows.length, card.review]), [["app", 1, 0], ["service", 2, 1], ["database", 1, 0]]);
});

test("확정 채움: 카드가 많으면 한 장을 짧게, 적어도 0.14초·많아야 0.36초", () => {
  assert.equal(sweepStepMs(2), 360);
  assert.equal(sweepStepMs(10), 220);
  assert.equal(sweepStepMs(40), 140);
  assert.equal(sweepStepMs(0), 360);
});

const move = (over: Partial<TimelineItem>): TimelineItem => ({
  seq: 9, at: "2026-11-08T01:02:03Z", kind: "transition", actor: "worker", action: "migration.rolling_back", result: "ok",
  from: "shifting", to: "rolling_back", durationMs: null, failureCode: "TRAFFIC_ERROR_RATE", requestId: null, measurements: [], detail: {}, ...over,
});
const judgement = { stepPct: 50, samples: 1200, targetErrorRatePct: 3.2, sourceErrorRatePct: 0.1, targetP95Ms: 180, sourceP95Ms: 120, verdict: "bad" };

test("롤백 원인: 지표로 되돌렸으면 어디서(그때 상태·비율)와 기준을 넘은 지표, 응답 시간 기준은 출발 × 배수", () => {
  const cause = rollbackCause([move({})], judgement, { errorRatePct: 1, p95Multiplier: 2, windowSec: 60 }, "TRAFFIC_ERROR_RATE");
  assert.equal(cause.by, "auto");
  assert.equal(cause.from, "shifting");
  assert.equal(cause.stepPct, 50);
  assert.deepEqual(cause.metrics.map((m) => [m.id, m.limit, m.over]), [["error", 1, true], ["latency", 240, false]]);
  assert.ok(metricScale(cause.metrics[0]!) > 3.2, "기준선과 막대가 끝에 붙지 않게 넉넉히");
});

test("롤백 원인: 응답 시간을 재지 못한 판정은 오류율만, 사람이 누른 롤백은 지표 없이 사람", () => {
  const noLatency = rollbackCause([move({})], { ...judgement, latencyMeasured: false }, { errorRatePct: 1, p95Multiplier: 2, windowSec: 60 }, "TRAFFIC_ERROR_RATE");
  assert.deepEqual(noLatency.metrics.map((m) => m.id), ["error"]);
  const human = rollbackCause([move({ actor: "api", failureCode: null, from: "rollback_window" })], null, null, null);
  assert.equal(human.by, "human");
  assert.equal(human.from, "rollback_window");
  assert.deepEqual(human.metrics, []);
  assert.equal(rollbackCause([], null, null, null).from, null, "기록이 없으면 모름");
});

const res = (category: ResourceRow["category"], label: string): { key: string; row: ResourceRow } => ({
  key: label, row: { category, label, source: { service: "s", detail: null }, target: { service: "t", detail: null }, method: "create_new", methodLabel: "새로 만듦", step: null, stepState: "todo", afterSource: null },
});

test("자원 대응: 상품 대체는 라벨 끝 구성요소 id 로 그 줄에 붙고, DB 가 하나면 남은 대체를 DB 줄에, 그래도 없으면 끝에 제 줄", () => {
  const listed = [res("cluster", "컨테이너 클러스터"), res("database", "DB"), res("cache", "캐시 · session")];
  const rows = flowRows(listed, [
    { ackId: "substitute:session", resource: "session", from: "ElastiCache (redis)", to: "Memorystore (redis)" },
    { ackId: "substitute:db", resource: "db", from: "RDS for PostgreSQL", to: "Cloud SQL for PostgreSQL" },
    { ackId: "substitute:files", resource: "files", from: "S3", to: "GCS" },
  ]);
  assert.deepEqual(rows.map((r) => [r.key, r.sub?.resource ?? null]), [
    ["컨테이너 클러스터", null], ["DB", "db"], ["캐시 · session", "session"], ["sub:substitute:files", "files"],
  ]);
  assert.equal(rows[3]!.row, null, "짝 없는 대체도 숨기지 않는다");
  // DB 가 여럿이면 라벨에 id 가 붙어 그대로 짝짓는다
  const two = flowRows([res("database", "DB · orders"), res("database", "DB · users")], [{ ackId: "substitute:users", resource: "users" }]);
  assert.deepEqual(two.map((r) => r.sub?.resource ?? null), [null, "users"]);
});
