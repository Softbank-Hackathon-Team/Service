import { GuardrailEvent } from "@svc/contracts";
import { z } from "zod";
import type { Cell } from "./summarize.js";

export type Guardrail = z.infer<typeof GuardrailEvent>;
const OK = new Set(["pass", "attested"]);

// 이전 전후 비교 (MG-2-07). 4번이 "자원 만든 뒤", "컷오버 전" 두 시점에 부른다. 순수 함수.
// 출발에서 OK(pass, attested)였던 통제가 도착에서 OK가 아니면 회귀다. unknown 도 회귀로 본다.
// 출발에서 이미 나쁘던 통제는 이전 탓이 아니므로 막지 않는다.
export function checkEquivalence(
  migrationId: string, source: Cell[], target: Cell[], now: Date,
): Guardrail | null {
  const regressed = source
    .filter((s) => OK.has(s.state))
    .filter((s) => {
      const t = target.find((x) => x.controlId === s.controlId);
      return !t || (t.state !== "not_applicable" && !OK.has(t.state));
    })
    .map((s) => s.controlId);
  if (regressed.length === 0) return null;
  return GuardrailEvent.parse({
    migrationId, ruleId: "MG-2-07", controlId: null, action: "pause_migration",
    evidence: `도착 환경에서 나빠진 통제: ${regressed.join(", ")}`, at: now.toISOString(),
  });
}

// 활성 위협 (SEC-VIO-04). 이전 중 도착 환경에 활성 위협이 있으면 멈춘다
// TODO(human): 위협 가드레일의 규칙 번호와 동작(pause vs warn)은 보안 담당 MG 목록과 합쳐서 정한다. 지금은 임시 번호
export function checkActiveThreat(migrationId: string, target: Cell[], now: Date): Guardrail | null {
  const c = target.find((x) => x.controlId === "SEC-VIO-04");
  if (!c || c.state !== "fail") return null;
  return GuardrailEvent.parse({
    migrationId, ruleId: "MG-DRAFT-THREAT", controlId: "SEC-VIO-04", action: "pause_migration",
    evidence: `도착 환경 활성 위협 ${c.count}건 (${c.reason})`, at: now.toISOString(),
  });
}
