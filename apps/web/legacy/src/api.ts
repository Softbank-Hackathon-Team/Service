import type { PlanResourcesView } from "./resourceMap";
import type { SecurityRegression, SecurityView } from "./security-types";
import type { EnvironmentView, EnvStatus, MigrationCostView, MigrationView, PlanDoc, ResumeResult, TimelineView } from "./types";
import type { LiveTrafficView, TrafficShiftProgress } from "./liveTraffic";
import type { AgentReview } from "./agent-review-types";
import { createClient } from "./http";
import type { DemoSpec } from "./pages/common";

// Z101: GET /migrations/:id/spec 응답 (Z100 z100-04 계약 MigrationSpecView). 받아들인 최신 판 우선, 없으면 AI 초안, 없으면 404.
// complete=false 면 spec 은 일부 칸만 → 빈 칸은 base(예시)로 채우고 화면에 "일부" 라고 쓴다
export interface MigrationSpecView {
  migrationId: string; version: number; createdAt: string; source: "accepted" | "ai_draft";
  complete: boolean; spec: DeepPartial<DemoSpec>; needsReview: string[];
}
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export function specOf(v: MigrationSpecView, base: DemoSpec): { spec: DemoSpec; filled: boolean } {
  const s = v.spec ?? {};
  const spec: DemoSpec = {
    ...base, ...(s as Partial<DemoSpec>),
    app: { ...base.app, ...(s.app ?? {}) },
    service: { ...base.service, ...(s.service ?? {}) } as DemoSpec["service"],
    ingress: { ...base.ingress, ...(s.ingress ?? {}) } as DemoSpec["ingress"],
    ...(s.database || base.database ? { database: { ...base.database, ...(s.database ?? {}) } as DemoSpec["database"] } : {}),
  };
  return { spec, filled: !v.complete };
}
import { createAuth } from "./auth";

// 모든 요청은 /api/... → Vite 프록시 → API 서버. 로그인했으면 Bearer 토큰, 서버가 DEV_AUTH=1 이면 x-dev-tenant 헤더.
// 헤더·오류·다시 시도 규칙은 http.ts 한 곳에 있다
export { HttpError, is404, isApiDown, or404, unwrap } from "./http";

export const DEFAULT_TENANT = "11111111-1111-4111-8111-111111111111";

// 화면이 부르는 앞부분(상수 하나). 서버 쪽 접두사(/api/v1)는 vite.config.ts 프록시가 붙인다.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api";

let tenant = DEFAULT_TENANT;
export function setTenant(t: string) { tenant = t; }

// Z96: 로그인 상태(메모리 토큰 + HttpOnly refresh 쿠키). main.tsx 가 첫 화면 전에 bootstrap 한다
export const auth = createAuth({ base: API_BASE });
// Z104 05: 로그인 토큰을 붙이는 클라이언트는 이것 하나로 만든다. 페이지별 모듈(pages/common.ts·environments/inventory.ts)이
//   createClient 를 따로 부르면서 token·onUnauthorized 를 빠뜨려, 로그인 모드에서 비용·모니터링·보안·환경 페이지가
//   x-dev-tenant 로만 불렀다(로그인 필수 서버면 401). 회사 번호를 읽는 곳만 고를 수 있게 tenant 만 받는다
export const authedClient = (tenantOf: () => string) => createClient({
  base: API_BASE, tenant: tenantOf,
  token: () => auth.accessToken(), onUnauthorized: () => auth.onUnauthorized(),
});
const { get, post, headers } = authedClient(() => tenant);

export const api = {
  health: () => get<{ ok: boolean }>("/healthz"),
  // GET /migrations, GET /environments 가 없는 서버(404)면 화면이 대체 동작을 한다 (App.tsx)
  listMigrations: () => get<MigrationView[] | { items: MigrationView[] }>("/migrations"),
  getMigration: (id: string) => get<MigrationView>(`/migrations/${id}`),
  createMigration: (sourceEnvId: string, targetEnvId: string) =>
    post<{ id: string }>("/migrations", { sourceEnvId, targetEnvId }),
  listEnvironments: () => get<EnvironmentView[] | { items: EnvironmentView[] }>("/environments"),
  envStatus: (id: string) => get<EnvStatus>(`/environments/${id}/status`),
  // B가 만든 계획·승인 경로 4개 (+ 계획 찾기)
  confirmSpec: (id: string) => post<{ id: string }>(`/migrations/${id}/plan`),
  latestPlan: (id: string) => get<PlanDoc>(`/migrations/${id}/plan`),
  getPlan: (planId: string) => get<PlanDoc>(`/plans/${planId}`),
  decide: (planId: string, decision: "approve" | "reject", planHash: string, reason?: string) =>
    post<{ migrationId: string; planId: string; status: string }>(`/plans/${planId}/approvals`,
      reason ? { decision, planHash, reason } : { decision, planHash }),
  start: (id: string) => post<{ id: string }>(`/migrations/${id}/start`),
  // 작업 Z18: 보안 표 (임시 자격·최소 권한·감사 체인·비밀값·런타임)
  security: (id: string) => get<SecurityView>(`/migrations/${id}/security`),
  securityRegression: (id: string) => get<SecurityRegression>(`/migrations/${id}/security/regression`),
  // Z91: 지금 출발·도착 실제 점검 + 감사 기록 (보안 회귀 비교의 재료)
  securityCheck: (id: string) => post<import("./security-types").LiveCheckResult>(`/migrations/${id}/security/check`),
  // 비상 버튼 2개 (apps/api/src/routes/control.ts). 확인 한 번 = 요청 하나 = Idempotency-Key 하나(http.ts가 붙임)
  rollback: (id: string, reason?: string) =>
    post<{ id: string; from: string; status: "rolling_back" }>(`/migrations/${id}/rollback`, reason ? { reason } : {}),
  // manualCleanupConfirmed: failed에서 취소할 때만 (서버 가드 T38)
  cancel: (id: string, reason?: string, manualCleanupConfirmed?: boolean) =>
    post<{ id: string; from: string; status: "cancelled" }>(`/migrations/${id}/cancel`, {
      ...(reason ? { reason } : {}), ...(manualCleanupConfirmed ? { manualCleanupConfirmed } : {}),
    }),
  // 작업 Z2: 출발 vs 도착 월 비용 비교 (저장된 추정, 없으면 서버가 미리보기 계산)
  migrationCost: (id: string) => get<MigrationCostView>(`/migrations/${id}/cost`),
  // 작업 Z35: 이전 동안 앱 요청 수·실패·p95 (앱 앞 프록시가 센 값)
  liveTraffic: (id: string) => get<LiveTrafficView>(`/migrations/${id}/live-traffic`),
  // 작업 Z58: AI 점검 결과 (데모 S7). remediate 기록이 없으면 서버가 STUB 대본 결과를 source="stub" 으로 준다
  agentReview: (id: string) => get<AgentReview>(`/migrations/${id}/agent-review`),
  // Z83-08: 계획서의 출발→도착 자원 대응표 (GET /migrations/:id/plan/resources, Z86). 404 면 화면이 정적 표로 떨어진다
  planResources: (id: string) => get<PlanResourcesView>(`/migrations/${id}/plan/resources`),
  // Z83-05: AI 장애 점검 실행 (POST /migrations/:id/agent-review/run). task 는 선택(2000자까지). 상태 머신은 안 바꾼다
  // Z90: kind "spec_draft" 면 명세 초안 다시 만들기. 키 없으면 409 LLM_KEY_MISSING
  agentRun: (id: string, task?: string, kind: "remediate" | "spec_draft" = "remediate") =>
    post<{ runId: string; migrationId: string; kind: "remediate" | "spec_draft"; status: "queued" }>(`/migrations/${id}/agent-review/run`,
      { ...(kind === "spec_draft" ? { kind } : {}), ...(task && kind === "remediate" ? { task } : {}) }),
  // Z83: 트래픽 전환 실측 (GET /migrations/:id/traffic-shift, Z75 z75-38)
  trafficShift: (id: string) => get<TrafficShiftProgress>(`/migrations/${id}/traffic-shift`),
  // Z101: 이전의 최신 명세 (GET /migrations/:id/spec, Z100 z100-04). 비용 "조건 바꿔 보기"가 고정 예시 대신 이 값에서 시작한다
  migrationSpec: (id: string) => get<MigrationSpecView>(`/migrations/${id}/spec`),
  // Z101: 온프레 Agent 보고 (Z92 GET /environments/:id/agent-reports)
  agentReports: (envId: string, limit = 20) =>
    get<import("./pages/environments/AgentReports").AgentReportList>(`/environments/${envId}/agent-reports?limit=${limit}`),
  // Z83: 감사 기록으로 만든 상태 전이 타임라인 (GET /migrations/:id/timeline)
  timeline: (id: string) => get<TimelineView>(`/migrations/${id}/timeline`),
  // Z83: paused → 멈추기 전 단계로 이어 가기 (POST /migrations/:id/resume). ruleCleared 는 규칙으로 멈춘 경우(failureCode 없음)만 뜻이 있다
  resume: (id: string, reason?: string, ruleCleared?: boolean) =>
    post<ResumeResult>(`/migrations/${id}/resume`, { ...(reason ? { reason } : {}), ...(ruleCleared ? { ruleCleared } : {}) }),
  // Z83: 증적 리포트 HTML (GET /migrations/:id/report?format=html). 회사 헤더가 필요해 링크 대신 받아서 새 탭에 연다
  reportHtml: async (id: string): Promise<string> => {
    const once = async () => fetch(`${API_BASE}/migrations/${id}/report?format=html`, { headers: await headers(), credentials: "same-origin" });
    let res = await once();
    // Z104 05: 토큰 만료 직후면 refresh 한 번 뒤 같은 요청을 다시 (예전엔 refresh 만 하고 "HTTP 401" 로 끝났다)
    if (res.status === 401 && await auth.onUnauthorized()) res = await once();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
};

// 브라우저 저장소. 사생활 모드 등에서 실패해도 화면은 돈다.
export const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* 무시 */ } },
};
