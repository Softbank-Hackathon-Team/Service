// IR v2 이식성 판정. 순수 함수: 같은 입력이면 같은 결과 (planHash 가 흔들리지 않게)
// v1 과 다른 점: 도착 postgres 컴포넌트가 여럿일 수 있다. env 규칙은 한 번, db 규칙은 컴포넌트마다 돌린다
// 한계: 출발 DB 사실은 대표 하나(source.db)만 받는다. 출발 DB 가 여럿이면 나머지는 판정에 안 들어간다
import type { EnvFacts, PortabilityResult, PortabilityVerdict } from "@svc/contracts";
import { PORTABILITY_RULES, type PortabilityInput, type PortabilityRule } from "./rules.js";
import { byLevel, tally } from "./evaluate.js";

export interface PortabilityInputV2 extends PortabilityInput {
  // target.db 는 안 쓴다 (env 규칙은 target.db 를 읽지 않는다). 도착 DB 사실은 여기에 컴포넌트별로
  targetDbs: { componentId: string; db: EnvFacts["db"] }[];
}

export type SecurityVerdictV2 = PortabilityVerdict & { componentId: string | null };   // null = 환경 전체
export type PortabilityResultV2 = Omit<PortabilityResult, "items"> & { items: SecurityVerdictV2[] };

export function evaluatePortabilityV2(i: PortabilityInputV2, rules: PortabilityRule[] = PORTABILITY_RULES): PortabilityResultV2 {
  const dbs = [...i.targetDbs].sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));
  const items: SecurityVerdictV2[] = [];
  // 규칙표 순서 → 컴포넌트 id 순서로 넣고, 단계로만 다시 정렬한다
  for (const r of rules) {
    if (r.scope === "env") {
      const hit = r.check(i);
      if (hit) items.push({ ruleId: r.id, title: r.title, ...hit, componentId: null });
      continue;
    }
    for (const d of dbs) {
      const hit = r.check({ ...i, target: { ...i.target, db: d.db } });
      if (hit) items.push({ ruleId: r.id, title: r.title, ...hit, componentId: d.componentId });
    }
  }
  return { ...tally(items), items: byLevel(items) };
}
