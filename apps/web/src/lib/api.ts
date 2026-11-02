import type { AgentReview } from './agent-review-types';
import { createAuth } from './auth';
import { createClient, unwrap } from './http';
import type { LiveTrafficView, TrafficShiftProgress } from './liveTraffic';
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
import type { MigrationSpec, MigrationSpecView } from '../features/migration/model';

// 화면은 /api/... 만 부른다. 개발은 Vite, 운영은 nginx 가 서버 경로로 넘긴다.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export const auth = createAuth({ base: API_BASE });

const { get, post, headers } = createClient({
  base: API_BASE,
  token: () => auth.accessToken(),
  onUnauthorized: () => auth.onUnauthorized(),
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
  migrationSpec: (id: string) => get<MigrationSpecView>(`/migrations/${id}/spec`),
  confirmSpec: (id: string) => post<{ id: string }>(`/migrations/${id}/plan`),
  latestPlan: (id: string) => get<PlanDoc>(`/migrations/${id}/plan`),
  planResources: (id: string) => get<PlanResourcesView>(`/migrations/${id}/plan/resources`),
  migrationCost: (id: string) => get<MigrationCostView>(`/migrations/${id}/cost`),
  timeline: (id: string) => get<TimelineView>(`/migrations/${id}/timeline`),
  decide: (planId: string, decision: 'approve' | 'reject', planHash: string) =>
    post<{ status: string }>(`/plans/${planId}/approvals`, { decision, planHash }),
  start: (id: string) => post<{ id: string }>(`/migrations/${id}/start`),
  cancel: (id: string, manualCleanupConfirmed?: boolean) =>
    post<{ status: 'cancelled' }>(`/migrations/${id}/cancel`, manualCleanupConfirmed ? { manualCleanupConfirmed } : {}),
  rollback: (id: string) => post<{ status: 'rolling_back' }>(`/migrations/${id}/rollback`, {}),
  // 서버 main 에는 아직 이 경로가 없다 (리소스 회수, README "서버에 없어서" 참고). 목업만 응답한다
  reclaim: (id: string) => post<{ status: 'rollback_window' }>(`/migrations/${id}/reclaim`, {}),
  resume: (id: string, ruleCleared?: boolean) =>
    post<ResumeResult>(`/migrations/${id}/resume`, ruleCleared ? { ruleCleared } : {}),
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
