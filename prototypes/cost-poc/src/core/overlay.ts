import type { MigrationParamsInput, VendorPricingInput } from "./types.js";

// DRAFT(ai): 보안 프로필을 C_v 바깥의 파라미터로 얹는다. 식은 그대로이고 입력값만 바뀐다.
// 값은 팀 packages/cost/src/profile.ts와 같다: 강화 = DB 이중화(DB 비용 1배 추가) + 위협 탐지 월 $30, 이전 시간 2배. 전부 추정.
export type SecurityLevel = "basic" | "hardened";

export function applySecurityOverlay(p: VendorPricingInput, level: SecurityLevel, threatDetectionMonthlyUsd = 30): VendorPricingInput {
  if (level === "basic") return p;
  const extra = threatDetectionMonthlyUsd / 730;
  return {
    ...p,
    fixedHourly: p.fixedHourly + extra,
    fixedItems: [...(p.fixedItems ?? []), { name: "threat-detection", hourly: extra }],
    dbClasses: (p.dbClasses ?? []).map((d) => ({ ...d, hourly: d.hourly * 2 })),
    // 온프레는 관리형 DB가 없어 복제본을 노드에 하나 더 둔다
    dbReplicasOnNodes: (p.dbReplicasOnNodes ?? 1) + (p.dbOnNodes ? 1 : 0),
  };
}

export function applySecurityToMigration(m: MigrationParamsInput, level: SecurityLevel): MigrationParamsInput {
  if (level === "basic") return m;
  return { ...m, parallelRunDays: (m.parallelRunDays ?? 7) * 2 };
}
