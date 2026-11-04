import { get, runJson, runText, type CliDeps } from "../common/cli.js";
import { gcpEnvFor } from "../verify/gcp.js";

// 이전 중 도착 GKE 업그레이드 멈춤 (maintenance exclusion, scope no_upgrades).
//   이전이 시작되면 freeze, 끝 상태(completed·rolled_back·cancelled)에 들어가면 release. 오케스트레이터가 부른다.
//   빌린 도착 실행 SA 토큰(bearer)만 쓴다 (워커 자기 gcloud 자격은 gcpEnvFor 가 지움). 셸 없음.
//   멱등: freeze 는 같은 이름이 이미 있으면 건너뛰고, release 는 없으면 건너뛴다 → 재시도·두 번 불러도 안전
// DRAFT(ai): 제외 이름 = "mig-" + 이전 번호 앞 12글자(하이픈 뺌). 회사 사이에 겹치지 않게 이전 번호에서 뽑는다. GKE 이름 규칙(소문자·숫자·하이픈) 안
// DRAFT(ai): 기본 길이 72시간. 이전이 그보다 길어지면 다시 freeze 를 부르면 같은 이름이라 건너뛴다 → 늘리기는 아직 없음 【미확인: 연장 필요 여부】
//   no_upgrades 범위는 GKE 상한 30일(720시간)을 넘지 못한다
// 【미확인】 실클라우드로 add/remove 를 돌려 보지 못함 (클라우드 스레드는 자원 변경 금지). 맥 실측에서 확인할 것

export const FREEZE_DEFAULT_HOURS = 72;
export const FREEZE_MAX_HOURS = 720;

export interface GkeFreezeTarget {
  projectId: string;
  /** 클러스터 위치 (zone 또는 region). gcloud --location */
  location: string;
  cluster: string;
  migrationId: string;
  token: string;
}
export type GkeFreezeResult =
  | { done: "added" | "removed"; name: string }
  | { done: "already" | "absent"; name: string };

const NAME_RE = /^[a-z0-9-]{1,63}$/;
export function freezeExclusionName(migrationId: string): string {
  const id = migrationId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!id) throw new Error("이전 번호가 비었다");
  return `mig-${id}`;
}

function checkTarget(t: GkeFreezeTarget) {
  for (const [k, v] of [["projectId", t.projectId], ["location", t.location], ["cluster", t.cluster]] as const)
    if (!NAME_RE.test(v)) throw new Error(`${k} 모양이 아님`);
  if (!t.token) throw new Error("빌린 토큰이 없다");
}

const base = (t: GkeFreezeTarget) => ["container", "clusters", "update", t.cluster, `--location=${t.location}`, `--project=${t.projectId}`, "--quiet"];

/** 순수: freeze 명령 인자. 시작 = now, 끝 = now + hours */
export function freezeArgs(t: Omit<GkeFreezeTarget, "token">, now: Date, hours = FREEZE_DEFAULT_HOURS): string[] {
  if (!Number.isInteger(hours) || hours < 1 || hours > FREEZE_MAX_HOURS) throw new Error(`hours 는 1~${FREEZE_MAX_HOURS}`);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [...base({ ...t, token: "x" }),
    `--add-maintenance-exclusion-name=${freezeExclusionName(t.migrationId)}`,
    `--add-maintenance-exclusion-start=${iso(now)}`,
    `--add-maintenance-exclusion-end=${iso(new Date(now.getTime() + hours * 3_600_000))}`,
    "--add-maintenance-exclusion-scope=no_upgrades"];
}

/** 순수: release 명령 인자 */
export function releaseArgs(t: Omit<GkeFreezeTarget, "token">): string[] {
  return [...base({ ...t, token: "x" }), `--remove-maintenance-exclusion=${freezeExclusionName(t.migrationId)}`];
}

async function hasExclusion(d: CliDeps, t: GkeFreezeTarget, env: NodeJS.ProcessEnv): Promise<boolean> {
  const j = await runJson({ ...d, env }, "gcloud", ["container", "clusters", "describe", t.cluster, `--location=${t.location}`,
    `--project=${t.projectId}`, "--format=json(maintenancePolicy)"]);
  const ex = get(j, "maintenancePolicy", "window", "maintenanceExclusions");
  return !!ex && typeof ex === "object" && Object.prototype.hasOwnProperty.call(ex, freezeExclusionName(t.migrationId));
}

export async function freezeGkeUpgrades(d: CliDeps, t: GkeFreezeTarget, now = new Date(), hours = FREEZE_DEFAULT_HOURS): Promise<GkeFreezeResult> {
  checkTarget(t);
  const name = freezeExclusionName(t.migrationId);
  const env = gcpEnvFor(t.token, t.projectId, d.env ?? process.env);
  if (await hasExclusion(d, t, env)) return { done: "already", name };
  await runText({ ...d, env }, "gcloud", freezeArgs(t, now, hours));
  return { done: "added", name };
}

export async function releaseGkeUpgrades(d: CliDeps, t: GkeFreezeTarget): Promise<GkeFreezeResult> {
  checkTarget(t);
  const name = freezeExclusionName(t.migrationId);
  const env = gcpEnvFor(t.token, t.projectId, d.env ?? process.env);
  if (!(await hasExclusion(d, t, env))) return { done: "absent", name };
  await runText({ ...d, env }, "gcloud", releaseArgs(t));
  return { done: "removed", name };
}
