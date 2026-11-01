// Z31 DRAFT(ai): 컷오버(C1 붙잡기 / C6 풀어 주기) 때 앱의 DB 연결을 옮기는 쪽.
// 결정 (10/31, 앱 연결 드레인 TODO(human) → AI 기본값): "붙잡기(hold) 프록시 + GitOps 값 기록"
//   1. 빠른 길 (밀리초): 앱 DB 주소 = 붙잡기 프록시. C1 에 붙잡고, C6 에 도착으로 풀어 준다. 앱 재배포 없음
//   2. 오래가는 길 (커밋): 컷오버가 끝나면 GitOps 값 database.activeWriter 를 target 으로 남긴다.
//      프록시가 재시작해도(파드 교체) 도착을 본다. resume 이 끝내 실패한 경우 이게 복구 길이다
// 상태기계 22상태는 그대로. cutover 상태 안의 C1·C6 서브스텝에서만 일어난다 (계약 변경 없음)
// APP_LINK_URLS 가 없으면 아무것도 안 한다 (지금까지와 같음)
import type { Endpoint } from "@svc/replication";
import { appLinkFromEnv, holdHooks, type AppLinkReport, type HoldHooks } from "@svc/dbproxy";
import { AppSpec, type Provider } from "@svc/contracts";
import { latestAcceptedSpec, type Tx } from "@svc/core";
import { configFromEnv, GitopsRepo, ENV_DIR, tenantSlug, type BundleRef } from "./gitops/index.js";

export type Writer = "source" | "target";

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
  const spec = await latestAcceptedSpec(tx, m.id);
  const e = await tx.query("SELECT provider FROM environments WHERE id=$1", [m.targetEnvId]);
  if (!spec || !e.rows[0]) return null;
  return { tenant: tenantSlug(tenantId), app: AppSpec.parse(spec).app.name, env: ENV_DIR[e.rows[0].provider as Provider] };
}

/** GitOps 값 database.activeWriter 기록. 실패해도 컷오버는 되돌리지 않는다 (DB 는 이미 바뀜) → lag 로 남긴다 */
export async function recordActiveWriter(bundle: BundleRef | null, writer: Writer): Promise<{ commit?: string; skipped?: string; error?: string }> {
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
