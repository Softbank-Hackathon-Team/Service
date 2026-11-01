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
  if (policy.length > AWS_SESSION_POLICY_MAX)
    throw new TempRoleDenied("ROLE_POLICY_TOO_LARGE", `세션 정책 ${policy.length}자 > ${AWS_SESSION_POLICY_MAX}. 관리형 정책 ARN(PolicyArns)으로 나눠야 한다`);
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
