import type { AgentReview } from './agent-review-types';
import { createAuth } from './auth';
import { createClient, unwrap } from './http';
import type { LiveTrafficView, TrafficShiftProgress } from './liveTraffic';
import type { RehearsalView } from './rehearsal-types';
import type { PlanResourcesView } from './resourceMap';
import type { LiveCheckResult, SecurityRegression, SecurityView } from './security-types';
import type {
  AgentReportList,
  EnvApp,
  EnvironmentView,
  EnvStatus,
  EvidenceReport,
  FullEstimate,
  MigrationCostView,
  MigrationView,
  PlanDoc,
  Provider,
  ResumeResult,
  TimelineView,
} from './types';
import type { CloudInventory } from '../features/dashboard/model';
import type { MigrationSpec } from '../features/migration/model';
import type { MigrationSpecViewV2, SpecPatch } from '../features/migration/specV2';

// 화면은 /api/... 만 부른다. 개발은 Vite, 운영은 nginx 가 서버 경로로 넘긴다.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export const auth = createAuth({ base: API_BASE });

const { get, post, patch, headers } = createClient({
  base: API_BASE,
  token: () => auth.accessToken(),
  onUnauthorized: (code) => auth.onUnauthorized(code),
});

export const api = {
  listEnvironments: async () => unwrap(await get<EnvironmentView[] | { items: EnvironmentView[] }>('/environments')),
  listMigrations: async () => unwrap(await get<MigrationView[] | { items: MigrationView[] }>('/migrations')),
  envStatus: (id: string) => get<EnvStatus>(`/environments/${id}/status`),
  envInventory: (id: string) => get<{ cloud: CloudInventory; apps: EnvApp[] }>(`/environments/${id}/inventory`),
  agentReports: (id: string, limit = 20) => get<AgentReportList>(`/environments/${id}/agent-reports?limit=${limit}`),
  security: (id: string) => get<SecurityView>(`/migrations/${id}/security`),
  securityRegression: (id: string) => get<SecurityRegression>(`/migrations/${id}/security/regression`),
  securityCheck: (id: string) => post<LiveCheckResult>(`/migrations/${id}/security/check`),
  report: (id: string) => get<EvidenceReport>(`/migrations/${id}/report`),
  estimate: (body: { spec: MigrationSpec; from?: Provider; targets: Provider[]; traffic: { peakRps: number }; profile: 'startup' | 'finance'; applyCredits: boolean }) =>
    post<FullEstimate>('/cost/estimate', body),
  health: () => get<{ ok: boolean }>('/healthz'),
  ready: () => get<{ ok: boolean }>('/readyz'),
  getMigration: (id: string) => get<MigrationView>(`/migrations/${id}`),
  createMigration: (sourceEnvId: string, targetEnvId: string) => post<{ id: string }>('/migrations', { sourceEnvId, targetEnvId }),
  migrationSpec: (id: string) => get<MigrationSpecViewV2>(`/migrations/${id}/spec`),
  /** 명세 칸 확인·끌어오기. 결과는 늘 새 판 하나. baseVersion 이 지금 판이 아니면 409 SPEC_VERSION_CONFLICT */
  patchSpec: (id: string, body: SpecPatch) => patch<MigrationSpecViewV2>(`/migrations/${id}/spec`, body),
  /** 명세 확정 → 사전 점검 시작 (T04: 검토 칸이 남아 있으면 409) */
  confirmSpec: (id: string) => post<{ id: string }>(`/migrations/${id}/plan`),
  /** 계획 다시 만들기: failed(planning·provisioning)·stale·rejected → planning. 재시도 한도를 넘었으면 acceptCustomerCost 필요 */
  replan: (id: string, acceptCustomerCost?: boolean) =>
    post<{ id: string }>(`/migrations/${id}/replan`, acceptCustomerCost ? { acceptCustomerCost } : {}),
  /** 거절 뒤 명세부터 다시 고치기: rejected → spec_review */
  reopenSpec: (id: string) => post<{ id: string }>(`/migrations/${id}/spec/reopen`),
  latestPlan: (id: string) => get<PlanDoc>(`/migrations/${id}/plan`),
  /** deploying 안 vCluster 리허설의 지금 줄. 줄이 아직 없으면 run: null */
  rehearsal: (id: string) => get<RehearsalView>(`/migrations/${id}/rehearsal`),
  planResources: (id: string) => get<PlanResourcesView>(`/migrations/${id}/plan/resources`),
  migrationCost: (id: string) => get<MigrationCostView>(`/migrations/${id}/cost`),
  timeline: (id: string) => get<TimelineView>(`/migrations/${id}/timeline`),
  // 승인 때는 확인 항목(acks)을 언제나 보낸다. 서버는 PLAN_ACKS=1 일 때만 다 덮었는지 본다. 거절은 acks 를 안 본다
  decide: (planId: string, decision: 'approve' | 'reject', planHash: string, acks?: string[]) =>
    post<{ status: string }>(`/plans/${planId}/approvals`, { decision, planHash, ...(decision === 'approve' && acks ? { acks } : {}) }),
  // 실행 시작에 승인한 계획 지문을 싣는다 (PLAN_ACKS=1 이면 서버가 승인 지문과 비교)
  start: (id: string, planHash?: string) => post<{ id: string }>(`/migrations/${id}/start`, planHash ? { planHash } : {}),
  cancel: (id: string, manualCleanupConfirmed?: boolean) =>
    post<{ status: 'cancelled' }>(`/migrations/${id}/cancel`, manualCleanupConfirmed ? { manualCleanupConfirmed } : {}),
  rollback: (id: string) => post<{ status: 'rolling_back' }>(`/migrations/${id}/rollback`, {}),
  // 서버 main 에는 아직 이 경로가 없다 (리소스 회수, README "서버에 없어서" 참고). 목업만 응답한다
  reclaim: (id: string) => post<{ status: 'rollback_window' }>(`/migrations/${id}/reclaim`, {}),
  resume: (id: string, ruleCleared?: boolean, acceptCustomerCost?: boolean) =>
    post<ResumeResult>(`/migrations/${id}/resume`, { ...(ruleCleared ? { ruleCleared } : {}), ...(acceptCustomerCost ? { acceptCustomerCost } : {}) }),
  liveTraffic: (id: string) => get<LiveTrafficView>(`/migrations/${id}/live-traffic`),
  trafficShift: (id: string) => get<TrafficShiftProgress>(`/migrations/${id}/traffic-shift`),
  agentReview: (id: string) => get<AgentReview>(`/migrations/${id}/agent-review`),
  agentRun: (id: string, task?: string, kind: 'remediate' | 'spec_draft' = 'remediate') =>
    post<{ runId: string }>(`/migrations/${id}/agent-review/run`, {
      ...(kind === 'spec_draft' ? { kind } : {}),
      ...(task && kind === 'remediate' ? { task } : {}),
    }),
  /** 회사 헤더가 필요해 링크로 못 열어서 받아 온다. */
  reportHtml: async (id: string) => {
    const once = async () => fetch(`${API_BASE}/migrations/${id}/report?format=html`, { headers: await headers(), credentials: 'same-origin' });
    let response = await once();
    if (response.status === 401 && (await auth.onUnauthorized())) response = await once();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
};
