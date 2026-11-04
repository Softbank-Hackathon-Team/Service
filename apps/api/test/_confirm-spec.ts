// 시험 도우미: 사람이 명세 검토를 끝낸 것처럼 PATCH 한다 (명세가 spec_v2 하나가 된 뒤로 가져오기 판엔 사람 몫이 남는다)
//   ① 검토 칸(needsReview) 전부 confirm (안 하면 POST /plan 이 409 GUARD_FAILED)
//   ② 출발 방화벽을 못 읽은 데이터 자원(posture ingress "unknown")은 "안 열림"으로 정함 (안 하면 사전 점검 PC-V2-HUMAN 이 막음)
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

export async function confirmAllReview(app: FastifyInstance, id: string, headers: Record<string, string>, prefix = "") {
  const g = await app.inject({ method: "GET", url: `${prefix}/migrations/${id}/spec`, headers });
  assert.equal(g.statusCode, 200, g.body);
  const v = g.json() as { version: number; needsReview: string[]; spec: { posture?: { network?: Array<Record<string, unknown>> } } };
  const net = v.spec.posture?.network ?? [];
  const unknown = net.some((n) => n.scope === "component" && n.ingress === "unknown");
  if (!v.needsReview.length && !unknown) return;
  const changes = unknown ? [{ path: "posture", value: { ...v.spec.posture,
    network: net.map((n) => n.scope === "component" && n.ingress === "unknown" ? { ...n, ingress: [], public: false } : n) } }] : undefined;
  const r = await app.inject({ method: "PATCH", url: `${prefix}/migrations/${id}/spec`, headers,
    payload: { baseVersion: v.version, ...(v.needsReview.length ? { confirm: v.needsReview } : {}), ...(changes ? { changes } : {}) } });
  assert.equal(r.statusCode, 200, r.body);
}
