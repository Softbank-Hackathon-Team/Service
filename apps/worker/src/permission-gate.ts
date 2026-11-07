import { PrecheckItem, type PermissionBundle, type PermissionGap, type Provider } from "@svc/contracts";
import { latestAcceptedSpecV2, scrubString, withTenant } from "@svc/core";
import { checkAwsPermissions, checkGcpPermissions, envFor, mockPrecheckEnabled, requiredBundles, specV2ForPlan,
  type BundleNeeds, type GcpCheckDeps } from "@svc/adapters";
import { awsPolicies, gapHint, permissionBundles, permissionDetail, permissionGateMode } from "./permission-hints.js";
import { relayKindOf } from "./relay/relay-step.js";
import { chooseEnvLayerSource, dbEnvLayerStore } from "./env-layer.js";
import { cachedGaps, mergePermissionCheck, permissionCacheSec } from "./permission-cache.js";

// PERM-GATE: 고객 권한을 단계 전에 본다. 두 군데서 쓴다
//   ① 사전 점검(precheck.ts): 이 이전이 쓰는 묶음만(명세·계획·경로에서 계산) → 빠졌으면 block 항목(PC-PERM-<묶음>) + detail.permissionGaps
//      → 명세 검토로 되돌아간다 (새 실패 코드 없음, 기존 사전 점검 block 길)
//   ② 환경 화면(permission-check 작업): 그 환경의 모든 묶음 → environment_permissions (화면 "권한 갱신 필요 (N개)")
//   확인은 관찰 역할로만 (adapters permissions/check.ts). 실행 SA 토큰은 승인 전에 빌리지 않는다

/** 환경 한 쪽의 확인 재료 (DB 에서 다시 읽은 값 + 빌린 관찰 자격) */
export interface EnvSideCheck {
  envId: string; provider: Provider; accountId: string | null; targetProject: string | null; region: string | null;
  awsRoleSuffix?: string | null;             // 한 계정에 환경 여럿 (0056): AWS 역할 이름 꼬리. 없으면 옛 이름
  platformSa?: string | null;
  gcpToken?: string;                         // 빌린 관찰 토큰 (진짜 발급기일 때만)
  awsEnv?: NodeJS.ProcessEnv;                // 빌린 관찰 자격 env (envFor 로 워커 자기 자격을 지운 것)
}
export interface GateDeps { gcp?: GcpCheckDeps; aws?: { exec?: GcpCheckDeps["exec"] }; env?: NodeJS.ProcessEnv }

/** 묶음마다 따로 견주나 (빌린 관찰 자격·환경 계정이 다 있음). 아니면 checkEnvBundles 가 "확인 못 함" 한 줄로 접는다 → 재사용 기록에 안 넣고, 재사용도 안 한다 */
export function checksEach(s: EnvSideCheck): boolean {
  if (s.provider === "gcp") return !!s.gcpToken && !!s.accountId;
  if (s.provider === "aws") return !!s.awsEnv && !!s.accountId && /^\d{12}$/.test(s.accountId);
  return false;
}

/** 묶음들을 그 환경의 실제 상태와 견준다. 빌린 관찰 자격이 없으면(흉내 발급기) 클라우드를 부르지 않고 "확인 못 함" 한 줄 */
export async function checkEnvBundles(s: EnvSideCheck, bundles: (PermissionBundle & { onSide?: "source" | "target" })[], version: number, d: GateDeps = {}): Promise<PermissionGap[]> {
  const env = d.env ?? process.env;
  const mine = bundles.filter((b) => b.cloud === s.provider);
  if (!mine.length) return [];
  const base = { envId: s.envId, version };
  if (s.provider === "gcp") {
    if (!checksEach(s)) return [unverifiedAll(mine, base, !s.accountId ? "환경에 GCP 프로젝트가 없음" : "빌린 관찰 자격이 없어(흉내 발급기) 고객 권한을 확인 못 함")];
    return checkGcpPermissions({ ...d.gcp, env: d.gcp?.env ?? env }, { ...base, token: s.gcpToken!, sourceProject: s.accountId!, targetProject: s.targetProject,
      platformSa: s.platformSa ?? null, bundles: mine });
  }
  if (s.provider === "aws") {
    if (!checksEach(s))
      return [unverifiedAll(mine, base, !s.awsEnv ? "빌린 관찰 자격이 없어(흉내 발급기) 고객 권한을 확인 못 함" : "환경 계정 번호가 없음")];
    return checkAwsPermissions({ ...(d.aws?.exec ? { exec: d.aws.exec } : {}), env: s.awsEnv! },
      { ...base, accountId: s.accountId!, region: s.region || "ap-northeast-2", bundles: mine, policies: awsPolicies(env), roleSuffix: s.awsRoleSuffix ?? null });
  }
  return [];
}
// 첫 묶음 이름으로 한 줄 (같은 이유가 묶음마다 줄줄이 나오지 않게)
function unverifiedAll(bs: PermissionBundle[], base: { envId: string; version: number }, why: string): PermissionGap {
  const b = bs[0]!;
  return { bundleId: b.id, envId: base.envId, cloud: b.cloud, stage: b.stage, side: b.side === "source" ? "source" : "target", principal: b.principal, role: b.role,
    requiredWhen: b.requiredWhen, level: "warn", missing: [], missingApis: [], unverified: `${why} (묶음 ${bs.length}개)`.slice(0, 300),
    grantedVersion: null, requiredVersion: base.version };
}

// ───────────────────── ① 사전 점검 ─────────────────────
interface MigrationSides { id: string; sourceEnvId: string; targetEnvId: string }
interface EnvRow { id: string; provider: Provider; account_id: string | null; gcp_target_project: string | null; region: string | null; aws_role_suffix?: string | null }
export interface PrecheckRoles { gcpToken?: Partial<Record<"source" | "target", string>>; awsEnv?: Partial<Record<"source" | "target", Record<string, string>>> }
/** 쪽마다 묶음 결과를 어디서 얻었나 (#373 B2, precheck detail.permissionSource). cache = environment_permissions 재사용, live = 지금 관찰 역할로 읽음 */
export interface PermissionSource { side: "source" | "target"; source: "cache" | "live"; ageSec: number }

/** 이 이전이 쓰는 묶음의 필요 조건 (명세 + 환경 층 + 중계기 + 허브) */
export async function bundleNeedsFor(tenantId: string, m: MigrationSides, envs: { source: EnvRow; target: EnvRow }, env: NodeJS.ProcessEnv): Promise<BundleNeeds> {
  const spec = await withTenant(tenantId, async (tx) => { const r = await latestAcceptedSpecV2(tx, m.id); return r ? specV2ForPlan(r) : null; }).catch(() => null);
  const kinds = new Set(spec?.components.map((c) => c.kind) ?? []);
  const layer = envs.target.provider === "gcp" ? await dbEnvLayerStore.get(tenantId, envs.target.id).catch(() => null) : null;
  const relay = relayKindOf(envs.source.provider, envs.target.provider);
  return {
    sourceProvider: envs.source.provider, targetProvider: envs.target.provider,
    secrets: (spec?.secrets?.length ?? 0) > 0, postgres: kinds.has("postgres"), data: kinds.has("cache") || kinds.has("objectStore") || kinds.has("queue"),
    envLayerCreate: chooseEnvLayerSource(envs.target.provider, layer, env) === "create",
    // TODO(human): GCP ↔ 온프레 중계기(gcp-onprem·onprem-gcp)의 권한 묶음은 아직 없다 (감사 로그로 뽑은 뒤 bundles.ts 에 더한다). 지금은 묶음 확인 밖
    relay: relay === "gcp-onprem" || relay === "onprem-gcp" ? null : relay ?? null,
    argoHub: envs.target.provider === "gcp" && !!env.GCP_PLATFORM_PROJECT?.trim(),
  };
}

/** 이 회사 플랫폼 SA 이메일 (허브 묶음의 주체). GCP_PLATFORM_PROJECT 가 없으면 허브를 안 쓰므로 null */
export async function platformSaOf(tenantId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const project = env.GCP_PLATFORM_PROJECT?.trim();
  if (!project) return null;
  const sa = await withTenant(tenantId, async (tx) => (await tx.query(`SELECT gcp_platform_sa FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.gcp_platform_sa as string | undefined);
  return sa ? `${sa}@${project}.iam.gserviceaccount.com` : null;
}

/** 사전 점검 칸: 이 이전이 쓰는 묶음 중 빠진 것. block 이면 명세 검토로 되돌아간다 (precheck 의 기존 규칙).
 *  흉내 사전 점검(MOCK_PRECHECK=1)·PERMISSION_GATE=off 는 아무것도 안 낸다 (시험·비상) */
export async function permissionPrecheck(tenantId: string, m: MigrationSides, roles: PrecheckRoles | undefined, d: GateDeps = {}):
  Promise<{ items: PrecheckItem[]; detail: ReturnType<typeof permissionDetail>; sources: PermissionSource[] }> {
  const env = d.env ?? process.env;
  const mode = permissionGateMode(env);
  if (mode === "off" || (mockPrecheckEnabled(env) && !d.gcp && !d.aws)) return { items: [], detail: null, sources: [] };
  const file = permissionBundles(env);
  if (!file) return { items: [PrecheckItem.parse({ id: "PC-PERM", level: "warn",
    message: "고객 권한 묶음 파일(infra/permissions/permission-bundles.json)이 없어 단계 전 권한 확인을 못 함",
    fix: "npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions infra/onboarding 로 다시 내고 worker 이미지에 넣는다" })], detail: null, sources: [] };
  const rows = await withTenant(tenantId, async (tx) => (await tx.query<EnvRow>(
    `SELECT id, provider, account_id, gcp_target_project, region, aws_role_suffix FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]])).rows);
  const source = rows.find((r) => r.id === m.sourceEnvId), target = rows.find((r) => r.id === m.targetEnvId);
  if (!source || !target) return { items: [], detail: null, sources: [] };
  const need = await bundleNeedsFor(tenantId, m, { source, target }, env);
  const req = requiredBundles(file.bundles, need);
  const platformSa = need.argoHub ? await platformSaOf(tenantId, env).catch(() => null) : null;
  const gaps: PermissionGap[] = [];
  const sources: PermissionSource[] = [];
  const cacheOn = permissionCacheSec(env) > 0;
  for (const side of ["source", "target"] as const) {
    const r = side === "source" ? source : target;
    const bs = req.filter((b) => b.onSide === side);
    if (!bs.length) continue;
    const awsEnv = roles?.awsEnv?.[side];
    const s: EnvSideCheck = { envId: r.id, provider: r.provider, accountId: r.account_id, targetProject: r.gcp_target_project, region: r.region,
      awsRoleSuffix: r.aws_role_suffix ?? null, platformSa, ...(roles?.gcpToken?.[side] ? { gcpToken: roles.gcpToken[side] } : {}), ...(awsEnv ? { awsEnv: envFor(awsEnv, env) } : {}) };
    // #373 B2: 묶음마다 따로 견줄 수 있는 쪽만 저장 결과를 본다 (접힌 "확인 못 함" 한 줄은 예전처럼 바로 낸다). 못 읽으면 실조회
    const hit = cacheOn && checksEach(s) ? await cachedGaps(tenantId, r.id, bs, file.version, env).catch(() => null) : null;
    if (hit) { gaps.push(...hit.gaps); sources.push({ side, source: "cache", ageSec: hit.ageSec }); continue; }
    const live = await checkEnvBundles(s, bs, file.version, d);
    gaps.push(...live);
    sources.push({ side, source: "live", ageSec: 0 });
    // 다음 사전 점검이 다시 쓰게 이 묶음만 되쓴다 (환경 화면도 같은 줄을 본다). 못 써도 사전 점검은 그대로 간다
    if (cacheOn && checksEach(s)) await mergePermissionCheck(tenantId, r.id, { version: file.version, bundles: bs, gaps: live, all: file.bundles })
      .catch((e) => console.error("permission cache write", scrubString((e as Error)?.message ?? String(e))));
  }
  const level = (g: PermissionGap) => (mode === "warn" ? "warn" : g.level);
  const what = (g: PermissionGap) => g.missing.length || g.missingApis.length
    ? `빠진 것 ${g.missing.length + g.missingApis.length}개: ${[...g.missing, ...g.missingApis.map((a) => `API ${a}`)].slice(0, 8).join(", ")}${g.missing.length + g.missingApis.length > 8 ? " 외" : ""}`
    : `확인 못 함: ${g.unverified ?? ""}`;
  // 막는 묶음은 하나씩 (명세 검토 화면이 묶음마다 보여 준다)
  const blocks = gaps.filter((g) => level(g) === "block").map((g) => PrecheckItem.parse({ id: `PC-PERM-${g.bundleId}`, level: "block",
    message: `FAIL 고객 권한 ${g.bundleId} (${g.cloud} ${g.side === "source" ? "출발" : "도착"} ${g.principal} · ${g.role}) — ${what(g)}`.slice(0, 1000),
    fix: gapHint(g) }));
  // 주의는 한 줄로 합친다: warn 은 하나하나 계획서 승인 확인 항목(precheck_warn:<id>)이 되는데, 확인 권한(iam.roles.get)이 없는 예전 연결은
  //   묶음마다 "확인 못 함"이 생겨 승인 화면 체크가 묶음 수만큼 늘었다 (리뷰 11/06). 묶음별 내용은 detail.permissions.permissionGaps 에 그대로 남는다
  const warns = gaps.filter((g) => level(g) === "warn");
  const unverifiedOnly = warns.every((g) => !g.missing.length && !g.missingApis.length);
  const warn = warns.length ? [PrecheckItem.parse({ id: "PC-PERM-WARN", level: "warn",
    message: (`WARN 고객 권한 ${warns.length}묶음 ${unverifiedOnly ? "확인 못 함" : "주의"} — `
      + warns.map((g) => `${g.bundleId}(${g.missing.length || g.missingApis.length ? `빠진 것 ${g.missing.length + g.missingApis.length}` : "확인 못 함"})`).join(", ")
      + `. 첫 묶음: ${what(warns[0]!)}`).slice(0, 1000),
    fix: gapHint(warns.find((g) => g.missing.length || g.missingApis.length) ?? warns[0]!) })] : [];
  const items = [...blocks, ...warn];
  return { items, detail: permissionDetail(gaps.map((g) => ({ ...g, level: level(g) }))), sources };
}
