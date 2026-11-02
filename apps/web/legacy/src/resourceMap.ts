import type { Provider } from "./types";
// Z83-08: "출발 → 도착 자원 대응표" 화면 타입. 값은 서버 GET /migrations/:id/plan/resources (Z86,
// packages/adapters/src/common/service-map.ts serviceMap) 가 준다.
// Z101: 서버가 없을 때 쓰던 정적 표(staticRows·이름표 복사본)는 지웠다 — 이름표는 서버 한 곳에만 있다.

export type ResourceCategory = "cluster" | "workload" | "database" | "ingress" | "registry" | "secret" | "identity" | "network" | "storage";
export type MoveMethod = "redeploy" | "logical_replication" | "traffic_shift" | "create_new" | "image_copy" | "reuse_existing" | "out_of_scope";
export type PlanStepId = "provision" | "deploy" | "sync" | "shift" | "cutover" | "cleanup";
export type StepState = "todo" | "doing" | "done" | "skipped" | "undone";

export interface ResourceSide { service: string; detail: string | null; tfTypes?: string[] }
export interface ResourceRow {
  category: ResourceCategory; label: string;
  source: ResourceSide | null; target: ResourceSide | null;
  method: MoveMethod; methodLabel: string;
  step: PlanStepId | null; stepState: StepState;
  afterSource: string | null; // 이전 끝난 뒤 출발 쪽은 어떻게 되나
}
export interface PlanResourcesView {
  migrationId: string; status: string;
  source: { envId: string; name: string; provider: Provider };
  target: { envId: string; name: string; provider: Provider };
  specKnown: boolean;
  rows: ResourceRow[];
}

// ---- 아래 이름표는 service-map.ts 와 글자가 같아야 한다 (데모에서 화면·API 가 어긋나지 않게) ----
export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  cluster: "컨테이너 클러스터", workload: "앱(컨테이너)", database: "DB", ingress: "진입(로드 밸런서)", registry: "이미지 저장소",
  secret: "비밀 저장소", identity: "앱 권한(ID)", network: "네트워크", storage: "객체 저장소",
};
