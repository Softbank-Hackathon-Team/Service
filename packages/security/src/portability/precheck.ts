// 이식성 판정 → 사전 점검 항목. 워커 precheck 가 realPrecheck·v2 점검 뒤에 붙인다
// block 은 명세 검토로 되돌리고, warn 은 계획서 승인 항목(precheck_warn:<id>)이 된다
import type { PortabilityLevel, PrecheckItem } from "@svc/contracts";
import type { PortabilityResultV2, SecurityVerdictV2 } from "./v2.js";

// DRAFT(ai): 단계 대응(attest→warn), 메시지 머리말, 모름 묶기 기준은 보안 영역 초안이다. 팀 검토 전
// attest(고객 선언 요청)는 사전 점검에 따로 단계가 없어 warn 으로 보내고, 승인자가 고객 확인을 받았다고 체크하게 한다
const HEAD: Record<PortabilityLevel, [PrecheckItem["level"], string]> = {
  block: ["block", "FAIL 보안 — "],
  warn: ["warn", "WARN 보안 — "],
  attest: ["warn", "WARN 보안 고객 확인 — "],
  advise: ["info", "INFO 보안 — "],
};
type UnknownSide = "source" | "target";
const SIDE_LABEL: Record<UnknownSide, string> = { source: "출발", target: "도착" };
const where = (v: SecurityVerdictV2) => v.componentId ?? "env";

// 모름(basis unknown) 경고는 쪽마다 한 항목으로 묶는다. 출발 사실을 못 읽으면 승인 체크박스가 열 개 넘게 쌓이기 때문이다
// block·attest 는 묶지 않는다. 하나하나 막거나 고객 선언을 받아야 한다
const collapsible = (v: SecurityVerdictV2): v is SecurityVerdictV2 & { side: UnknownSide } =>
  v.level === "warn" && v.basis === "unknown" && (v.side === "source" || v.side === "target");

export function toSecurityPrecheckItems(r: PortabilityResultV2): PrecheckItem[] {
  // 묶음은 그 쪽의 첫 모름 경고가 있던 자리에 놓는다 (순서가 입력으로만 정해지게)
  const slots: (PrecheckItem | UnknownSide)[] = [];
  const unknown: Record<UnknownSide, SecurityVerdictV2[]> = { source: [], target: [] };
  for (const v of r.items) {
    if (collapsible(v)) {
      if (unknown[v.side].length === 0) slots.push(v.side);
      unknown[v.side].push(v);
      continue;
    }
    const [level, head] = HEAD[v.level];
    slots.push({
      id: `SEC:${v.ruleId}:${where(v)}`, level,
      message: `${head}${v.title}${v.componentId ? ` (${v.componentId})` : ""}. ${v.reason}. 근거: ${v.evidence}`,
      fix: v.recommend,
    });
  }
  return slots.map((s) => (typeof s === "string" ? collapse(s, unknown[s]) : s));
}

function collapse(side: UnknownSide, items: SecurityVerdictV2[]): PrecheckItem {
  return {
    id: `SEC:UNKNOWN:${side}`, level: "warn",
    message: `WARN 보안 — ${SIDE_LABEL[side]} 보안 사실 ${items.length}개를 모른다. 모름은 통과가 아니다. `
      + `규칙: ${items.map((v) => `${v.ruleId}(${where(v)})`).join(", ")}. 근거: ${items.map((v) => v.evidence).join("; ")}`,
    fix: items[0]!.recommend,
  };
}
