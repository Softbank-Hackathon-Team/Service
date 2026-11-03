// 이식성 판정. 순수 함수: 같은 입력이면 같은 결과.
// precheck 가 모은 출발·도착 사실과 명세의 요구사항을 받아, 승인 화면에 띄울 판정 목록을 낸다
import type { PortabilityLevel, PortabilityResult, PortabilityVerdict } from "@svc/contracts";
import { PORTABILITY_RULES, type PortabilityInput, type PortabilityRule } from "./rules.js";

// 화면에 무거운 것부터
const ORDER: Record<PortabilityLevel, number> = { block: 0, warn: 1, attest: 2, advise: 3 };

export function evaluatePortability(input: PortabilityInput, rules: PortabilityRule[] = PORTABILITY_RULES): PortabilityResult {
  const items: PortabilityVerdict[] = [];
  for (const r of rules) {
    const hit = r.check(input);
    if (hit) items.push({ ruleId: r.id, title: r.title, ...hit });
  }
  return { ...tally(items), items: byLevel(items) };
}

// 무거운 단계부터. 같은 단계 안은 넣은 순서를 그대로 둔다 (Array.prototype.sort 는 안정 정렬)
export function byLevel<T extends { level: PortabilityLevel }>(items: T[]): T[] {
  return [...items].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

export function tally(items: { level: PortabilityLevel }[]): Omit<PortabilityResult, "items"> {
  const summary = { block: 0, warn: 0, attest: 0, advise: 0 };
  for (const i of items) summary[i.level]++;
  const verdict = summary.block > 0 ? "blocked" : summary.warn + summary.attest > 0 ? "needs_ack" : "clear";
  return { verdict, summary };
}
