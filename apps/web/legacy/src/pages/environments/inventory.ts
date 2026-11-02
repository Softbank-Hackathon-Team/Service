// 표시 메모: 화면 없음. 환경 인벤토리 호출과 표시 이름표(자원 상태 10개, 근거 6개, 단계 4개, 읽은 곳 5개).
import { authedClient, DEFAULT_TENANT, store } from "../../api";
import type { EnvStatus, Provider } from "../../types";
import type { ResourceCategory } from "../../resourceMap";

// Z86: GET /environments/:id/inventory (apps/api/src/routes/env-inventory.ts EnvResources 를 손으로 옮긴 것)
// api.ts(Z83 담당)를 고치지 않으려고 Z85 pages/common.ts 처럼 같은 http.ts 클라이언트를 여기서 만든다 (회사 헤더·재시도 규칙 그대로)
const { get } = authedClient(() => store.get("web.tenant") || DEFAULT_TENANT);   // Z104 05: 로그인 토큰 포함

export interface InventoryItem { name: string; status: string | null; detail: string | null }
export interface InventoryGroup { category: ResourceCategory; service: string; items: InventoryItem[]; error: string | null }
export interface CloudInventory {
  provider: Provider;
  status: "ok" | "partial" | "unavailable";
  reason: string | null;
  source: "aws-cli" | "gcloud" | "kubectl" | "azure-mock" | "none";
  scope: string | null; region: string | null; checkedAt: string; elapsedMs: number;
  groups: InventoryGroup[];
}

export type FootprintCategory = "compute" | "database" | "identity" | "secret" | "network" | "replication";
export type FootprintState = "planned" | "creating" | "running" | "standby" | "stopping" | "stopped" | "removed" | "left" | "none" | "unknown";
export type Evidence = "runner" | "terraform" | "stub" | "adapter" | "discovered" | "audit";
export interface FootprintResource { category: FootprintCategory; type: string; label: string; state: FootprintState; evidence: Evidence }
export interface AppFootprint {
  migrationId: string;
  role: "source" | "target";
  peer: { envId: string; name: string; provider: Provider };
  migrationStatus: string;
  updatedAt: string;
  stage: "before" | "changing" | "after" | "undone";
  trafficPct: number | null;
  spec: { app: string; image: string; replicas: number; cpu: string; memory: string; port: number; hostname: string; secrets: number;
    database: { engine: string; majorVersion: string; storageGb: number } | null } | null;
  resources: FootprintResource[];
}
export interface EnvInventory {
  envId: string; name: string; provider: Provider; generatedAt: string;
  cloud: CloudInventory;
  base: EnvStatus;
  apps: AppFootprint[];
  totals: { running: number; changing: number; planned: number; gone: number };
}

export const inventoryApi = {
  get: (envId: string) => get<EnvInventory>(`/environments/${envId}/inventory`),
};

// ---- 화면 글자 ----

export const STATE_LABEL: Record<FootprintState, string> = {
  planned: "만들 예정", creating: "만드는 중", running: "돌고 있음", standby: "대기 (트래픽 0·쓰기 막힘)", stopping: "걷는 중",
  stopped: "0개로 줄임", removed: "걷음", left: "남아 있음 (정리 확인)", none: "안 만듦", unknown: "모름",
};
export const STATE_TONE: Record<FootprintState, "ok" | "run" | "wait" | "bad" | "off"> = {
  planned: "off", creating: "run", running: "ok", standby: "wait", stopping: "run", stopped: "off", removed: "off", left: "wait", none: "off", unknown: "bad",
};
export const STATE_MARK: Record<FootprintState, string> = {
  planned: "○", creating: "◐", running: "●", standby: "◐", stopping: "◐", stopped: "–", removed: "–", left: "!", none: "–", unknown: "?",
};
export const EVIDENCE_LABEL: Record<Evidence, string> = {
  runner: "Mock 실행기 결과", terraform: "terraform 실행 기록", stub: "흉내 실행(만든 척)", adapter: "어댑터 설계표 (아직 안 만듦)",
  discovered: "가져온 원본 (지금은 데모 원본)", audit: "감사 기록",
};
export const STAGE_LABEL: Record<AppFootprint["stage"], string> = { before: "이전 전", changing: "이전 중", after: "이전 끝", undone: "되돌림·취소·실패" };
export const SOURCE_LABEL: Record<CloudInventory["source"], string> = {
  "aws-cli": "aws CLI (읽기 명령만)", gcloud: "gcloud (읽기 명령만)", kubectl: "kubectl (읽기 명령만)", "azure-mock": "Azure Mock 실행기", none: "읽지 않음",
};
export const CATEGORY_ORDER: ResourceCategory[] = ["cluster", "workload", "database", "ingress", "network", "registry", "secret", "identity", "storage"];
