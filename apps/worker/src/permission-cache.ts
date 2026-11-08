import { createHash } from "node:crypto";
import { envNumber, StoredPermissionCheck, type PermissionBundle, type PermissionCheckedBundle, type PermissionGap } from "@svc/contracts";
import { withTenant, type Tx } from "@svc/core";

// PERM-GATE 재사용 (#373 B2): 사전 점검이 environment_permissions 의 묶음별 결과를 다시 쓴다
//   왜: 11/07 잰 값 — 사전 점검 벽시계 10·38·65초 중 실조회(PC-TIME)는 2.45초(8개)·19.7초(12개). 나머지 대부분이 묶음 확인
//       (AWS 는 묶음마다 iam get-role + simulate-principal-policy 를 하나씩 차례로)
//   쓰는 쪽: permission-check 작업(환경 묶음 전부, 통째로 덮음·새 줄)·사전 점검(이 이전이 쓰는 묶음만, 같은 판의 정상 줄이 있을 때만 그 묶음을 갈아 끼움)
//   다시 쓰는 조건 (묶음마다): ① PERMISSION_CACHE_SEC 안에 따로 견줬음 ② 같은 권한 판(requiredVersion) ③ 같은 묶음 정의(def 지문)
//     + 확인 자체를 못 한 줄(error)은 안 쓴다. 판정(block·warn)은 저장된 그대로 → 사전 점검이 같은 규칙으로 막거나 알린다
//   막힘(block) 묶음이 하나라도 있으면 다시 읽는다: 고객이 고친 뒤 [다시 확인] 없이 바로 다시 돌린 사전 점검이 옛 막힘에 걸리지 않게

// DRAFT(ai): 600초 (실측: 사전 점검 한 번 1분 안팎, 다시 돌리기·반대 방향 이전이 보통 10분 안). 0 이하·숫자 아님 = 재사용·되쓰기 안 함 (예전 그대로)
export const PERMISSION_CACHE_SEC_DEFAULT = 600;
export function permissionCacheSec(env: NodeJS.ProcessEnv = process.env): number {
  const v = envNumber(env.PERMISSION_CACHE_SEC, PERMISSION_CACHE_SEC_DEFAULT);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 묶음 정의 지문: 판정과 차이(gap)에 실리는 값 전부(주체·역할·권한·API·조건·필요 조건). onSide 처럼 이전마다 다른 값은 뺀다 */
export function bundleDef(b: PermissionBundle): string {
  return createHash("sha256").update(JSON.stringify([b.id, b.cloud, b.stage, b.side, b.principal, b.role, b.conditional, b.permissions, b.apis, b.requiredWhen]))
    .digest("hex").slice(0, 16);
}
export const checkedEntries = (bundles: PermissionBundle[], at: Date = new Date()): PermissionCheckedBundle[] =>
  bundles.map((b) => ({ bundleId: b.id, at: at.toISOString(), def: bundleDef(b) }));

/** 고객 쪽에 붙은 판 = 읽은 판 중 가장 낮은 것 (읽은 게 없으면 모름) */
export const minVersion = (gaps: PermissionGap[]) => {
  const v = gaps.map((g) => g.grantedVersion).filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};
/** 저장 모양. 빠진 묶음이 없으면 고객 쪽 실제 상태 = 지금 판 (역할 설명·태그가 옛 판이어도 권한은 다 있음) */
export function storedResult(version: number, gaps: PermissionGap[], checked?: PermissionCheckedBundle[]): StoredPermissionCheck {
  return { requiredVersion: version, grantedVersion: gaps.length ? minVersion(gaps) : version, gaps, ...(checked?.length ? { checked } : {}) };
}

const UPSERT = `INSERT INTO environment_permissions (environment_id, tenant_id, result, checked_at) VALUES ($1, $2, $3, now())
  ON CONFLICT (environment_id) DO UPDATE SET result = EXCLUDED.result, checked_at = EXCLUDED.checked_at`;
const upsert = (tx: Tx, tenantId: string, envId: string, r: StoredPermissionCheck) =>
  tx.query(UPSERT, [envId, tenantId, JSON.stringify(StoredPermissionCheck.parse(r))]);

/** 환경 한 줄 통째로 쓰기 (permission-check 작업) */
export async function savePermissionCheck(tenantId: string, envId: string, r: StoredPermissionCheck): Promise<void> {
  await withTenant(tenantId, (tx) => upsert(tx, tenantId, envId, r));
}

/** 사전 점검이 실조회한 묶음만 갈아 끼운다. 같은 판의 정상 줄(permission-check 가 만든 환경 묶음 전부)이 있을 때만 그 안에 병합하고,
 *  그 밖 묶음의 예전 결과·확인 때는 그대로 둔다 (확인 때를 묶음마다 두므로 예전 결과가 새것처럼 보이지 않는다).
 *  줄이 없거나·모양이 틀리거나·error 줄·옛 판이면 쓰지 않는다 (skipped_no_row): 이 이전이 쓴 몇 묶음만으로 줄을 만들면
 *  환경 화면이 아무도 안 본 묶음까지 "권한 최신"(grantedVersion = 지금 판)으로 보여서 (리뷰 #376). 새 줄은 permission-check 작업만 만든다.
 *  저장 gaps 의 side 는 permission-check 와 같게(both → target), 순서는 묶음 파일 순서 */
export async function mergePermissionCheck(tenantId: string, envId: string,
  o: { version: number; bundles: PermissionBundle[]; gaps: PermissionGap[]; all: PermissionBundle[] }, now: Date = new Date()): Promise<"merged" | "skipped_no_row"> {
  const ids = new Set(o.bundles.map((b) => b.id));
  const order = new Map(o.all.map((b, i) => [b.id, i]));
  const sideOf = new Map(o.all.map((b) => [b.id, b.side === "source" ? "source" as const : "target" as const]));
  return withTenant(tenantId, async (tx) => {
    const row = (await tx.query(`SELECT result FROM environment_permissions WHERE environment_id = $1 FOR UPDATE`, [envId])).rows[0];
    const p = row?.result ? StoredPermissionCheck.safeParse(row.result) : null;
    const old = p?.success && !p.data.error && p.data.requiredVersion === o.version ? p.data : null;
    if (!old) return "skipped_no_row";
    const gaps = [...old.gaps.filter((g) => !ids.has(g.bundleId)), ...o.gaps.map((g) => ({ ...g, side: sideOf.get(g.bundleId) ?? g.side }))]
      .sort((a, b) => (order.get(a.bundleId) ?? o.all.length) - (order.get(b.bundleId) ?? o.all.length));
    const checked = [...(old.checked ?? []).filter((c) => !ids.has(c.bundleId)), ...checkedEntries(o.bundles, now)];
    await upsert(tx, tenantId, envId, storedResult(o.version, gaps, checked));
    return "merged";
  });
}

/** 저장된 결과로 이 묶음들을 다 답할 수 있으면 그 차이(묶음 순서, side = 이번 이전에서의 쪽)와 가장 오래된 확인의 나이. 하나라도 못 쓰면 null (→ 실조회) */
export async function cachedGaps(tenantId: string, envId: string, bundles: (PermissionBundle & { onSide: "source" | "target" })[], version: number,
  env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): Promise<{ gaps: PermissionGap[]; ageSec: number } | null> {
  const ttl = permissionCacheSec(env);
  if (!ttl || !bundles.length) return null;
  const row = await withTenant(tenantId, async (tx) => (await tx.query(`SELECT result FROM environment_permissions WHERE environment_id = $1`, [envId])).rows[0]);
  const p = row?.result ? StoredPermissionCheck.safeParse(row.result) : null;
  if (!p?.success || p.data.error || p.data.requiredVersion !== version || !p.data.checked) return null;
  const s = p.data;
  let age = 0;
  const gaps: PermissionGap[] = [];
  for (const b of bundles) {
    const c = s.checked!.find((x) => x.bundleId === b.id);
    const at = c ? Date.parse(c.at) : NaN;
    if (!c || c.def !== bundleDef(b) || !Number.isFinite(at)) return null;
    const a = Math.max(0, (now - at) / 1000);   // 워커끼리 시계가 조금 어긋나 미래로 보이면 0
    if (a > ttl) return null;
    age = Math.max(age, a);
    for (const g of s.gaps.filter((x) => x.bundleId === b.id)) {
      if (g.level === "block") return null;
      gaps.push({ ...g, side: b.onSide });
    }
  }
  return { gaps, ageSec: Math.floor(age) };
}
