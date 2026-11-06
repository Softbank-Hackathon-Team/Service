// 이전 측정 A-B 교차 그래프: 워커 가중치 지표와 대시보드 패널이 같은 이름을 쓴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTrafficWeightMetric, workerRegistry } from "../src/instrument.js";

const M = "4a8c0000-0000-4000-8000-0000000000aa";
const dash = JSON.parse(readFileSync(new URL("../../../deploy/observability/grafana/dashboards/migrations.json", import.meta.url), "utf8"));
type Panel = { id: number; title: string; targets: Array<{ expr: string }> };
const panels = dash.panels as Panel[];

test("가중치 지표: 이전별로 마지막 값을 낸다 (되돌리면 0)", async () => {
  setTrafficWeightMetric(M, 50);
  assert.ok((await workerRegistry.render()).includes(`svc_traffic_weight_pct{migration="${M}"} 50`));
  setTrafficWeightMetric(M, 0);
  const out = await workerRegistry.render();
  assert.ok(out.includes(`svc_traffic_weight_pct{migration="${M}"} 0`));
  assert.ok(out.includes(`svc_traffic_weight_updated_seconds{migration="${M}"} `));
});

test("교차 그래프: 출발은 100 - 도착, 이전을 고를 수 있고 고른 이전만 본다", () => {
  const cross = panels.find((p) => p.title.startsWith("트래픽 교차"))!;
  const [a, b] = cross.targets.map((t) => t.expr);
  assert.equal(a, `100 - ${b}`);
  assert.match(b!, /svc_traffic_weight_pct\{migration=~"\$migration"\}/);
  assert.match(b!, /and \(svc_traffic_weight_updated_seconds/);   // 옛 값을 쥔 워커를 뺀다
  assert.equal(dash.templating.list[0].name, "migration");
});

test("실제 요청 패널: 판정이 읽는 지표 이름을 쓰고, 5xx 를 따로 본다", () => {
  const exprs = panels.find((p) => p.title.startsWith("실제 요청"))!.targets.map((t) => t.expr);
  assert.ok(exprs.every((e) => e.includes("svc_ingress_requests_total")));
  assert.ok(exprs.some((e) => e.includes('code=~"5.."')));
});

test("거부: 옛 패널 번호가 안 바뀐다 (옛 화면이 1~14 를 쓴다), 번호는 겹치지 않는다", () => {
  assert.deepEqual(panels.slice(0, 14).map((p) => p.id), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.equal(new Set(panels.map((p) => p.id)).size, panels.length);
});
