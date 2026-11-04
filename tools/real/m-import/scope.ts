// IR-04: api-flow 가 이전 만들 때 넘기는 출발 범위(sourceScope)를 환경변수에서 만든다. 모양은 contracts SourceScope 와 같게(시험이 parse 로 확인)
export function scopeFromEnv(e: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const s: Record<string, unknown> = {};
  const ns = (e.MI_NAMESPACES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ns.length) s.namespaces = ns;
  const one: [string, string][] = [["MI_CLUSTER", "cluster"], ["MI_ECS_CLUSTER", "ecsCluster"], ["MI_DATABASE", "database"], ["MI_PART_OF", "partOf"], ["MI_APP_NAME", "appName"]];
  for (const [k, f] of one) { const v = e[k]?.trim(); if (v) s[f] = v; }
  return Object.keys(s).length ? s : undefined;
}
