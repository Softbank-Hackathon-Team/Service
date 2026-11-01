import { AdapterError } from "./errors.js";

// 필요한 권한은 "모듈이 만들 자원 종류"에서 계산한다 (손으로 쓴 목록은 모듈과 어긋난다).
// read: plan의 새로고침, write: 생성·수정, remove: 되돌리기(destroy)
export type PermRow = { read: string[]; write: string[]; remove: string[] };
export type PermTable = Record<string, PermRow>;
export type Purpose = "plan" | "apply" | "destroy";

export function actionsFor(table: PermTable, resourceTypes: string[], purpose: Purpose): string[] {
  const out = new Set<string>();
  for (const t of resourceTypes) {
    const row = table[t];
    if (!row) throw new AdapterError("PERM_TABLE_MISSING", `권한표에 없는 자원 종류: ${t}`);
    row.read.forEach((a) => out.add(a));
    if (purpose === "apply") row.write.forEach((a) => out.add(a));
    if (purpose === "destroy") row.remove.forEach((a) => out.add(a));
  }
  return [...out].sort();
}

// plan 정책 게이트 보조: plan JSON의 resource_changes[].type 중 어댑터가 약속하지 않은 종류
// (있으면 세션 정책에 권한이 없어 apply 중간에 깨진다 → plan 단계에서 막는다)
export function unexpectedPlanTypes(allowed: string[], planTypes: string[]): string[] {
  const ok = new Set(allowed);
  return [...new Set(planTypes)].filter((t) => !ok.has(t)).sort();
}
