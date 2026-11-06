import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PermissionBundleFile, PermissionGap } from "@svc/contracts";
import { deniedPermissionsFromLog, gapsFromDenied, loadPermissionBundles, type PolicyDoc } from "@svc/adapters";

// PERM-GATE: 묶음 파일 읽기·사람이 읽는 고치는 법·멈춘 전이 detail 칸. 사전 점검(permission-gate.ts)과 apply 403 안전망(env-layer.ts·apply-real.ts)이 같이 쓴다

/** PERMISSION_GATE: block(기본) = 빠짐이 확인된 묶음은 막음, warn = 막지 않고 알림만(시연 비상용), off = 안 봄 */
export const permissionGateMode = (env: NodeJS.ProcessEnv = process.env): "block" | "warn" | "off" =>
  env.PERMISSION_GATE === "off" ? "off" : env.PERMISSION_GATE === "warn" ? "warn" : "block";

const permsDir = (env: NodeJS.ProcessEnv) => env.PERMISSIONS_DIR ?? fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
export const permissionBundles = (env: NodeJS.ProcessEnv = process.env): PermissionBundleFile | null => loadPermissionBundles(permsDir(env));
export function awsPolicies(env: NodeJS.ProcessEnv): { "svc-operate-policy"?: PolicyDoc; relay?: PolicyDoc } {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(permsDir(env), f), "utf8")) as PolicyDoc; } catch { return undefined; } };
  const op = read("aws-operate-role-policy.json"), relay = read("aws-relay-statements.json");
  return { ...(op ? { "svc-operate-policy": op } : {}), ...(relay ? { relay } : {}) };
}

/** 사람이 읽는 고치는 법 한 문장 (링크·명령은 api 가 묶음 id 로 만든다: GET /environments/:id/permissions?bundles=…) */
export function gapHint(g: Pick<PermissionGap, "cloud" | "notInTable" | "unverified" | "missing" | "missingApis">): string {
  if (g.notInTable?.length) return "플랫폼 권한표에 없는 권한이다: 권한표(packages/adapters/src/<클라우드>/index.ts)에 더하고 권한 판을 올려 export-permissions 로 다시 낸 뒤, 고객이 권한 갱신 링크를 실행한다";
  if (!g.missing.length && !g.missingApis.length && g.unverified) return g.cloud === "gcp"
    ? "확인 못 함: 고객 Cloud Shell 에서 연결 스크립트(gcp-connect.sh)를 다시 실행하면 관찰 역할에 확인 권한(iam.roles.get, 전용 프로젝트만)이 더해진다"
    : "확인 못 함: 연결 스택을 새 템플릿으로 업데이트하면 관찰 역할에 확인 권한(iam:SimulatePrincipalPolicy, 이 계정 svc-* 역할만)이 더해진다";
  return g.cloud === "gcp"
    ? "환경 화면의 [Cloud Shell 에서 갱신]: 빠진 묶음만 맞추는 연결 스크립트(ONLY_BUNDLES)를 고객 Cloud Shell 에서 실행한 뒤 [다시 확인]"
    : "환경 화면의 [AWS 연결 스택 갱신]: 같은 스택을 새 템플릿 판으로 업데이트(매개변수는 그대로)한 뒤 [다시 확인]";
}

/** 멈춘 전이 detail 에 넣는 칸 (웹 stopHelpOf 가 missing·hint 를 읽고, 권한 카드가 permissionGaps 를 그린다) */
export function permissionDetail(gaps: PermissionGap[]): { missing: string[]; hint: string; permissionGaps: PermissionGap[] } | null {
  if (!gaps.length) return null;
  const missing = [...new Set(gaps.flatMap((g) => [...g.missing, ...g.missingApis.map((a) => `api: ${a}`), ...(g.notInTable ?? [])]
    .map((x) => `${g.cloud}: ${g.principal} ${x}`)))].slice(0, 100);
  const first = gaps.find((g) => g.level === "block") ?? gaps[0]!;
  return { missing, hint: gapHint(first), permissionGaps: gaps };
}


/** apply 403 안전망 (사후): Terraform 로그의 "Required 'X' permission"·"not authorized to perform: X" → 사전 점검과 같은 PermissionGap 모양.
 *  그 단계 주체(환경 층 = svc-env, 앱 층 = svc-operate)의 묶음에 붙인다. 로그에 권한 이름이 없으면 null (원래 실패 그대로) */
export function deniedPermissionDetail(log: string[] | undefined, o: { cloud: "aws" | "gcp"; principal: string; envId: string }, env: NodeJS.ProcessEnv = process.env) {
  if (!log?.length) return null;
  const denied = deniedPermissionsFromLog(log)[o.cloud];
  if (!denied.length) return null;
  const file = permissionBundles(env);
  if (!file) return { missing: denied.map((x) => `${o.cloud}: ${o.principal} ${x}`), hint: "권한 묶음 파일이 없어 고치는 링크를 못 만듦: 빠진 권한을 고객 역할에 더한다" };
  return permissionDetail(gapsFromDenied(file.bundles, denied, { ...o, version: file.version }));
}
