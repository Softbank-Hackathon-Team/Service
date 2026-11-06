import type { PermissionBundle, PermissionGap } from "@svc/contracts";
import { arr, CliError, get, runJson, str, type CliDeps } from "../common/cli.js";
import { gcpEnvFor } from "../verify/gcp.js";
import type { PolicyDoc, PolicyStatement } from "./bundles.js";

// PERM-GATE: 고객 쪽 "실제 상태"를 읽어 묶음과 견준다. 읽기만 한다 (관찰 역할로). 쓰기 명령 없음.
//   GCP: ① 관찰 SA 자기 권한 = projects.testIamPermissions (빌린 관찰 토큰으로)
//        ② 다른 고객 SA(plan·env·operate)·플랫폼 SA = 전용 프로젝트 IAM 정책(누구에게 어느 역할) + 그 역할 정의(iam.roles.get, 관찰 SA 의 작은 역할 platform_observe_permcheck)
//           — 실행 SA 토큰을 승인 전에 빌리지 않으려고 testIamPermissions 대신 역할 정의를 본다 (조건부 바인딩도 이 길이 더 정확: 프로젝트 단위 testIamPermissions 는 조건을 못 맞춘다)
//        ③ API 켜짐 = services list (serviceusage.services.list, 관찰 역할에 있음)
//   AWS: 관찰 역할이 iam:SimulatePrincipalPolicy 로 svc-operate·svc-observe 정책을 흉내 평가한다. 자원·조건 값은 우리 정책 문서의 문장에서 만든 견본
//        (사전 점검 중계기 권한 PC-RELAY-PERM 과 같은 방식). 권한 판은 iam:GetRole 의 역할 태그
//   판정: 빠졌음이 확인되면 block, 확인 못 하면 warn (가짜 통과 없음). 관찰 묶음은 단계 403 이 아니라 읽기가 덜 되는 것이라 warn

export const GCP_ROLE_VERSION_RE = /\[perms v(\d+)\]/;
export const AWS_PERMS_VERSION_TAG = "platform-perms-version";
const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();
const DENIED = /PERMISSION_DENIED|IAM_PERMISSION_DENIED|does not have permission|\b403\b|AccessDenied|not authorized/i;
const short = (e: unknown) => (e instanceof CliError ? (DENIED.test(e.stderr) ? "권한 없음" : e.message) : (e as Error)?.message ?? String(e)).slice(0, 160);

export interface CheckBase { envId: string; version: number }
type Bundle = PermissionBundle & { onSide?: "source" | "target" };
const sideOf = (b: Bundle): "source" | "target" => b.onSide ?? (b.side === "source" ? "source" : "target");

function gap(b: Bundle, base: CheckBase, o: { missing?: string[]; missingApis?: string[]; unverified?: string; grantedVersion: number | null; level?: "block" | "warn"; notInTable?: string[] }): PermissionGap {
  const missing = uniq(o.missing ?? []), missingApis = uniq(o.missingApis ?? []);
  // 관찰·확인 역할 묶음은 단계를 403 으로 죽이지 않는다 (가져오기·화면 읽기가 덜 됨) → 막지 않고 알린다
  const soft = b.stage === "observe";
  const level = o.level ?? (o.unverified || soft ? "warn" : "block");
  return { bundleId: b.id, envId: base.envId, cloud: b.cloud, stage: b.stage, side: sideOf(b), principal: b.principal, role: b.role,
    requiredWhen: b.requiredWhen, level, missing, missingApis, ...(o.notInTable?.length ? { notInTable: uniq(o.notInTable) } : {}),
    ...(o.unverified ? { unverified: o.unverified.slice(0, 300) } : {}), grantedVersion: o.grantedVersion, requiredVersion: base.version };
}

// ───────────────────────────── GCP ─────────────────────────────
export interface GcpCheckInput extends CheckBase {
  token: string;
  sourceProject: string;           // 고객 원래 프로젝트 (관찰 SA 가 산다)
  targetProject: string | null;    // 이전 전용 프로젝트 (없으면 도착 묶음은 확인 못 함)
  platformSa?: string | null;      // 이 회사 플랫폼 SA 이메일 (허브 묶음)
  bundles: Bundle[];
}
export interface GcpCheckDeps extends CliDeps { fetch?: typeof fetch; timeoutMs?: number }
interface RoleDef { perms: Set<string>; version: number | null }
interface Binding { role: string; members: string[]; conditional: boolean }

/** projects.testIamPermissions (호출한 주체 = 빌린 관찰 SA 자신). 100개씩. 실패면 null (확인 못 함) */
export async function testIamPermissions(d: GcpCheckDeps, token: string, project: string, perms: string[]): Promise<{ granted: Set<string> } | { error: string }> {
  const f = d.fetch ?? fetch, granted = new Set<string>();
  for (let i = 0; i < perms.length; i += 100) {
    try {
      // 토큰은 머리글로만 (URL·로그에 안 남김)
      const r = await f(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}:testIamPermissions`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ permissions: perms.slice(i, i + 100) }), signal: AbortSignal.timeout(d.timeoutMs ?? 15_000) });
      const j = await r.json().catch(() => ({})) as { permissions?: string[]; error?: { message?: string; status?: string } };
      if (!r.ok) return { error: `testIamPermissions ${r.status} ${(j.error?.status ?? "")} ${(j.error?.message ?? "").slice(0, 100)}`.trim() };
      for (const p of j.permissions ?? []) granted.add(p);
    } catch (e) { return { error: `testIamPermissions 실패 (${short(e)})` }; }
  }
  return { granted };
}

const memberOf = (b: Bundle, i: GcpCheckInput): string | null =>
  b.principal === "platform" ? (i.platformSa ? `serviceAccount:${i.platformSa}` : null)
    : b.principal === "svc-observe" ? `serviceAccount:svc-observe@${i.sourceProject}.iam.gserviceaccount.com`
      : i.targetProject ? `serviceAccount:${b.principal}@${i.targetProject}.iam.gserviceaccount.com` : null;

export async function checkGcpPermissions(d: GcpCheckDeps, i: GcpCheckInput): Promise<PermissionGap[]> {
  const out: PermissionGap[] = [];
  const projOf = (b: Bundle) => (sideOf(b) === "source" ? i.sourceProject : i.targetProject);
  const env = (project: string) => gcpEnvFor(i.token, project, d.env ?? process.env);
  const dd = (project: string): CliDeps => ({ ...d, env: env(project) });
  // ③ API 켜짐 (프로젝트마다 한 번)
  const apis = new Map<string, Set<string> | string>();
  const apisOf = async (p: string) => {
    if (!apis.has(p)) {
      try { apis.set(p, new Set(arr(await runJson(dd(p), "gcloud", ["services", "list", "--enabled", "--project", p, "--format", "json", "--quiet"]))
        .map((s) => str(get(s, "config", "name")) ?? str(s.name)?.split("/").pop() ?? ""))); }
      catch (e) { apis.set(p, `API 목록 못 읽음 (${short(e)})`); }
    }
    return apis.get(p)!;
  };
  // ① 관찰 SA 자기 권한 (프로젝트마다 한 번, 그 프로젝트 관찰 묶음 권한 전부)
  const selfTest = new Map<string, { granted: Set<string> } | { error: string }>();
  // ② 전용 프로젝트 IAM 정책 + 역할 정의 (한 번씩)
  let policy: Binding[] | string | undefined;
  const roles = new Map<string, RoleDef | string>();
  const roleDef = async (name: string, project: string): Promise<RoleDef | string> => {
    if (!roles.has(name)) {
      const custom = /^projects\/[^/]+\/roles\/([A-Za-z0-9_.]+)$/.exec(name)?.[1];
      const args = custom ? ["iam", "roles", "describe", custom, "--project", project] : ["iam", "roles", "describe", name];
      try {
        const r = await runJson(dd(project), "gcloud", [...args, "--format", "json", "--quiet"]);
        const deleted = get(r, "deleted") === true;
        const v = GCP_ROLE_VERSION_RE.exec(str(get(r, "description")) ?? "")?.[1];
        roles.set(name, { perms: new Set(deleted ? [] : ((get(r, "includedPermissions") as string[] | undefined) ?? [])), version: v ? Number(v) : null });
      } catch (e) { roles.set(name, `역할 ${custom ?? name} 정의 못 읽음 (${short(e)}) — 관찰 역할에 iam.roles.get(platform_observe_permcheck)이 없으면 연결 스크립트를 다시 실행`); }
    }
    return roles.get(name)!;
  };
  for (const b of i.bundles.filter((x) => x.cloud === "gcp")) {
    const p = projOf(b);
    if (!p) { out.push(gap(b, i, { unverified: "이전 전용 프로젝트(gcp_target_project)가 없어 확인 못 함", grantedVersion: null })); continue; }
    const a = b.apis.length ? await apisOf(p) : new Set<string>();
    const missingApis = typeof a === "string" ? [] : b.apis.filter((x) => !a.has(x));
    const apiNote = typeof a === "string" ? a : undefined;
    if (b.principal === "svc-observe") {
      const perms = uniq(i.bundles.filter((x) => x.cloud === "gcp" && x.principal === "svc-observe" && projOf(x) === p).flatMap((x) => x.permissions));
      if (!selfTest.has(p)) selfTest.set(p, await testIamPermissions(d, i.token, p, perms));
      const t = selfTest.get(p)!;
      const ver = p === i.targetProject && i.targetProject ? await roleDef(`projects/${p}/roles/${b.role}`, p) : null;
      const grantedVersion = ver && typeof ver !== "string" ? ver.version : null;
      if ("error" in t) { out.push(gap(b, i, { missingApis, unverified: t.error, grantedVersion })); continue; }
      const missing = b.permissions.filter((x) => !t.granted.has(x));
      if (missing.length || missingApis.length || apiNote) out.push(gap(b, i, { missing, missingApis, ...(apiNote ? { unverified: apiNote } : {}), grantedVersion,
        // 역할 정의 읽기 권한이 없으면 다른 묶음을 못 본다 — 그래도 단계를 막지는 않는다 (확인 못 함 = warn)
        level: "warn" }));
      continue;
    }
    const member = memberOf(b, i);
    if (!member) { out.push(gap(b, i, { missingApis, unverified: "플랫폼 SA 를 몰라 확인 못 함", grantedVersion: null })); continue; }
    if (policy === undefined) {
      try {
        policy = arr(get(await runJson(dd(p), "gcloud", ["projects", "get-iam-policy", p, "--format", "json", "--quiet"]), "bindings")).map((x) => ({
          role: str(x.role) ?? "", members: Array.isArray(x.members) ? (x.members as string[]) : [], conditional: !!x.condition }));
      } catch (e) { policy = `전용 프로젝트 IAM 정책 못 읽음 (${short(e)})`; }
    }
    if (typeof policy === "string") { out.push(gap(b, i, { missingApis, unverified: policy, grantedVersion: null })); continue; }
    const bound = policy.filter((x) => x.members.includes(member) && (b.conditional || !x.conditional));
    const own = `projects/${p}/roles/${b.role}`;
    const granted = new Set<string>();
    const notes: string[] = [];
    let grantedVersion: number | null = null;
    for (const r of uniq(bound.map((x) => x.role))) {
      const def = await roleDef(r, p);
      if (typeof def === "string") { notes.push(def); continue; }
      def.perms.forEach((x) => granted.add(x));
      if (r === own) grantedVersion = def.version;
    }
    const missing = b.permissions.filter((x) => !granted.has(x));
    // 조건부 묶음: 조건부 바인딩이 아예 없으면 빠진 것 (조건 식이 파일과 같은지는 연결 스크립트가 맞춘다)
    const noBinding = !bound.some((x) => x.role === own);
    const unverified = notes.length && missing.length ? notes[0] : apiNote;
    if (missing.length || missingApis.length || unverified)
      out.push(gap(b, i, { missing: noBinding && !missing.length ? [`binding:${b.role}`] : missing, missingApis, ...(unverified ? { unverified } : {}), grantedVersion }));
  }
  return out;
}

// ───────────────────────────── AWS ─────────────────────────────
export interface AwsCheckInput extends CheckBase {
  accountId: string; region: string;
  bundles: Bundle[];
  /** 정책 문서 (infra/permissions). 문장의 자원·조건으로 흉내 평가 견본을 만든다 */
  policies: { "svc-operate-policy"?: PolicyDoc; relay?: PolicyDoc };
}
const actionsOf = (s: PolicyStatement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
/** 문장의 자원 모양 → 견본 ARN (리전·계정 자리를 채우고 나머지 * 는 permcheck). "*" 면 null (흉내 평가 기본값 *) */
export function sampleArn(resource: unknown, action: string, region: string, account: string): string | null {
  const list = (Array.isArray(resource) ? resource : [resource]).filter((r): r is string => typeof r === "string");
  const svc = action.split(":")[0];
  const pick = list.find((r) => r !== "*" && r.split(":")[2] === (svc === "elasticloadbalancing" ? "elasticloadbalancing" : svc)) ?? (list.includes("*") ? "*" : list[0]);
  if (!pick || pick === "*") return null;
  const parts = pick.split(":");
  if (parts[3] === "*") parts[3] = region;
  if (parts[4] === "*") parts[4] = account;
  return parts.join(":").replace(/\$\{aws:PrincipalAccount\}/g, account).replace(/\*/g, "permcheck").replace(/\?/g, "a");
}
/** 문장 조건 → 흉내 평가 조건 값 (우리 문장이 허용하는 요청 모양) */
export function contextOf(cond: PolicyStatement["Condition"], region: string, account: string): object[] {
  const out = new Map<string, string>();
  const fill = (v: string) => v.replace(/\$\{aws:PrincipalAccount\}/g, account).replace(/\*/g, "permcheck").replace(/\?/g, "a");
  for (const [op, kv] of Object.entries(cond ?? {})) for (const [k, raw] of Object.entries(kv)) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (op === "Null") { if (String(v) === "false") out.set(k, "permcheck"); continue; }
    if (typeof v === "string" && /^String(Equals|Like)/.test(op)) out.set(k, k === "aws:RequestedRegion" ? region : fill(v));
  }
  if (!out.has("aws:RequestedRegion")) out.set("aws:RequestedRegion", region);
  return [...out].map(([k, v]) => ({ ContextKeyName: k, ContextKeyValues: [v], ContextKeyType: "string" }));
}
interface SimGroup { resource: string | null; context: object[]; actions: string[] }
function simGroups(actions: string[], doc: PolicyDoc | undefined, region: string, account: string): SimGroup[] {
  const groups = new Map<string, SimGroup>();
  for (const a of actions) {
    const s = doc?.Statement.find((x) => x.Effect === "Allow" && actionsOf(x).includes(a));
    const resource = s ? sampleArn(s.Resource, a, region, account) : null;
    const context = contextOf(s?.Condition, region, account);
    const key = JSON.stringify([resource, context]);
    const g = groups.get(key) ?? groups.set(key, { resource, context, actions: [] }).get(key)!;
    g.actions.push(a);
  }
  return [...groups.values()];
}

export async function checkAwsPermissions(d: CliDeps, i: AwsCheckInput): Promise<PermissionGap[]> {
  const out: PermissionGap[] = [];
  const versions = new Map<string, number | null>();
  const versionOf = async (role: string) => {
    if (!versions.has(role)) {
      try {
        const tags = arr(get(await runJson(d, "aws", ["iam", "get-role", "--role-name", role, "--output", "json"]), "Role", "Tags"));
        const v = str(tags.find((t) => t.Key === AWS_PERMS_VERSION_TAG)?.Value);
        versions.set(role, v && /^\d+$/.test(v) ? Number(v) : null);
      } catch { versions.set(role, null); }
    }
    return versions.get(role)!;
  };
  for (const b of i.bundles.filter((x) => x.cloud === "aws")) {
    const arn = `arn:aws:iam::${i.accountId}:role/${b.principal}`;
    const grantedVersion = await versionOf(b.principal);
    const doc = i.policies[b.role as keyof AwsCheckInput["policies"]];
    const allowed = new Set<string>();
    let unverified: string | undefined;
    let denied = false;
    for (const g of simGroups(b.permissions, doc, i.region, i.accountId)) {
      for (let k = 0; k < g.actions.length; k += 50) {
        const args = ["iam", "simulate-principal-policy", "--policy-source-arn", arn, "--action-names", ...g.actions.slice(k, k + 50),
          ...(g.resource ? ["--resource-arns", g.resource] : []), "--context-entries", JSON.stringify(g.context), "--output", "json"];
        try {
          for (const r of arr(get(await runJson(d, "aws", args), "EvaluationResults")))
            if (r.EvalDecision === "allowed" && typeof r.EvalActionName === "string") allowed.add(r.EvalActionName);
        } catch (e) {
          denied = e instanceof CliError && DENIED.test(e.stderr);
          unverified = denied ? "관찰 역할에 iam:SimulatePrincipalPolicy 가 없어 확인 못 함 (연결 스택을 새 템플릿으로 업데이트)" : `흉내 평가 실패 (${short(e)})`;
          break;
        }
      }
      if (unverified) break;
    }
    if (unverified) {
      // 확인용 권한 묶음 자체는 거부가 곧 "빠짐" 이다 (관찰 역할이 흉내 평가를 못 함)
      if (b.id === "aws.permcheck" && denied) out.push(gap(b, i, { missing: b.permissions, grantedVersion, level: "warn" }));
      else out.push(gap(b, i, { unverified, grantedVersion }));
      continue;
    }
    const missing = b.permissions.filter((a) => !allowed.has(a));
    if (missing.length) out.push(gap(b, i, { missing, grantedVersion }));
  }
  return out;
}

// ───────────────────── apply 403 안전망 (사후) ─────────────────────
// Terraform·gcloud·aws 로그에서 "빠진 권한 이름"을 뽑는다. 예:
//   Error 403: Required 'compute.addresses.setLabels' permission for 'projects/…'          (GCP provider)
//   Permission 'iam.serviceAccounts.get' denied on resource …                              (GCP)
//   … is not authorized to perform: ec2:CreateTags on resource …                           (AWS)
const GCP_DENIED_RES = [/Required '([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)' permission/g, /Permission '([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)' denied/g,
  /permission "([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+\.[a-zA-Z0-9]+)" (?:is )?denied/gi];
const AWS_DENIED_RE = /is not authorized to perform: ([a-z0-9-]+:[A-Za-z0-9]+)/g;
export function deniedPermissionsFromLog(log: string | string[]): { gcp: string[]; aws: string[] } {
  const t = Array.isArray(log) ? log.join("\n") : log;
  const gcp = GCP_DENIED_RES.flatMap((re) => [...t.matchAll(re)].map((m) => m[1]!));
  return { gcp: uniq(gcp), aws: uniq([...t.matchAll(AWS_DENIED_RE)].map((m) => m[1]!)) };
}
/** 로그의 빠진 권한 → 같은 PermissionGap 모양. 그 단계 주체의 묶음 중 그 권한을 가진 것에 붙이고, 권한표 어디에도 없으면 notInTable 로 (플랫폼이 표를 고쳐야 함) */
export function gapsFromDenied(bundles: PermissionBundle[], denied: string[], o: CheckBase & { cloud: "aws" | "gcp"; principal: string }): PermissionGap[] {
  if (!denied.length) return [];
  const mine = bundles.filter((b) => b.cloud === o.cloud && b.principal === o.principal);
  const out = new Map<string, { b: PermissionBundle; missing: string[]; notInTable: string[] }>();
  for (const p of denied) {
    const b = mine.find((x) => x.permissions.includes(p));
    const host = b ?? mine[0];
    if (!host) continue;
    const e = out.get(host.id) ?? out.set(host.id, { b: host, missing: [], notInTable: [] }).get(host.id)!;
    (b ? e.missing : e.notInTable).push(p);
  }
  return [...out.values()].map(({ b, missing, notInTable }) => gap(b, o, { missing, notInTable, grantedVersion: null, level: "block" }));
}
