import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TempRoleDenied } from "./temp-role.js";

// infra/permissions/ 의 최소 권한 파일(어댑터 export-permissions 스크립트가 만든 것)을 읽어
// "역할이 가질 수 있는 최대 권한(천장)"과 "단계별 세션 정책"으로 쓴다. 파일을 다시 손으로 쓰지 않는다.
//   AWS: aws-operate-role-policy.json = 고객 계정 실행 역할에 붙는 천장, aws-session-policy-{plan,apply,destroy}.json = 호출마다 좁히는 세션 정책
//   GCP: gcp-operate-custom-role.yaml includedPermissions = 테넌트 SA 커스텀 역할 (GCP 는 호출별 세션 정책이 없다)
//   온프레: onprem-operate-clusterrole.yaml rules → "group/resource:verb"
export type Stage = "plan" | "apply" | "destroy";
export interface PermissionSet {
  aws: { ceiling: string[]; sessionPolicies: Record<Stage, string> };
  gcp: { ceiling: string[] };
  onprem: { ceiling: string[] };
}

interface PolicyDoc { Version: string; Statement: Array<{ Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown; NotAction?: unknown; NotResource?: unknown }> }

export function actionsOfPolicy(doc: PolicyDoc): string[] {
  // Z47: Allow + NotAction/NotResource 는 "이것 빼고 전부"라 동작 목록으로 셀 수 없다 (와일드카드 검사를 빠져나간다).
  //   Action 이 없는 Allow 도 같은 이유로 거부. 레포 파일은 lint 시험이 막지만, PERMISSIONS_DIR 로 다른 폴더를 줄 수 있어 실행 시점에도 본다
  for (const s of doc.Statement)
    if (s.Effect === "Allow" && (s.NotAction !== undefined || s.NotResource !== undefined || s.Action === undefined))
      throw new TempRoleDenied("ROLE_POLICY_SHAPE", "Allow 문에 NotAction·NotResource 또는 Action 없음: 동작 목록으로 셀 수 없는 정책");
  return [...new Set(doc.Statement.filter((s) => s.Effect === "Allow")
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])))].sort();
}

// 의존성 없이 G 가 만든 두 YAML 모양만 읽는다 (일반 YAML 파서가 아니다)
export function parseGcpCustomRole(yaml: string): string[] {
  const out: string[] = []; let inList = false;
  for (const line of yaml.split("\n")) {
    if (/^includedPermissions:/.test(line)) { inList = true; continue; }
    if (inList) { const m = line.match(/^\s*-\s+(\S+)/); if (m) out.push(m[1]!); else if (/^\S/.test(line)) inList = false; }
  }
  return out.sort();
}
export function parseClusterRole(yaml: string): string[] {
  const out: string[] = [];
  const arr = (s: string) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  let groups: string[] = [], resources: string[] = [];
  for (const line of yaml.split("\n")) {
    const g = line.match(/apiGroups:\s*\[(.*)\]/); if (g) groups = arr(g[1]!);
    const r = line.match(/resources:\s*\[(.*)\]/); if (r) resources = arr(r[1]!);
    const v = line.match(/verbs:\s*\[(.*)\]/);
    if (v) for (const grp of groups) for (const res of resources) for (const verb of arr(v[1]!))
      out.push(`${grp === "" ? "core" : grp}/${res}:${verb}`);
  }
  return out.sort();
}

export function loadPermissionSet(dir: string): PermissionSet {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const compact = (f: string) => JSON.stringify(JSON.parse(read(f)));
  return {
    aws: {
      ceiling: actionsOfPolicy(JSON.parse(read("aws-operate-role-policy.json")) as PolicyDoc),
      sessionPolicies: { plan: compact("aws-session-policy-plan.json"), apply: compact("aws-session-policy-apply.json"), destroy: compact("aws-session-policy-destroy.json") },
    },
    gcp: { ceiling: parseGcpCustomRole(read("gcp-operate-custom-role.yaml")) },
    onprem: { ceiling: parseClusterRole(read("onprem-operate-clusterrole.yaml")) },
  };
}

// 【사실】 AWS STS AssumeRole 의 인라인 세션 정책은 평문 2,048자 이하 (AWS IAM 문서 "Session policies")
export const AWS_SESSION_POLICY_MAX = 2048;

// 세션 정책 검사: 크기, 와일드카드 동작 금지, 천장 밖 동작 금지.
// 세션 정책은 역할 권한과의 교집합이라 천장 밖 동작은 어차피 안 먹지만, 넘치는 요청은 설계 실수라 미리 막는다
export function checkSessionPolicy(policy: string, ceiling: string[]): string[] {
  // 길이는 실제로 보내는 판(compactSessionPolicy)으로 본다
  const wire = compactSessionPolicy(policy, ceiling);
  if (wire.length > AWS_SESSION_POLICY_MAX)
    throw new TempRoleDenied("ROLE_POLICY_TOO_LARGE", `세션 정책 ${wire.length}자 > ${AWS_SESSION_POLICY_MAX}. 관리형 정책 ARN(PolicyArns)으로 나눠야 한다`);
  const actions = actionsOfPolicy(JSON.parse(policy) as PolicyDoc);
  const wild = actions.filter((a) => a.includes("*"));
  if (wild.length) throw new TempRoleDenied("ROLE_WILDCARD", `세션 정책에 와일드카드: ${wild.join(", ")}`);
  const outside = actions.filter((a) => !ceiling.includes(a));
  if (outside.length) throw new TempRoleDenied("ROLE_OUTSIDE_CEILING", `실행 역할 천장 밖 동작: ${outside.join(", ")}`);
  return actions;
}

// 요청 동작이 천장 안인지 (GCP·온프레는 호출별로 좁힐 수 없어서 요청 단계에서만 거른다)
export function checkWithinCeiling(actions: string[], ceiling: string[]): void {
  const outside = actions.filter((a) => !ceiling.includes(a));
  if (outside.length) throw new TempRoleDenied("ROLE_OUTSIDE_CEILING", `역할 천장 밖 동작: ${outside.join(", ")}`);
}

// 세션 정책 줄이기 (AWS AssumeRole Policy 2,048자 상한). 파일은 동작을 하나하나 적고(장부·감사·시험), 보낼 때만 이걸로 줄인다.
// 규칙: "서비스:앞글자*" 로 묶되, 천장(실행 역할 정책) 동작 중 그 패턴에 걸리는 것이 전부 원래 목록 안에 있을 때만 묶는다.
//   실제 권한 = 세션 정책 ∩ 역할 정책 이고 역할 정책은 동작을 하나하나 적으므로(와일드카드 금지, lint 시험), 묶어도 실효 권한이 그대로다.
// 묶을 수 없으면 원문 그대로. 결과는 늘 다시 펼쳐 원래 목록과 같은지 확인한다 (다르면 원문)
const wildRe = (p: string) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
export function compactActions(actions: string[], ceiling: string[]): string[] {
  const want = new Set(actions.map((a) => a.toLowerCase()));
  const ceil = [...new Set([...ceiling, ...actions])];
  const covered = new Set<string>();
  const out: string[] = [];
  for (const a of [...actions].sort()) {
    if (covered.has(a)) continue;
    const i = a.indexOf(":");
    const svc = a.slice(0, i + 1), name = a.slice(i + 1);
    let pick = a;
    // 짧은 앞글자부터 (서비스 전체 "svc:*" 포함). 패턴에 걸리는 천장 동작이 전부 원래 목록 안이어야 한다
    for (let k = 0; k < name.length; k++) {
      const pat = `${svc}${name.slice(0, k)}*`;
      const re = wildRe(pat);
      const hit = ceil.filter((c) => re.test(c));
      if (hit.every((c) => want.has(c.toLowerCase()))) { pick = pat; hit.forEach((c) => covered.add(c)); break; }
    }
    covered.add(a);
    out.push(pick);
  }
  return [...new Set(out)];
}
export function compactSessionPolicy(policy: string, ceiling: string[]): string {
  const doc = JSON.parse(policy) as PolicyDoc;
  const explicit = actionsOfPolicy(doc);
  if (doc.Statement.length !== 1 || doc.Statement[0]!.Condition !== undefined || explicit.some((a) => a.includes("*"))) return policy;
  const packed = compactActions(explicit, ceiling);
  // 다시 펼치기: 천장 ∪ 원래 목록 중 패턴에 걸리는 것 = 원래 목록 이어야 한다
  const ceil = [...new Set([...ceiling, ...explicit])];
  const back = new Set(ceil.filter((c) => packed.some((p) => wildRe(p).test(c))));
  if (back.size !== explicit.length || explicit.some((a) => !back.has(a))) return policy;
  const out = JSON.stringify({ ...doc, Statement: [{ ...doc.Statement[0]!, Action: packed }] });
  return out.length < policy.length ? out : policy;
}
