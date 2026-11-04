// IR v2 이식성 판정. 순수 함수: 같은 입력이면 같은 결과 (planHash 가 흔들리지 않게)
// v1 과 다른 점: 도착 postgres 컴포넌트가 여럿일 수 있다. env 규칙은 한 번, db 규칙은 컴포넌트마다 돌린다
// db 규칙은 같은 컴포넌트 id 의 출발 DB 와 도착 DB 를 짝짓는다 (한 명세라 출발·도착 컴포넌트 id 가 같다)
import type { EnvFacts, PortabilityResult, PortabilityVerdict } from "@svc/contracts";
import { PORTABILITY_RULES, type PortabilityInput, type PortabilityRule } from "./rules.js";
import { byLevel, tally } from "./evaluate.js";

export interface PortabilityInputV2 extends PortabilityInput {
  // target.db 는 안 쓴다 (env 규칙은 target.db 를 읽지 않는다). 도착 DB 사실은 여기에 컴포넌트별로
  targetDbs: { componentId: string; db: EnvFacts["db"] }[];
  // 출발 DB 사실도 컴포넌트별로. 짝이 없는 도착 컴포넌트는 source.db(대표)를 쓴다
  sourceDbs?: { componentId: string; db: EnvFacts["db"] }[];
}

export type SecurityVerdictV2 = PortabilityVerdict & { componentId: string | null };   // null = 환경 전체
export type PortabilityResultV2 = Omit<PortabilityResult, "items"> & { items: SecurityVerdictV2[] };

export function evaluatePortabilityV2(i: PortabilityInputV2, rules: PortabilityRule[] = PORTABILITY_RULES): PortabilityResultV2 {
  const dbs = [...i.targetDbs].sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));
  const src = new Map((i.sourceDbs ?? []).map((s) => [s.componentId, s.db]));
  const items: SecurityVerdictV2[] = [];
  // 규칙표 순서 → 컴포넌트 id 순서로 넣고, 단계로만 다시 정렬한다
  for (const r of rules) {
    if (r.scope === "env") {
      const hit = r.check(i);
      if (hit) items.push({ ruleId: r.id, title: r.title, ...hit, componentId: null });
      continue;
    }
    // SG-1: IR 컨테이너마다 (입력 순서 = 명세 순서)
    if (r.scope === "workload") {
      for (const w of i.workloads ?? []) {
        const hit = r.check({ ...i, workload: w });
        if (hit) items.push({ ruleId: r.id, title: r.title, ...hit, componentId: w.componentId });
      }
      continue;
    }
    for (const d of dbs) {
      const hit = r.check({ ...i, source: { ...i.source, db: src.get(d.componentId) ?? i.source.db }, target: { ...i.target, db: d.db } });
      if (hit) items.push({ ruleId: r.id, title: r.title, ...hit, componentId: d.componentId });
    }
  }
  return { ...tally(items), items: byLevel(items) };
}
