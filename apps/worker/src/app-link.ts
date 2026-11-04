// Z31 DRAFT(ai): 컷오버(C1 붙잡기 / C6 풀어 주기) 때 앱의 DB 연결을 옮기는 쪽.
// 결정 (10/31, 앱 연결 드레인 TODO(human) → AI 기본값): "붙잡기(hold) 프록시 + GitOps 값 기록"
//   1. 빠른 길 (밀리초): 앱 DB 주소 = 붙잡기 프록시. C1 에 붙잡고, C6 에 도착으로 풀어 준다. 앱 재배포 없음
//   2. 오래가는 길 (커밋): 컷오버가 끝나면 GitOps 값 database.activeWriter 를 target 으로 남긴다.
//      프록시가 재시작해도(파드 교체) 도착을 본다. resume 이 끝내 실패한 경우 이게 복구 길이다
// 상태기계 22상태는 그대로. cutover 상태 안의 C1·C6 서브스텝에서만 일어난다 (계약 변경 없음)
// APP_LINK_URLS 가 없으면 프록시 훅은 없다. GitOps activeWriter 기록은 APP-22 (가) 로 기본 켬 (아래 appLinkOn)
import type { Endpoint } from "@svc/replication";
import { appLinkFromEnv, holdHooks, type AppLinkReport, type HoldHooks } from "@svc/dbproxy";
import type { Provider } from "@svc/contracts";
import { envFor, iacMockEnabled } from "@svc/adapters";
import { deleteLinkSecret, loadWriterState } from "./db-writer.js";
import { reapplyDbWriter, type RealApplyInput } from "./jobs/apply-real.js";
import { withStepRoles } from "./jobs/_roles.js";
import type { MigrationRow } from "./jobs/_step.js";
import { latestAcceptedAppName, type Tx } from "@svc/core";
import { configFromEnv, GitopsRepo, ENV_DIR, tenantSlug, type BundleRef } from "./gitops/index.js";

export type Writer = "source" | "target";

// APP-22 (가) DECISION(team): 컷오버 전까지 도착 앱은 출발 DB 에 붙고, 컷오버(C6 뒤)에 도착 DB 로 바꾼다. 롤백하면 다시 출발.
//   도착에서 직접 쓰는 걸 막는 감지(TARGET_LOCAL_WRITES → 관문 안 열림)는 안전망으로 그대로 둔다 (11/4 01:57Z Jeong 결정, 관리 스레드 전달)
//   - 기본 켬. APP_LINK=0 일 때만 끈다 (예전처럼 앱 연결은 손대지 않음 — 시험·로컬 전용)
//   - 주소 바꾸기 = GitOps 값 database.activeWriter 커밋 (차트가 이 값으로 앱 DB 주소·비밀을 고른다) + 붙잡기 프록시(APP_LINK_URLS)가 있으면 빠른 길로 같이
//   - Terraform 이 앱을 띄우는 도착(ECS·Cloud Run·VM)은 db_writer_json 을 바꿔 다시 apply (db-writer.ts, switchRuntimeWriter)
//   - 바꿀 길이 없으면 컷오버는 울타리 치기 전에 멈춘다 (APP_LINK_UNAVAILABLE). 경로가 없으면 사전 점검 PC-APPLINK-PATH block
export const appLinkOn = (env: NodeJS.ProcessEnv = process.env) => env.APP_LINK !== "0";
/** 앱 DB 주소를 바꿀 수단. none 이면 켜져 있어도 바꿀 길이 없다 */
export function appLinkMeans(env: NodeJS.ProcessEnv = process.env): { on: boolean; proxy: boolean; gitops: boolean } {
  return { on: appLinkOn(env), proxy: !!appLinkFromEnv(env), gitops: !!configFromEnv(env) };
}

/** 끝점 두 개를 보고 "쓰기 대상 → 프록시 upstream 이름"을 정한다 */
export function appLinkHooks(ends: { source: Endpoint; target: Endpoint }, env: NodeJS.ProcessEnv = process.env): HoldHooks | null {
  const cfg = appLinkFromEnv(env);
  if (!cfg) return null;
  return holdHooks(cfg, (w) => (w.adminUrl === ends.target.adminUrl ? "target" : w.adminUrl === ends.source.adminUrl ? "source" : w.label));
}

/** 감사 detail·측정값용 요약 */
export function appLinkMeasurements(rep: AppLinkReport | undefined, migrationId: string, env: string) {
  if (!rep) return [];
  const at = new Date().toISOString();
  const m = (name: string, value: number, unit: "ms" | "count") => ({ migrationId, name, value, unit, env, at });
  return [
    ...(rep.pause ? [m("app_link_pause_ms", rep.pause.ms, "ms"), m("app_link_closed_idle", rep.pause.closedIdle, "count"), m("app_link_drained_busy", rep.pause.drainedBusy, "count")] : []),
    ...(rep.resume ? [m("app_link_resume_ms", rep.resume.ms, "ms"), m("app_link_released", rep.resume.released, "count"), m("app_link_max_wait_ms", rep.resume.maxWaitMs, "ms")] : []),
    m("app_link_resume_failed", rep.resumeFailed ? 1 : 0, "count"),
  ];
}

/** 도착 환경 묶음 위치 (gitops 설정이 없으면 null). shift.ts 의 load 와 같은 방식 */
export async function targetBundle(tx: Tx, tenantId: string, m: { id: string; targetEnvId: string }): Promise<BundleRef | null> {
  if (!configFromEnv()) return null;
  const app = await latestAcceptedAppName(tx, m.id);
  const e = await tx.query("SELECT provider FROM environments WHERE id=$1", [m.targetEnvId]);
  if (!app || !e.rows[0]) return null;
  return { tenant: tenantSlug(tenantId), app, env: ENV_DIR[e.rows[0].provider as Provider] };
}

/** APP-22 (가): 컷오버를 울타리 치기 전에 멈춰야 하나 (도착 앱 DB 주소를 바꿀 길이 없음). 멈출 이유 글자, 아니면 null */
export function cutoverAppLinkBlock(i: { on: boolean; proxy: boolean; appKind: "gitops" | "no_app" | "terraform_runtime"; bundle: boolean; runtimeReady?: boolean }): string | null {
  if (!i.on || i.proxy || i.appKind === "no_app") return null;
  // Terraform 실행 방식: apply 가 남긴 출발 경로(db-writer.json)와 다시 apply 할 입력이 있어야 db_writer_json 을 바꿔 다시 apply 할 수 있다
  if (i.appKind === "terraform_runtime") return i.runtimeReady ? null
    : "app DB address cannot be switched at cutover: terraform runtime target without the source DB link state (db-writer.json) or the approved plan to re-apply";
  return i.bundle ? null : "app DB address cannot be switched at cutover: no GitOps bundle (GITOPS_REPO_URL/DIR) and no hold proxy (APP_LINK_URLS)";
}

/** GitOps 값 database.activeWriter 기록. 실패해도 컷오버는 되돌리지 않는다 (DB 는 이미 바뀜) → lag 로 남긴다 */
// APP-22 (가): 이 커밋이 도착 앱 DB 주소를 바꾸는 길이라 한 번 실패로 끝내지 않는다 (push 경합·일시 오류). 3번까지
export async function recordActiveWriter(bundle: BundleRef | null, writer: Writer, tries = 3): Promise<{ commit?: string; skipped?: string; error?: string; attempts?: number }> {
  let last: { commit?: string; skipped?: string; error?: string } = {};
  for (let i = 1; i <= Math.max(1, tries); i++) {
    last = await recordOnce(bundle, writer);
    if (!last.error) return i > 1 ? { ...last, attempts: i } : last;
    if (i < tries) await new Promise((r) => setTimeout(r, 200 * i));
  }
  return { ...last, attempts: tries };
}
async function recordOnce(bundle: BundleRef | null, writer: Writer): Promise<{ commit?: string; skipped?: string; error?: string }> {
  const cfg = configFromEnv();
  if (!cfg || !bundle) return { skipped: "no_gitops" };
  try {
    const repo = new GitopsRepo(cfg);
    const plan = await repo.readPlan(bundle);
    const values = await repo.readValues(bundle);
    // Z66 제안: DB 없는 앱(database 칸 없음·null)은 기록하지 않는다. mode 없는 database 를 만들면 차트가 DB 칸을 잘못 그릴 수 있다
    const raw = (values as Record<string, unknown>).database;
    if (raw == null) return { skipped: "no_database" };
    const db = raw as Record<string, unknown>;
    const prev = (db.activeWriter as string | undefined) ?? "source";
    if (prev === writer) return { skipped: "unchanged" };
    // commitBundle 의 kind 는 deploy|traffic 둘뿐이라 traffic 으로 남긴다 (DB 쓰기 대상도 트래픽 전환의 한 조각)
    const c = await repo.commitBundle("traffic", bundle, { ...values, database: { ...db, activeWriter: writer } } as typeof values, plan, `db writer ${prev} -> ${writer}`);
    return { commit: c.commit };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 200) };
  }
}

/** APP-22 (가) DECISION(team): Terraform 이 앱을 띄우는 도착의 앱 DB 주소를 바꾼다 (db_writer_json active 만 바꿔 다시 apply, 3번까지).
 *  도착 실행 역할(apply 천장)을 빌려 쓴다. 흉내 판(MOCK_IAC=1)은 상태 파일만 바꾼다 */
export async function switchRuntimeWriter(j: { tenantId: string; migrationId: string }, m: MigrationRow, input: RealApplyInput, writer: Writer, tries = 3) {
  const mock = iacMockEnabled();
  return withStepRoles("db_writer", j, m, async (roles) => {
    let last: Awaited<ReturnType<typeof reapplyDbWriter>> | undefined;
    for (let i = 1; i <= Math.max(1, tries); i++) {
      last = await reapplyDbWriter(input, writer, { mock, ...(roles.awsEnv?.target ? { credEnv: roles.awsEnv.target } : {}) });
      if (last.ok || last.failureCode === "APP_LINK_STATE_MISSING") return { ...last, attempts: i };
    }
    return { ...last!, attempts: tries };
  });
}

/** APP-22 (가): 출발 전용 계정 비밀 그릇을 지운다 (이전 끝 정리·도착 지우기). apply 가 남긴 상태가 없으면 건너뜀. 흉내 판은 안 지움 */
export async function dropRuntimeLinkSecret(j: { tenantId: string; migrationId: string }, m: MigrationRow, env: NodeJS.ProcessEnv = process.env):
    Promise<{ skipped?: string; deleted?: string; error?: string }> {
  const st = loadWriterState(env, tenantSlug(j.tenantId), j.migrationId);
  if (!st) return { skipped: "no_db_writer_state" };
  if (iacMockEnabled(env)) return { skipped: "mock" };
  try {
    await withStepRoles("db_writer", j, m, (roles) => deleteLinkSecret(st, roles.awsEnv?.target ? envFor(roles.awsEnv.target, env) : env));
    return { deleted: st.secret };
  } catch (e) { return { error: (e as Error).message.slice(0, 200) }; }
}
