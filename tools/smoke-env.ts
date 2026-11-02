// smoke 가 쓸 출발·도착 환경. SMOKE_TARGET_ENV_ID(예: Azure Mock 4444…, onprem 5555…)·SMOKE_SOURCE_ENV_ID 로 바꾼다
export const DEFAULT_SOURCE_ENV_ID = "22222222-2222-4222-8222-222222222222";
export const DEFAULT_TARGET_ENV_ID = "33333333-3333-4333-8333-333333333333";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function smokeEnvs(env: NodeJS.ProcessEnv = process.env): { sourceEnvId: string; targetEnvId: string } {
  const sourceEnvId = env.SMOKE_SOURCE_ENV_ID?.trim() || DEFAULT_SOURCE_ENV_ID;
  const targetEnvId = env.SMOKE_TARGET_ENV_ID?.trim() || DEFAULT_TARGET_ENV_ID;
  for (const [k, v] of [["SMOKE_SOURCE_ENV_ID", sourceEnvId], ["SMOKE_TARGET_ENV_ID", targetEnvId]] as const)
    if (!UUID.test(v)) throw new Error(`${k} 가 UUID 가 아니다: ${v}`);
  if (sourceEnvId === targetEnvId) throw new Error("출발과 도착 환경이 같다");
  return { sourceEnvId, targetEnvId };
}

// DEMOFLAGS DRAFT(ai): smoke 는 서버 깃발(PLAN_ACKS)이 켜졌든 꺼졌든 늘 acks·planHash 를 보낸다.
//   서버 깃발이 꺼져 있으면 acks 는 기록만 되고 planHash 는 그냥 지나간다 (api 시험 approval-acks·vpa8-verify). 켜져 있으면 둘 다 검사된다.
//   예전엔 smoke 쪽 PLAN_ACKS 와 서버 쪽 PLAN_ACKS 가 따로여서 한쪽만 켜면 409 가 났다. env 인자는 옛 호출부 호환용으로만 남김
export function smokePlanBodies(plan: { planHash: string; acknowledgements?: { id: string }[] }, _env: NodeJS.ProcessEnv = process.env): { approve: Record<string, unknown>; start: Record<string, unknown> } {
  const acks = (plan.acknowledgements ?? []).map((a) => a.id);
  return {
    approve: { decision: "approve", planHash: plan.planHash, ...(acks.length ? { acks } : {}) },
    start: { planHash: plan.planHash },
  };
}

// E2E-v7 DRAFT(ai): IMPORT_IR=v2 서버면 가져오기가 검토 칸(needsReviewV2)을 남겨 POST /plan 이 409 GUARD_FAILED 다.
//   smoke 는 화면 대신 그 칸을 전부 "봤다"(confirm)로 보낸다. v1 검토 칸(service.cpu·memory)은 v2 판에선
//   components.<app.name>.resources confirm 으로만 풀린다(E2E v3 메모). 고칠 칸이 없으면 null (PATCH 안 보냄)
export function smokeConfirmBody(view: { version: number; needsReview?: string[]; needsReviewV2?: string[]; spec?: { app?: { name?: string } } }): { baseVersion: number; confirm: string[] } | null {
  const v2 = view.needsReviewV2 ?? [];
  const v1 = view.needsReview ?? [];
  const app = view.spec?.app?.name;
  const confirm = [...v2];
  if (v1.length && app && (v2.length || view.needsReviewV2 !== undefined)) {
    const res = `components.${app}.resources`;
    if (!confirm.includes(res)) confirm.push(res);
  }
  if (!confirm.length) return null;
  return { baseVersion: view.version, confirm: confirm.slice(0, 20) };
}
// VSMOKE: 가져오기가 사람 확인 칸(needs_review)을 남기면 POST /plan 이 409 GUARD_FAILED("N field(s) need review").
//   aws 데모가 ECS(v2, I9)가 된 뒤 IMPORT_IR=v2 회차는 ECS 예약값 → 요청량(0.9) 같은 칸이 생긴다. 화면이 하듯 그 키를 그대로 confirm 한다
//   (값은 안 바꾸고 "봤다"만). AI 초안 판이면 acceptDraft 로 먼저 받아들인다. 확인 칸이 없으면 아무 요청도 안 보낸다(깃발 꺼짐 회차 그대로)
export interface SmokeSpecView { version: number; source: "accepted" | "ai_draft"; needsReview: string[]; needsReviewV2?: string[]; spec?: { app?: { name?: string } } }
export function smokeReviewBody(v: SmokeSpecView): Record<string, unknown> | null {
  const keys = [...(v.needsReviewV2 ?? v.needsReview)];
  // E2EKINDS: v2 판인데 v2 칸은 다 풀리고 v1 칸(service.cpu·memory)만 남으면 가드(spec_versions.needs_review)가 여전히 409.
  //   smokeConfirmBody 와 같은 규칙으로 components.<app.name>.resources 를 confirm 한다 (k8s 출발 gcp 데모에서 걸림)
  const app = v.spec?.app?.name;
  if (v.needsReviewV2 !== undefined && v.needsReview.length && app && !keys.includes(`components.${app}.resources`)) keys.push(`components.${app}.resources`);
  if (!keys.length && v.source !== "ai_draft") return null;
  return { baseVersion: v.version, ...(v.source === "ai_draft" ? { acceptDraft: v.version } : {}),
    ...(keys.length ? { confirm: keys.slice(0, 20) } : {}) };
}
type Call = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
// VSMOKE: 출발 방화벽을 못 읽은 데이터 자원(RDS·ElastiCache·Memorystore 매퍼는 늘 ingress "unknown")은 사전 점검이 block(PC-V2-HUMAN)으로
//   spec_review 로 돌려보낸다. 사람이 정하는 칸이라 smoke 는 가장 좁은 값 = 빈 허용 목록(의존성 연결만 열림)을 고른다. 어느 자원을 바꿨는지 찍는다
export function smokePostureDecision(specV2: unknown): { value: Record<string, unknown>; subjects: string[] } | null {
  const posture = (specV2 as { posture?: { network?: Array<{ scope?: string; subject?: string; ingress?: unknown }> } } | undefined)?.posture;
  const net = posture?.network ?? [];
  const subjects = net.filter((n) => n.scope === "component" && n.ingress === "unknown").map((n) => String(n.subject)).sort();
  if (!subjects.length) return null;
  return { value: { ...posture, network: net.map((n) => (n.scope === "component" && n.ingress === "unknown" ? { ...n, ingress: [] } : n)) }, subjects };
}
/** 확인 칸이 다 없어질 때까지 GET → PATCH (한 번에 20칸), 그다음 방화벽 모름 자원은 빈 허용 목록으로. 확인한 칸 수·바꾼 자원을 돌려준다 */
export async function smokeConfirmReview(call: Call, id: string, maxRounds = 10): Promise<number> {
  let n = 0;
  for (let i = 0; i < maxRounds; i++) {
    const view = await call("GET", `/migrations/${id}/spec`) as unknown as SmokeSpecView & { specV2?: unknown };
    const body = smokeReviewBody(view);
    if (body) {
      n += (body.confirm as string[] | undefined)?.length ?? 0;
      await call("PATCH", `/migrations/${id}/spec`, body);
      continue;
    }
    const d = smokePostureDecision(view.specV2);
    if (!d) return n;
    console.log(`사람 결정 흉내: 출발 방화벽 모름 ${d.subjects.join(",")} → 허용 목록 [] (의존성 연결만)`);
    await call("PATCH", `/migrations/${id}/spec`, { baseVersion: view.version, changes: [{ path: "posture", value: d.value }] });
  }
  throw new Error(`명세 확인 칸이 ${maxRounds}번 PATCH 뒤에도 남음`);
}
