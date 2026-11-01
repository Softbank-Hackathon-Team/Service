import type { Finding, MatrixCell } from "@svc/contracts";
import { z } from "zod";
import { CONTROLS, sourcesFor, type EnvKind } from "./controls.js";

export type Cell = z.infer<typeof MatrixCell>;
export interface Attestation { controlId: string; by: string; at: string }

// DRAFT(ai): 설계 v1 값. 통과 결과는 30분 지나면 믿지 않는다, 사람 확인은 24시간 유효
export const STALE_PASS_MS = 30 * 60_000;
export const ATTEST_VALID_MS = 24 * 60 * 60_000;

const SEV = { info: 1, low: 2, medium: 3, high: 4, critical: 5 } as const;

// 칸(환경 × 통제) 요약. 순수 함수. 규칙: 가장 나쁜 것이 이긴다, 실패는 만료 없음, 오래된 통과는 unknown
export function summarizeCells(
  findings: Finding[],
  o: { envId: string; envKind: EnvKind; now: Date; attestations?: Attestation[] },
): Cell[] {
  const now = o.now.getTime();
  return CONTROLS.map((c): Cell => {
    const srcs = sourcesFor(c, o.envKind);
    const fs = findings.filter((f) => f.controlId === c.id);
    const newest = fs.length ? Math.max(...fs.map((f) => Date.parse(f.observedAt))) : null;
    const worst = fs.reduce<Finding["severity"] | null>(
      (m, f) => (m === null || SEV[f.severity] > SEV[m] ? f.severity : m), null);
    const base = {
      envId: o.envId, controlId: c.id, topSeverity: worst, count: fs.length,
      lastObservedAt: newest === null ? null : new Date(newest).toISOString(),
    };
    if (srcs.length === 0) return { ...base, state: "not_applicable", reason: "이 환경 종류에 결과를 내는 도구가 없음" };
    if (srcs.every((s) => s === "attest")) {
      const a = o.attestations?.find((x) => x.controlId === c.id);
      if (a && now - Date.parse(a.at) < ATTEST_VALID_MS) return { ...base, state: "attested", reason: `사람 확인 ${a.by} ${a.at}` };
      return { ...base, state: "unknown", reason: a ? "사람 확인이 24시간 지남" : "사람 확인 기록 없음" };
    }
    const fails = fs.filter((f) => f.status === "fail").length;
    if (fails > 0) return { ...base, state: "fail", reason: `${fails}건 위반` };
    if (newest === null) return { ...base, state: "unknown", reason: "결과 없음" };
    if (now - newest > STALE_PASS_MS)
      return { ...base, state: "unknown", reason: `마지막 확인 ${Math.round((now - newest) / 60_000)}분 전 (기준 30분)` };
    if (fs.every((f) => f.status === "unknown")) return { ...base, state: "unknown", reason: "도구 오류만 있음" };
    return { ...base, state: "pass", reason: `${fs.length}건 통과` };
  });
}
