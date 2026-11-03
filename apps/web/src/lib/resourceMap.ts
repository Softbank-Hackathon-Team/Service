import type { Provider } from "./types";
// Z83-08: "출발 → 도착 자원 대응표" 화면 타입. 값은 서버 GET /migrations/:id/plan/resources (Z86,
// apps/api env-inventory.ts PlanResources, packages/adapters service-map.ts · service-map-v2.ts) 가 준다.
// Z101: 서버가 없을 때 쓰던 정적 표(staticRows·이름표 복사본)는 지웠다 — 이름표는 서버 한 곳에만 있다.
// MAPV2: 명세가 v2 면 irVersion "2" 이고, 캐시·큐·경계 밖 줄과 같은 칸의 여러 줄(앱마다 한 줄 등)이 온다.

export type ResourceCategory =
  | "cluster" | "workload" | "database" | "ingress" | "registry" | "secret" | "identity" | "network" | "storage"
  | "cache" | "queue" | "boundary";
export type MoveMethod = "redeploy" | "logical_replication" | "traffic_shift" | "create_new" | "image_copy" | "reuse_existing" | "out_of_scope";
export type PlanStepId = "provision" | "deploy" | "sync" | "shift" | "cutover" | "cleanup";
export type StepState = "todo" | "doing" | "done" | "skipped" | "undone";
export type TargetRuntime = "k8s" | "managedContainer" | "vm";

export interface ResourceSide { service: string; detail: string | null; tfTypes?: string[] }
export interface ResourceRow {
  category: ResourceCategory; label: string;
  source: ResourceSide | null; target: ResourceSide | null;
  method: MoveMethod; methodLabel: string;
  step: PlanStepId | null; stepState: StepState;
  afterSource: string | null; // 이전 끝난 뒤 출발 쪽은 어떻게 되나
  // v2 판에서 사람이 도착 실행 방식을 출발과 다르게 바꾼 앱 줄만 (v1 판엔 키가 없다)
  runtimeChange?: { from: string; to: TargetRuntime } | null;
}
export interface PlanResourcesView {
  migrationId: string; status: string;
  source: { envId: string; name: string; provider: Provider };
  target: { envId: string; name: string; provider: Provider };
  specKnown: boolean;
  irVersion?: "2";
  rows: ResourceRow[];
}

// ---- 아래 이름표는 service-map.ts · service-map-v2.ts 와 글자가 같아야 한다 (데모에서 화면·API 가 어긋나지 않게) ----
export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  cluster: "컨테이너 클러스터", workload: "앱(컨테이너)", database: "DB", ingress: "진입(로드 밸런서)", registry: "이미지 저장소",
  secret: "비밀 저장소", identity: "앱 권한(ID)", network: "네트워크", storage: "객체 저장소",
  cache: "캐시", queue: "큐·토픽", boundary: "경계 밖 자원",
};

// 출발 원래 실행 모양(contracts OriginV2.runtime)과 도착 실행 방식 이름
const RUNTIME_LABEL: Record<string, string> = {
  k8s: "쿠버네티스", managedContainer: "관리형 컨테이너", vm: "VM", paas: "PaaS", source: "소스 빌드",
};

/** "실행 방식 바뀜" 한 줄. 바뀐 줄이 아니면 null. */
export const runtimeChangeNote = (row: Pick<ResourceRow, "runtimeChange">): string | null =>
  row.runtimeChange ? `실행 방식 바뀜: ${RUNTIME_LABEL[row.runtimeChange.from] ?? row.runtimeChange.from} → ${RUNTIME_LABEL[row.runtimeChange.to] ?? row.runtimeChange.to}` : null;

/**
 * 계획 화면의 "자원 대응" 카드에 쓸 줄. 옮기지 않는 줄(out_of_scope)은 빼고, 머리줄 건수는 실제로 그린 줄 수다.
 * 경계 밖 줄은 옮기는 자원이 아니라 "출발에 그대로 두는 것" 안내라 표에서 빼서 따로 한 줄로 쓴다.
 * 같은 칸이 여러 줄일 수 있어(앱마다 한 줄) 줄 열쇠는 칸 이름이 아니라 순서까지 넣는다.
 */
export function planResourceRows(view: Pick<PlanResourcesView, "rows"> | null | undefined) {
  const rows = view?.rows ?? [];
  const listed = rows.filter((row) => row.method !== "out_of_scope").map((row, index) => ({ key: `${index}:${row.category}:${row.label}`, row }));
  const boundary = rows.find((row) => row.category === "boundary") ?? null;
  return { listed, boundary, runtimeChanges: listed.filter(({ row }) => row.runtimeChange).length };
}
