// 개발용 목업. 서버 없이 화면을 보고 만져 보기 위한 파일이다.
//
// 지우는 법: 이 파일만 지우면 된다. main.tsx 의 import.meta.glob 이 빈 결과가 되어 코드 수정 없이 빌드된다.
// 제품 코드는 이 파일을 import 하지 않는다. 이 파일만 제품 코드의 타입을 가져다 쓴다.
//
// 동작: window.fetch 를 감싼다. 아래 ACCOUNT 로 로그인하면 이 탭의 /api/* 를 전부 여기서 응답하고,
// 그 밖의 계정은 실제 서버로 그대로 보낸다. 처리하지 못한 경로는 실제 서버로 흘려보내지 않고 501 을 낸다.
// 화면 신호(SSE, GET /api/events)도 실제 서버와 같은 형식의 스트림으로 답한다 (아래 '화면 신호').
import type { AgentReview, RemediateReview, SpecDraftReview } from './lib/agent-review-types';
import type { AuthUser, TokenResponse } from './lib/auth';
import type { SseEvent } from './lib/events';
import type { LiveTrafficView, TrafficShiftProgress } from './lib/liveTraffic';
import type { PlanResourcesView, ResourceRow } from './lib/resourceMap';
import type { CellState, LedgerRow, LiveSecurityReport, MatrixRow, SecurityRegression, SecurityView } from './lib/security-types';
import type {
  AgentReportList,
  EnvApp,
  EnvEstimate,
  EnvironmentView,
  EnvStatus,
  EvidenceReport,
  Finding,
  FootprintResource,
  FootprintState,
  FullEstimate,
  MigrationCostView,
  MigrationStatus,
  MigrationView,
  PlanDoc,
  Provider,
  TimelineItem,
  TimelineView,
} from './lib/types';
import type { CloudInventory } from './features/dashboard/model';
import type { MigrationSpec, MigrationSpecView } from './features/migration/model';

// ---- 여기만 고치면 되는 값 ----

const ACCOUNT = { email: 'mock@kross.test', password: 'kross-mock-2026' };

/** 단계마다 머무는 시간(ms). 이전 한 건이 롤백 대기 전까지 약 12초에 지나간다. */
const TIMES: Partial<Record<MigrationStatus, number>> = {
  importing: 1500,
  prechecking: 1000,
  planning: 1000,
  provisioning: 1500,
  deploying: 1500,
  syncing: 1500,
  cutover: 1000,
  cleanup: 1000,
  rolling_back: 2000,
};
const SHIFT_STEP_MS = 1500;
const SHIFT_STEPS = [10, 50, 100];
const ROLLBACK_WINDOW_SEC = 15;
const AGENT_RUN_MS = 2000;
const LATENCY_MS = 60;
/** 화면 신호: 처음 보내는 retry 값과 쉬는 동안 주석 줄 간격. 실제 서버(apps/api/src/routes/events.ts)와 같다 */
const SIGNAL_RETRY_MS = 3000;
const SIGNAL_PING_MS = 15_000;

const USER: AuthUser = {
  id: '90000000-0000-4000-8000-000000000001',
  email: ACCOUNT.email,
  displayName: '목업 사용자',
  tenantId: '90000000-0000-4000-8000-000000000002',
  tenantName: '예시 회사',
};

const ENVS: EnvironmentView[] = [
  env('e1', 'aws', 'prod-aws', 'connected'),
  env('e2', 'gcp', 'stage-gcp', 'connected'),
  env('e3', 'onprem', 'idc-seoul', 'connected'),
  env('e4', 'azure_mock', 'azure-lab', 'connected'),
  env('e5', 'aws', 'batch-aws', 'connected'),
  env('e6', 'gcp', 'batch-gcp', 'connected'),
  env('e7', 'onprem', 'dr-busan', 'failed', 'Agent 생존 신호가 30분째 없습니다'),
];

const REGION: Record<Provider, string> = { aws: 'ap-northeast-2', gcp: 'asia-northeast3', onprem: 'seoul-dc1', azure_mock: 'koreacentral' };
const SERVICE: Record<Provider, { cluster: string; db: string; secret: string; ingress: string }> = {
  aws: { cluster: 'EKS', db: 'RDS PostgreSQL', secret: 'Secrets Manager', ingress: 'Cloudflare LB' },
  gcp: { cluster: 'GKE', db: 'Cloud SQL', secret: 'Secret Manager', ingress: 'Cloudflare LB' },
  onprem: { cluster: 'k3s', db: 'CloudNativePG', secret: 'Sealed Secrets', ingress: 'Cloudflare LB' },
  azure_mock: { cluster: 'AKS', db: 'Azure Database', secret: 'Key Vault', ingress: 'Cloudflare LB' },
};

// ---- 상태 ----

type MockMigration = MigrationView & {
  app: string;
  trafficPct: number;
  shiftIndex: number;
  nextAt: number | null;
  log: TimelineItem[];
  approvals: EvidenceReport['approvals'];
  agentDoneAt: number | null;
  agentRan: boolean;
  securityChecked: boolean;
  planExpiresAt: string;
};

type Store = { migrations: MockMigration[]; seq: number };

const STORE_KEY = 'kross.dev-mock';
const realFetch = window.fetch.bind(window);
let store: Store | null = null;
let timer: number | null = null;

function env(id: string, provider: Provider, name: string, connectionStatus: EnvironmentView['connectionStatus'], failureReason: string | null = null): EnvironmentView {
  return {
    id: `00000000-0000-4000-8000-0000000000${id.slice(1).padStart(2, '0')}`,
    provider,
    name,
    connectionStatus,
    accountId: provider === 'onprem' ? null : '111122223333',
    lastVerifiedAt: new Date(Date.now() - 180_000).toISOString(),
    failureReason,
  };
}

const envById = (id: string) => ENVS.find((item) => item.id === id) ?? ENVS[0]!;
const envAt = (index: number) => ENVS[index]!.id;
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* 저장에 실패해도 이 탭에서는 계속 돈다 */
  }
}

// ---- 이전 진행 ----

const WALK: MigrationStatus[] = [
  'draft', 'importing', 'spec_review', 'prechecking', 'planning', 'awaiting_approval', 'approved',
  'provisioning', 'deploying', 'syncing', 'shifting', 'cutover', 'rollback_window', 'cleanup', 'completed',
];
const NEXT: Partial<Record<MigrationStatus, MigrationStatus>> = {
  importing: 'spec_review',
  prechecking: 'planning',
  planning: 'awaiting_approval',
  provisioning: 'deploying',
  deploying: 'syncing',
  syncing: 'shifting',
  cutover: 'rollback_window',
  cleanup: 'completed',
  rolling_back: 'rolled_back',
};
const HOLDS_LOCK: MigrationStatus[] = ['approved', 'provisioning', 'deploying', 'syncing', 'shifting', 'cutover', 'rollback_window', 'cleanup', 'rolling_back', 'paused'];
const CANCELABLE: MigrationStatus[] = ['draft', 'importing', 'spec_review', 'prechecking', 'planning', 'awaiting_approval', 'approved', 'rejected', 'stale', 'failed'];
const ROLLBACKABLE: MigrationStatus[] = ['deploying', 'syncing', 'shifting', 'rollback_window', 'paused'];

function logEntry(m: MockMigration, entry: Partial<TimelineItem> & Pick<TimelineItem, 'kind' | 'action'>, at = nowIso()) {
  store!.seq += 1;
  m.log.push({
    seq: store!.seq, at, actor: 'worker', result: 'ok', from: null, to: null, durationMs: null, failureCode: null,
    requestId: null, measurements: [], detail: {}, ...entry,
  } as TimelineItem);
}

function setStatus(m: MockMigration, to: MigrationStatus, entry: Partial<TimelineItem> = {}) {
  logEntry(m, { kind: 'transition', action: `migration.${to}`, from: m.status, to, ...entry });
  m.status = to;
  m.version += 1;
  m.updatedAt = nowIso();
  m.nextAt = null;
  const ms = TIMES[to];
  if (ms) m.nextAt = Date.now() + ms;
  if (to === 'shifting') {
    m.shiftIndex = 0;
    m.trafficPct = SHIFT_STEPS[0]!;
    m.nextAt = Date.now() + SHIFT_STEP_MS;
  }
  if (to === 'cutover') m.trafficPct = 100;
  if (to === 'rollback_window') {
    m.trafficPct = 100;
    m.rollbackWindowEndsAt = new Date(Date.now() + ROLLBACK_WINDOW_SEC * 1000).toISOString();
    m.nextAt = Date.parse(m.rollbackWindowEndsAt);
  }
  if (to === 'rolling_back') m.rollbackWindowEndsAt = null;
  if (to === 'rolled_back') m.trafficPct = 0;
  if (to === 'awaiting_approval') m.planExpiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  // 실제 서버는 advance() 가 확정될 때마다 알림을 하나 보낸다. 목업은 상태가 바뀌는 곳이 여기 하나뿐이다
  emitSignal({ type: 'migration.status_changed', migrationId: m.id, status: to });
}

function advance(m: MockMigration) {
  if (m.status === 'shifting') {
    if (m.shiftIndex < SHIFT_STEPS.length - 1) {
      m.shiftIndex += 1;
      m.trafficPct = SHIFT_STEPS[m.shiftIndex]!;
      m.updatedAt = nowIso();
      m.nextAt = Date.now() + SHIFT_STEP_MS;
      return;
    }
    setStatus(m, 'cutover');
    return;
  }
  if (m.status === 'rollback_window') {
    setStatus(m, 'cleanup', { detail: { cleanupApproved: true } });
    return;
  }
  const to = NEXT[m.status];
  if (!to) {
    m.nextAt = null;
    return;
  }
  const measurements: TimelineItem['measurements'] =
    to === 'shifting' ? [{ name: 'initial_copy_ms', value: 673, unit: 'ms' }, { name: 'replication_lag_ms', value: 28, unit: 'ms' }]
    : to === 'rollback_window' ? [{ name: 'cutover_pause_ms', value: 168, unit: 'ms' }]
    : [];
  setStatus(m, to, { measurements });
}

function tick() {
  if (!store) return;
  const now = Date.now();
  let changed = false;
  for (const m of store.migrations) {
    if (m.nextAt !== null && m.nextAt <= now) {
      advance(m);
      changed = true;
    }
    if (m.agentDoneAt !== null && m.agentDoneAt <= now) {
      m.agentDoneAt = null;
      m.agentRan = true;
      changed = true;
    }
  }
  if (changed) save();
}

/** 시작 데이터를 만든다. 지나온 칸의 기록까지 채워 감사 화면이 비지 않게 한다. */
function seedMigration(index: number, app: string, source: number, target: number, status: MigrationStatus): MockMigration {
  const m: MockMigration = {
    id: `00000000-0000-4000-9000-0000000000${String(index).padStart(2, '0')}`,
    status: 'draft', version: 1, sourceEnvId: envAt(source), targetEnvId: envAt(target),
    pausedFrom: null, failedAtStatus: null, failureCode: null, rollbackWindowEndsAt: null, updatedAt: nowIso(),
    app, trafficPct: 0, shiftIndex: 0, nextAt: null, log: [], approvals: [], agentDoneAt: null, agentRan: false,
    securityChecked: false, planExpiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
  };
  const stop = WALK.indexOf(status === 'rolled_back' ? 'rollback_window' : status);
  const started = Date.now() - 3600_000 * (index + 1);
  WALK.slice(1, stop + 1).forEach((to, step) => {
    const at = new Date(started + step * 60_000).toISOString();
    logEntry(m, { kind: 'transition', action: `migration.${to}`, from: m.status, to, actor: to === 'prechecking' || to === 'approved' || to === 'provisioning' ? USER.email : 'worker' }, at);
    if (to === 'approved') m.approvals.push({ planId: `plan-${m.id}`, decision: 'approve', approvedBy: USER.email, at, approvedPlanHash: planHash(m), storedPlanHash: planHash(m), hashMatches: true });
    m.status = to;
    m.version += 1;
    m.updatedAt = at;
  });
  if (stop >= WALK.indexOf('shifting')) m.log.at(-1)!.measurements = [{ name: 'replication_lag_ms', value: 28, unit: 'ms' }];
  if (stop >= WALK.indexOf('rollback_window')) m.log.at(-1)!.measurements = [{ name: 'cutover_pause_ms', value: 168, unit: 'ms' }];
  if (status === 'rolled_back') {
    logEntry(m, { kind: 'transition', action: 'migration.rolling_back', from: m.status, to: 'rolling_back', actor: USER.email }, new Date(started + 900_000).toISOString());
    logEntry(m, { kind: 'transition', action: 'migration.rolled_back', from: 'rolling_back', to: 'rolled_back' }, new Date(started + 960_000).toISOString());
    m.status = 'rolled_back';
  }
  m.trafficPct = status === 'completed' ? 100 : 0;
  return m;
}

function freshStore(): Store {
  store = { migrations: [], seq: 0 };
  store.migrations = [
    seedMigration(1, 'shop-api', 0, 1, 'awaiting_approval'),
    seedMigration(2, 'batch-worker', 4, 5, 'syncing'),
    seedMigration(3, 'billing-api', 0, 2, 'completed'),
    seedMigration(4, 'legacy-admin', 3, 2, 'rolled_back'),
  ];
  // 시작하자마자 한 건이 움직이게 해서 대시보드에서 줄 이동을 볼 수 있다
  store.migrations[1]!.nextAt = Date.now() + 2500;
  return store;
}

// ---- 응답 모양 ----

function planHash(m: Pick<MockMigration, 'id'>) {
  return `sha256:7f3a9c1e5b2d8846${m.id.replace(/-/g, '').slice(-16)}`;
}

function planOf(m: MockMigration): PlanDoc {
  return {
    planId: `plan-${m.id}`, migrationId: m.id, adapterVersion: '1.0.0', planHash: planHash(m), tfPlanHash: 'tf-7f3a9c', helmValuesHash: 'helm-5b2d88', expiresAt: m.planExpiresAt,
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    steps: [
      { id: 'provision', owner: 'terraform', estSec: 300 },
      { id: 'deploy', owner: 'argocd', gate: 'synced_healthy' },
      { id: 'sync', owner: 'worker', gate: 'replication_lag_ms < 1000' },
      { id: 'shift', owner: 'worker', weights: SHIFT_STEPS, holdSec: 30 },
      { id: 'cutover', owner: 'worker' },
      { id: 'cleanup', owner: 'worker' },
    ],
    precheck: [
      { id: 'PC-07', level: 'warn', message: '도착 리전의 vCPU 한도가 80%입니다', fix: '한도 증설을 요청해 주세요' },
      { id: 'PC-12', level: 'info', message: '기본 키 없는 표가 없습니다' },
    ],
  };
}

function specOf(m: MockMigration): MigrationSpecView {
  const spec: MigrationSpec = {
    app: { name: m.app },
    service: { image: `ghcr.io/example/${m.app}@sha256:${'ab'.repeat(32)}`, port: 8080, healthPath: '/healthz', replicas: 2, cpu: '500m', memory: '1Gi', secretRefs: [] },
    database: { engine: 'postgres', majorVersion: '16', storageGb: 20 },
    ingress: { hostname: `${m.app}.example.com` },
  };
  return { migrationId: m.id, version: 2, createdAt: m.updatedAt ?? nowIso(), source: 'ai_draft', complete: true, spec, needsReview: ['service.replicas', 'service.cpu'] };
}

function resourcesOf(m: MockMigration): PlanResourcesView {
  const source = envById(m.sourceEnvId);
  const target = envById(m.targetEnvId);
  const from = SERVICE[source.provider];
  const to = SERVICE[target.provider];
  const row = (category: ResourceRow['category'], label: string, a: string, b: string, method: ResourceRow['method'], methodLabel: string, step: ResourceRow['step']): ResourceRow => ({
    category, label, source: { service: a, detail: null }, target: { service: b, detail: null }, method, methodLabel, step, stepState: 'todo', afterSource: null,
  });
  return {
    migrationId: m.id, status: m.status, specKnown: true,
    source: { envId: source.id, name: source.name, provider: source.provider },
    target: { envId: target.id, name: target.name, provider: target.provider },
    rows: [
      row('cluster', '클러스터', from.cluster, to.cluster, 'create_new', '새로 만듦', 'provision'),
      row('workload', '앱', 'Deployment', 'Deployment', 'redeploy', '같은 이미지로 재배포', 'deploy'),
      row('database', 'DB', from.db, to.db, 'logical_replication', '논리 복제', 'sync'),
      row('ingress', '진입', from.ingress, to.ingress, 'traffic_shift', '가중치 전환', 'shift'),
      row('secret', '비밀 저장소', from.secret, to.secret, 'create_new', '새로 만듦', 'provision'),
    ],
  };
}

const NODE_USD: Record<Provider, { cluster: number; node: number; db: number; storage: number; sku: string | null }> = {
  aws: { cluster: 73, node: 61, db: 62, storage: 2.5, sku: 't3.large' },
  gcp: { cluster: 0, node: 49, db: 87, storage: 3.4, sku: 'e2-standard-2' },
  azure_mock: { cluster: 73, node: 45, db: 60, storage: 2.6, sku: 'Standard_B2s' },
  onprem: { cluster: 0, node: 0, db: 0, storage: 0, sku: null },
};

function estimateEnv(provider: Provider, rps: number, profile: 'startup' | 'finance'): EnvEstimate {
  const price = NODE_USD[provider];
  const hardened = profile === 'finance' ? 1.2 : 1;
  const nodes = Math.max(2, Math.ceil(rps / 150));
  const fixed = provider === 'onprem' ? 2660 : 0;
  const parts = { cluster: price.cluster, nodes: Math.round(nodes * price.node * hardened), db: price.db * (hardened > 1 ? 2 : 1), storage: Math.round(20 * price.storage * 10) / 10, fixed };
  const monthlyUsd = Math.round(parts.cluster + parts.nodes + parts.db + parts.storage + parts.fixed);
  return {
    provider, feasible: true, nodeSku: price.sku, nodes: provider === 'onprem' ? 2 : nodes, monthlyUsd, monthlyUsdNoCredit: monthlyUsd, creditUsd: 0, parts,
    unknown: [], unverified: provider === 'onprem' ? ['fixed'] : [],
  };
}

function estimateOf(rps: number, profile: 'startup' | 'finance', targets: Provider[], from?: Provider): FullEstimate {
  const envs = targets.map((provider) => estimateEnv(provider, rps, profile));
  const cheapestOf = (list: EnvEstimate[]) => [...list].sort((a, b) => (a.monthlyUsd ?? 0) - (b.monthlyUsd ?? 0))[0]!.provider;
  const breakpoints: FullEstimate['breakpoints'] = [];
  let last: Provider | null = null;
  for (let at = 1; at <= 8000; at += 50) {
    const winner = cheapestOf(targets.map((provider) => estimateEnv(provider, at, profile)));
    if (winner !== last) {
      if (last !== null) breakpoints.push({ fromRps: at, cheapest: winner, nodes: 2 });
      last = winner;
    }
  }
  const cheapest = cheapestOf(envs);
  const here = from ? envs.find((item) => item.provider === from) : undefined;
  const best = envs.find((item) => item.provider === cheapest)!;
  return {
    priceAsOf: '2026-11-01', priceStale: false, peakRps: rps, requiredVcpu: Math.round(Math.max(1, rps / 150) * 20) / 10, profile, envs, cheapest, breakpoints,
    savings: from && here && from !== cheapest ? { from, to: cheapest, monthlyUsd: (here.monthlyUsd ?? 0) - (best.monthlyUsd ?? 0), creditPortionUsd: 0 } : null,
  };
}

function costOf(m: MockMigration): MigrationCostView {
  const source = envById(m.sourceEnvId);
  const target = envById(m.targetEnvId);
  const providers = [...new Set<Provider>([source.provider, target.provider, 'aws', 'gcp', 'onprem'])];
  const estimate = estimateOf(100, 'startup', providers, source.provider);
  const of = (provider: Provider) => estimate.envs.find((item) => item.provider === provider)?.monthlyUsd ?? null;
  const a = of(source.provider);
  const b = of(target.provider);
  // 명세를 아직 못 읽은 이전은 서버처럼 예시 앱으로 계산한다
  const specFrom = m.status === 'draft' || m.status === 'importing' ? 'demo' as const : 'spec_versions' as const;
  const priceSources: MigrationCostView['priceSources'] = [
    { vendor: 'aws', origin: 'live', fetchedAt: '2026-11-01T03:00:00.000Z', urls: [] },
    { vendor: 'gcp', origin: 'live', fetchedAt: '2026-11-01T03:00:00.000Z', urls: [] },
    { vendor: 'azure_mock', origin: 'sample', fetchedAt: '2026-10-20T00:00:00.000Z', urls: [] },
  ];
  return {
    migrationId: m.id, origin: 'preview', storedId: null, planId: null, specFrom, estimate, priceSources, createdAt: nowIso(),
    source: { id: source.id, provider: source.provider, name: source.name },
    target: { id: target.id, provider: target.provider, name: target.name },
    pair: { from: source.provider, to: target.provider, sourceMonthlyUsd: a, targetMonthlyUsd: b, monthlyUsd: a !== null && b !== null ? a - b : null, creditPortionUsd: 0 },
  };
}

const CONTROLS: [string, string, CellState, CellState][] = [
  ['C01', 'DB 포트를 인터넷에 열지 않음', 'pass', 'fail'],
  ['C02', '관리자 계정 MFA', 'pass', 'pass'],
  ['C03', '관리자 전권 정책 없음', 'pass', 'pass'],
  ['C04', 'DB 저장·전송 암호화', 'pass', 'pass'],
  ['C05', '외부 노출은 TLS만', 'pass', 'pass'],
  ['C06', '시크릿이 코드와 이미지에 없음', 'pass', 'pass'],
  ['C07', '클라우드·클러스터 감사 로그', 'pass', 'unknown'],
  ['C08', '키 주권 (고객 관리 키)', 'attested', 'unknown'],
  ['C09', '백업과 복구 시험', 'attested', 'not_applicable'],
];

function securityOf(m: MockMigration): SecurityView {
  const source = envById(m.sourceEnvId);
  const target = envById(m.targetEnvId);
  const matrix: MatrixRow[] = CONTROLS.flatMap(([controlId, title, a, b]) => [
    { side: 'source' as const, envKind: source.provider, controlId, area: 'controls', title, state: a, topSeverity: null, basis: 'static' as const, reason: '출발 환경 설정을 읽은 결과입니다', files: [] },
    { side: 'target' as const, envKind: target.provider, controlId, area: 'controls', title, state: b, topSeverity: b === 'fail' ? 'high' : null, basis: 'static' as const, reason: b === 'fail' ? 'tcp/5432가 0.0.0.0/0에 열립니다' : '도착 계획을 읽은 결과입니다', files: [] },
  ]);
  return {
    viewVersion: 1, generatedAt: nowIso(), migration: { id: m.id, status: m.status },
    summary: { ok: 16, warn: 2, fail: 1, notImplemented: 3, na: 2 }, ledger: ledgerOf(m), tempRoleAudit: {},
    auditChain: { ok: true, checked: m.log.length, brokenAtSeq: null, reason: null, partial: false },
    controlMatrix: matrix,
    rows: [
      { id: 'r1', area: 'temp_credentials', item: '임시 역할 15분', scope: '전 단계', state: 'ok', value: '15분', source: 'audit', ref: null },
      { id: 'r2', area: 'least_privilege', item: '단계별 최소 권한', scope: '실행 역할', state: 'ok', value: '단계마다 분리', source: 'policy', ref: null },
      { id: 'r3', area: 'audit', item: '감사 기록 해시 사슬', scope: '이 이전', state: 'ok', value: '온전함', source: 'audit', ref: null },
      { id: 'r4', area: 'secrets', item: '비밀값 응답 제외', scope: 'API', state: 'warn', value: '일부 로그 확인 필요', source: 'code', ref: null },
      { id: 'r5', area: 'runtime', item: '런타임 이상 탐지', scope: '도착', state: 'not_implemented', value: '수집기 연결 전', source: 'none', ref: null },
      { id: 'r6', area: 'controls', item: 'DB 포트 공개', scope: '도착', state: 'fail', value: 'tcp/5432 → 0.0.0.0/0', source: 'plan', ref: null },
    ],
    live: m.securityChecked ? [liveReport('source', source), liveReport('target', target)] : null,
  };
}

/** 임시 권한 장부. 지나온 단계마다 15분짜리 역할을 빌리고 끝나면 회수한다. 멈춘 이전은 만료됐는데 회수 안 된 줄이 하나 있다. */
function ledgerOf(m: MockMigration): LedgerRow[] {
  const passed = (to: MigrationStatus) => m.log.some((item) => item.to === to);
  const provider = envById(m.targetEnvId).provider;
  const done = ['completed', 'rolled_back', 'cancelled', 'failed'].includes(m.status);
  const row = (n: number, purpose: LedgerRow['purpose'], step: string, live: boolean): LedgerRow => {
    const issued = Date.now() - (live ? 300_000 : 3600_000 + n * 60_000);
    const stale = live && m.status === 'paused' && step === 'shift';
    const issuedAt = new Date(stale ? Date.now() - 1_200_000 : issued).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 900_000).toISOString();
    return {
      credentialRef: `cred-${m.id.slice(-4)}-${n}`, provider, purpose, stage: null, step,
      status: live ? 'active' : 'revoked', issuedAt, expiresAt, revokedAt: live ? null : new Date(issued + 600_000).toISOString(),
      ttlSec: 900, expiredButActive: stale,
    };
  };
  const rows: LedgerRow[] = [row(1, 'observe', 'import', false)];
  if (passed('provisioning')) rows.push(row(2, 'operate', 'apply', false));
  if (passed('deploying')) rows.push(row(3, 'operate', 'deploy', false));
  if (passed('shifting')) rows.push(row(4, 'operate', 'shift', !done && ['shifting', 'paused'].includes(m.status)));
  return rows;
}

function liveReport(side: 'source' | 'target', item: EnvironmentView): LiveSecurityReport {
  const bad = side === 'target';
  return {
    side, provider: item.provider, envId: item.id, checkedAt: nowIso(), durationMs: 840, origin: 'live', credentials: 'ok', reason: null,
    summary: { pass: 2, warn: 0, fail: bad ? 1 : 0, unavailable: 0, na: 0 },
    checks: [
      { key: 'public-db', category: 'public_ports', title: 'DB 포트 공개', resource: 'db', state: bad ? 'fail' : 'pass', evidence: bad ? '0.0.0.0/0' : '내부망만', source: 'read-api' },
      { key: 'storage', category: 'storage_encryption', title: '저장소 암호화', resource: 'db', state: 'pass', evidence: 'AES-256', source: 'read-api' },
      { key: 'tls', category: 'tls', title: 'TLS', resource: 'ingress', state: 'pass', evidence: 'TLS 1.3', source: 'read-api' },
    ],
  };
}

function regressionOf(m: MockMigration): SecurityRegression {
  const base = { regressionVersion: 1 as const, migrationId: m.id, generatedAt: nowIso(), source: null, target: null, recorded: m.securityChecked };
  if (!m.securityChecked) return { ...base, verdict: 'unavailable', summary: { worse: 0, better: 0, same: 0, unknown: 0 }, items: [] };
  return {
    ...base, verdict: 'regressed', summary: { worse: 1, better: 1, same: 1, unknown: 0 },
    items: [
      { key: 'public-db', category: 'public_ports', title: 'DB 포트 공개', before: 'pass', after: 'fail', change: 'worse', beforeEvidence: '내부망만', afterEvidence: '0.0.0.0/0' },
      { key: 'iam', category: 'iam', title: '과다 권한', before: 'warn', after: 'pass', change: 'better', beforeEvidence: '관리자 역할 2개', afterEvidence: '없음' },
      { key: 'tls', category: 'tls', title: 'TLS', before: 'pass', after: 'pass', change: 'same', beforeEvidence: 'TLS 1.3', afterEvidence: 'TLS 1.3' },
    ],
  };
}

function timelineOf(m: MockMigration): TimelineView {
  const first = m.log[0]?.at ?? nowIso();
  return { migrationId: m.id, status: m.status, createdAt: first, generatedAt: nowIso(), running: !['completed', 'rolled_back', 'cancelled'].includes(m.status), totalMs: Date.now() - Date.parse(first), items: m.log, stateDurations: [] };
}

/** 트래픽 판정 요약. 전환을 시작한 이전만 있고, 오류율로 멈춘·되돌린 이전은 나쁨 1번이 있다. */
function trafficSummaryOf(m: MockMigration): EvidenceReport['traffic'] {
  if (!m.log.some((item) => item.to === 'shifting')) return null;
  const reached = m.log.some((item) => item.to === 'cutover') ? SHIFT_STEPS : SHIFT_STEPS.filter((step) => step <= Math.max(m.trafficPct, SHIFT_STEPS[0]!));
  const bad = m.failureCode === 'TRAFFIC_ERROR_RATE' ? 1 : 0;
  return { judgements: reached.length * 3 + bad, steps: reached, bad, maxTargetErrorRatePct: bad ? 3.4 : 0.2, maxTargetP95Ms: bad ? 912 : 131 };
}

function reportOf(m: MockMigration): EvidenceReport {
  const moves = m.log.filter((item) => item.kind === 'transition');
  const denied: EvidenceReport['incidents'] = m.agentRan
    ? [{ seq: store!.seq, at: nowIso(), actor: 'agent', action: 'repo_edit', result: 'denied', note: '허용 목록 밖 파일을 고치려 해 거부했습니다' }]
    : [];
  return {
    generatedAt: nowIso(), reportHash: `sha256:${m.id.replace(/-/g, '')}`, gaps: ['보안 수집기 기록이 아직 없습니다'], traffic: trafficSummaryOf(m),
    summary: { startedAt: m.log[0]?.at ?? null, endedAt: null, totalMs: null, transitions: moves.length, reachedCutover: moves.some((item) => item.to === 'cutover'), rolledBack: m.status === 'rolled_back', deniedOrError: denied.length },
    integrity: { ok: true, checked: m.log.length, firstSeq: m.log[0]?.seq ?? null, lastSeq: m.log.at(-1)?.seq ?? null, brokenAtSeq: null, reason: null, partial: false },
    approvals: m.approvals, incidents: denied,
    measurements: m.log.flatMap((item) => item.measurements.map((value) => ({ ...value, env: 'target', at: item.at }))),
  };
}

function reportHtmlOf(m: MockMigration) {
  const rows = m.log.map((item) => `<tr><td>${item.seq}</td><td>${item.at}</td><td>${item.actor}</td><td>${item.from ?? ''} → ${item.to ?? item.action}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>증적 리포트</title><body style="font-family:sans-serif;padding:32px"><h1>${m.app} 증적 리포트</h1><p>감사 기록 ${m.log.length}줄 · 사슬 온전</p><table border="1" cellpadding="6">${rows}</table>`;
}

function liveOf(m: MockMigration): LiveTrafficView {
  const shiftAt = m.log.find((item) => item.to === 'shifting')?.at;
  const started = shiftAt !== undefined;
  const moving = !['completed', 'rolled_back', 'cancelled'].includes(m.status);
  const until = moving ? Date.now() : Date.parse(m.updatedAt ?? nowIso());
  const total = started ? Math.floor((until - Date.parse(shiftAt)) / 40) : 0;
  // 컷오버 동안 앱 앞 프록시가 잠깐 붙잡았다 보낸 요청 (끊긴 요청 없이 넘겼다는 근거)
  const cutAt = m.log.find((item) => item.to === 'rollback_window')?.at;
  return {
    migrationId: m.id, available: started, source: 'proxy', fetchedAt: nowIso(), total, ok: total, fail: 0, c4xx: Math.floor(total / 900), p50Ms: 41, p95Ms: 118,
    held: started && cutAt ? 37 : 0, maxHoldMs: started && cutAt ? 168 : 0, mode: null, switchedAt: cutAt ?? null, since: shiftAt ?? null, byState: [],
    ...(started ? {} : { reason: 'no_counters' as const }),
  };
}

function shiftOf(m: MockMigration): TrafficShiftProgress {
  const known = m.log.some((item) => item.to === 'shifting');
  // 단계가 바뀐 직후 잠깐은 엣지에 아직 덜 퍼져서 실측이 앞 단계에 머문다
  const stepStart = m.status === 'shifting' && m.nextAt !== null ? m.nextAt - SHIFT_STEP_MS : null;
  const spreading = stepStart !== null && Date.now() - stepStart < SHIFT_STEP_MS / 2 && m.shiftIndex > 0;
  const observed = spreading ? SHIFT_STEPS[m.shiftIndex - 1]! + 4 : Math.max(0, m.trafficPct - (m.status === 'shifting' ? 2 : 0));
  return {
    migrationId: m.id, available: known, targetWeightPct: known ? m.trafficPct : null,
    observedWeightPct: known ? observed : null,
    reached: known ? !spreading : null, tolerancePct: 10, reobserve: 0,
    stepStartedAt: stepStart !== null ? new Date(stepStart).toISOString() : null, observedAt: known ? nowIso() : null,
  };
}

function agentReviewOf(m: MockMigration): AgentReview {
  const meta = { source: 'db' as const, runId: `run-${m.id}`, model: 'claude-sonnet-5-5', createdAt: nowIso(), finishedAt: nowIso(), reason: null, usage: { input: 18420, output: 1630 } };
  const running = m.agentDoneAt !== null;
  const remediate: RemediateReview | null = running
    ? { ...meta, status: 'running', steps: [], outcome: null, title: '', rationale: '', checked: [], notDone: [], gate: null }
    : m.agentRan
      ? {
          ...meta, status: 'finished', outcome: 'proposed', title: 'DB 포트를 내부망으로 좁힙니다',
          rationale: '5432 포트가 0.0.0.0/0에 열려 있어 가드레일이 멈췄습니다. cidr을 10.20.0.0/16으로 바꾸는 수정안입니다.',
          checked: ['5432 포트가 내부망에만 열림', '앱에서 DB 연결 테스트 통과', '보안 표 재검사 통과'],
          notDone: ['운영 부하에서의 연결 수', '클라우드 방화벽 규칙'],
          gate: { ok: true, violations: [] },
          steps: [
            { seq: 1, tool: 'sandbox_get', ok: true, note: 'Deployment, Service 상태 확인' },
            { seq: 2, tool: 'sandbox_logs', ok: true, note: 'db 연결 로그 읽기' },
            { seq: 3, tool: 'repo_read', ok: true, note: 'deploy/network.yaml' },
            { seq: 4, tool: 'repo_edit', ok: false, note: '허용 목록 밖 파일 수정 거부' },
            { seq: 5, tool: 'repo_edit', ok: true, note: 'cidr: 10.20.0.0/16' },
            { seq: 6, tool: 'sandbox_apply', ok: true, note: 'deploy/network.yaml' },
            { seq: 7, tool: 'run_check', ok: true, note: 'check_ok' },
            { seq: 8, tool: 'finish', ok: true, note: 'proposed' },
          ],
        }
      : null;
  const specDraft: SpecDraftReview = {
    ...meta, status: 'finished', steps: [], version: 2, rejectedCount: 1,
    planExplanation: '앱은 같은 이미지로 재배포하고, DB는 논리 복제로 따라잡은 뒤 트래픽을 단계적으로 옮깁니다.',
    risks: [
      { id: 'R1', level: 'high', title: '복제 수를 낮게 읽었을 수 있습니다', source: 'ai' },
      { id: 'R2', level: 'medium', title: 'CPU 요청량이 운영 사용량보다 낮습니다', source: 'ai' },
      { id: 'R3', level: 'low', title: '헬스 체크 경로를 추정했습니다', source: 'rule' },
    ],
  };
  const runs = store!.migrations.filter((item) => item.agentRan).length;
  const spend = { round: 'finals-1107', usd: Math.round((0.18 + runs * 0.11) * 100) / 100, budgetUsd: 5, calls: 6 + runs * 8, exceeded: false };
  return { migrationId: m.id, llm: { state: 'ready', model: 'claude-sonnet-5-5', why: '', spend }, remediate, specDraft };
}

/** 도착 쪽 자원 상태. 서버 env-inventory.ts targetResources 를 줄여 옮겼다 (실패·롤백·취소 뒤 남은 자원을 보여 주려고). */
function targetFootprint(m: MockMigration): FootprintResource[] {
  const at = m.status === 'paused' ? (m.pausedFrom ?? 'deploying') : m.status === 'failed' ? (m.failedAtStatus ?? 'provisioning') : m.status;
  const step = WALK.indexOf(at);
  const applied = m.log.some((item) => item.from === 'provisioning' && item.to === 'deploying') || step > WALK.indexOf('provisioning');
  const deployed = m.log.some((item) => item.to === 'syncing') || step >= WALK.indexOf('syncing');
  let infra: FootprintState;
  let app: FootprintState;
  if (m.status === 'rolled_back') [infra, app] = ['left', 'left'];
  else if (m.status === 'rolling_back') [infra, app] = ['running', 'standby'];
  else if (m.status === 'cancelled') [infra, app] = [applied ? 'left' : 'none', deployed ? 'left' : 'none'];
  else if (m.status === 'failed') [infra, app] = at === 'provisioning' ? ['unknown', 'none'] : ['left', deployed ? 'left' : 'unknown'];
  else if (step < WALK.indexOf('provisioning')) [infra, app] = ['planned', 'planned'];
  else if (at === 'provisioning') [infra, app] = ['creating', 'planned'];
  else [infra, app] = ['running', at === 'deploying' ? 'creating' : 'running'];
  const service = SERVICE[envById(m.targetEnvId).provider];
  const evidence = applied ? 'terraform' as const : 'adapter' as const;
  return [
    { category: 'compute', type: 'cluster', label: `${service.cluster} 네임스페이스`, state: infra, evidence },
    { category: 'database', type: 'db', label: `${service.db} 16 · 20GB`, state: infra, evidence },
    { category: 'secret', type: 'secret', label: `${service.secret} 비밀`, state: infra, evidence },
    { category: 'compute', type: 'helm.release', label: '앱 컨테이너 2개 (500m CPU · 1Gi)', state: app, evidence: deployed ? evidence : 'adapter' },
    { category: 'replication', type: 'pg.subscription', label: '복제 구독 (출발 → 도착)', state: m.status === 'rolled_back' || m.status === 'completed' ? 'removed' : step >= WALK.indexOf('syncing') && step <= WALK.indexOf('cutover') ? 'running' : 'none', evidence: 'adapter' },
  ];
}

function inventoryOf(item: EnvironmentView): { cloud: CloudInventory; apps: EnvApp[] } {
  const service = SERVICE[item.provider];
  const apps = store!.migrations.filter((m) => m.sourceEnvId === item.id || m.targetEnvId === item.id);
  const names = apps.map((m) => m.app);
  const app = names[0] ?? 'shop-api';
  const cloud: CloudInventory = {
    status: 'ok', reason: null, source: item.provider === 'azure_mock' ? 'azure-mock' : 'read-api', region: REGION[item.provider],
    groups: [
      { category: 'cluster', service: service.cluster, error: null, items: [{ name: `${item.name}-cluster`, status: 'ACTIVE' }] },
      { category: 'workload', service: 'Deployment', error: null, items: [{ name: `${app}-web`, status: 'Running' }, { name: `${app}-api`, status: 'Running' }] },
      { category: 'database', service: service.db, error: null, items: [{ name: `${app}-db`, status: 'available' }] },
      { category: 'network', service: 'VPC', error: null, items: [{ name: `${item.name}-vpc`, status: 'available' }] },
      { category: 'secret', service: service.secret, error: null, items: [{ name: `${app}/db-password`, status: 'active' }] },
    ],
  };
  return {
    cloud,
    apps: apps.map((m) => {
      const source = m.sourceEnvId === item.id;
      const peer = envById(source ? m.targetEnvId : m.sourceEnvId);
      const done = m.status === 'completed';
      const undone = m.status === 'rolled_back' || m.status === 'cancelled' || m.status === 'failed';
      return {
        migrationId: m.id, role: source ? 'source' : 'target', peer: { envId: peer.id, name: peer.name, provider: peer.provider },
        migrationStatus: m.status, stage: done ? 'after' : undone ? 'undone' : m.trafficPct > 0 ? 'changing' : 'before',
        trafficPct: source ? 100 - m.trafficPct : m.trafficPct, spec: { app: m.app }, resources: source ? [] : targetFootprint(m),
      };
    }),
  };
}

function statusOf(item: EnvironmentView): EnvStatus {
  const degraded = item.name === 'stage-gcp';
  return {
    provider: item.provider, mock: item.provider === 'azure_mock', envId: item.id, region: REGION[item.provider], health: degraded ? 'degraded' : 'healthy', checkedAt: nowIso(),
    resources: Array.from({ length: degraded ? 8 : 12 }, (_, index) => ({ type: 'resource', name: `resource-${index}`, id: `id-${index}`, state: 'Succeeded' as const })),
  };
}

function finding(tool: string, toolCheckId: string, controlId: string | null, resource: string, status: Finding['status'], severity: Finding['severity'], kind: Finding['kind'], evidence: string): Finding {
  return { tool, toolCheckId, controlId, resource, status, severity, kind, evidence, observedAt: new Date(Date.now() - 600_000).toISOString() };
}

function agentReportsOf(item: EnvironmentView): AgentReportList {
  if (item.provider !== 'onprem') return { envId: item.id, lastHeartbeatAt: null, stale: false, items: [] };
  const down = item.connectionStatus !== 'connected';
  const beat = new Date(Date.now() - (down ? 1800_000 : 40_000)).toISOString();
  return {
    envId: item.id, lastHeartbeatAt: beat, stale: down,
    items: [
      { id: `${item.id}-1`, kind: 'heartbeat', receivedAt: beat, migrationId: null, report: { kind: 'heartbeat', k3sVersion: 'v1.31.4+k3s1', cnpg: { cluster: 'main', ready: true, replicationLagBytes: 0 } } },
      { id: `${item.id}-2`, kind: 'security', receivedAt: new Date(Date.now() - 600_000).toISOString(), migrationId: null, report: { kind: 'security', findings: [
        finding('falco', 'shell_in_container', 'SEC-VIO-04', 'api Pod 안에서 셸 실행', 'fail', 'high', 'threat', 'kubectl exec 로 /bin/sh 실행 감지'),
        finding('kyverno', 'require-networkpolicy', null, '네임스페이스 NetworkPolicy 없음', 'fail', 'medium', 'posture', 'shop 네임스페이스에 정책 0개'),
        finding('agent_script', 'audit-log', 'SEC-AUD-01', '감사 로그 켜짐', 'pass', 'low', 'posture', 'k3s audit-policy 적용'),
      ] } },
      { id: `${item.id}-3`, kind: 'deploy', receivedAt: new Date(Date.now() - 3600_000).toISOString(), migrationId: null, report: { kind: 'deploy', status: 'applied', resources: ['Deployment/web', 'Deployment/api', 'Service/web'] } },
    ],
  };
}

// ---- 경로 ----

type Reply = { status: number; body?: unknown; html?: string };

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const fail = (status: number, code: string, message: string): Reply => ({ status, body: { status, code, message, requestId: `mock-${uuid().slice(0, 8)}` } });
const token = (): TokenResponse => ({ accessToken: `mock-${uuid()}`, tokenType: 'Bearer', expiresIn: 3600, user: USER });

function route(method: string, path: string, search: URLSearchParams, body: Record<string, unknown>): Reply {
  const data = store!;
  const key = `${method} ${path}`;
  switch (key) {
    case 'POST /auth/refresh':
      return ok(token());
    case 'GET /healthz':
    case 'GET /readyz':
      return ok({ ok: true });
    case 'GET /environments':
      return ok({ items: ENVS });
    case 'GET /migrations':
      return ok({ items: [...data.migrations].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')) });
    case 'POST /migrations': {
      const m = seedMigration(data.migrations.length + 10, 'shop-api', 0, 1, 'draft');
      m.id = uuid();
      m.sourceEnvId = String(body.sourceEnvId);
      m.targetEnvId = String(body.targetEnvId);
      m.log = [];
      m.version = 1;
      data.migrations.unshift(m);
      setStatus(m, 'importing', { actor: USER.email });
      return ok({ id: m.id }, 202);
    }
    case 'POST /cost/estimate': {
      const traffic = body.traffic as { peakRps?: number };
      return ok(estimateOf(traffic.peakRps ?? 100, body.profile === 'finance' ? 'finance' : 'startup', (body.targets as Provider[]) ?? ['aws', 'gcp', 'onprem'], body.from as Provider | undefined));
    }
  }

  const planPath = /^\/plans\/plan-([\w-]+)\/approvals$/.exec(path);
  if (planPath && method === 'POST') {
    const m = data.migrations.find((item) => item.id === planPath[1]);
    if (!m) return fail(404, 'NOT_FOUND', 'plan');
    if (m.status !== 'awaiting_approval') return fail(409, 'INVALID_TRANSITION', `${m.status} -> approved`);
    if (body.planHash !== planHash(m)) return fail(409, 'PLAN_HASH_MISMATCH', 'plan hash');
    if (body.decision === 'reject') {
      setStatus(m, 'rejected', { actor: USER.email });
      m.approvals.push({ planId: `plan-${m.id}`, decision: 'reject', approvedBy: USER.email, at: nowIso(), approvedPlanHash: planHash(m), storedPlanHash: planHash(m), hashMatches: true });
      return ok({ migrationId: m.id, planId: `plan-${m.id}`, status: 'rejected' });
    }
    const busy = data.migrations.find((other) => other.id !== m.id && HOLDS_LOCK.includes(other.status)
      && [other.sourceEnvId, other.targetEnvId].some((id) => id === m.sourceEnvId || id === m.targetEnvId));
    if (busy) return fail(409, 'ENV_BUSY', busy.id);
    setStatus(m, 'approved', { actor: USER.email });
    m.approvals.push({ planId: `plan-${m.id}`, decision: 'approve', approvedBy: USER.email, at: nowIso(), approvedPlanHash: planHash(m), storedPlanHash: planHash(m), hashMatches: true });
    return ok({ migrationId: m.id, planId: `plan-${m.id}`, status: 'approved' });
  }

  const envPath = /^\/environments\/([\w-]+)\/(status|inventory|agent-reports)$/.exec(path);
  if (envPath) {
    const item = ENVS.find((value) => value.id === envPath[1]);
    if (!item) return fail(404, 'NOT_FOUND', 'environment');
    if (envPath[2] === 'status') return ok(statusOf(item));
    if (envPath[2] === 'inventory') return ok(inventoryOf(item));
    return ok(agentReportsOf(item));
  }

  const migrationPath = /^\/migrations\/([\w-]+)(\/.*)?$/.exec(path);
  if (!migrationPath) return fail(501, 'MOCK_NOT_HANDLED', key);
  const m = data.migrations.find((item) => item.id === migrationPath[1]);
  if (!m) return fail(404, 'NOT_FOUND', 'migration');
  const sub = `${method} ${migrationPath[2] ?? ''}`;

  switch (sub) {
    case 'GET ':
      return ok(m);
    case 'GET /spec':
      return ok(specOf(m));
    case 'GET /plan':
      return WALK.indexOf(m.status) >= WALK.indexOf('awaiting_approval') || ['paused', 'failed', 'rejected', 'stale', 'rolling_back', 'rolled_back'].includes(m.status)
        ? ok(planOf(m))
        : fail(404, 'NOT_FOUND', 'plan');
    case 'POST /plan':
      if (m.status !== 'spec_review') return fail(409, 'INVALID_TRANSITION', `${m.status} -> prechecking`);
      setStatus(m, 'prechecking', { actor: USER.email });
      return ok({ id: m.id }, 202);
    case 'GET /plan/resources':
      return ok(resourcesOf(m));
    case 'GET /cost':
      return ok(costOf(m));
    case 'GET /timeline':
      return ok(timelineOf(m));
    case 'GET /report':
      return search.get('format') === 'html' ? { status: 200, html: reportHtmlOf(m) } : ok(reportOf(m));
    case 'GET /security':
      return ok(securityOf(m));
    case 'GET /security/regression':
      return ok(regressionOf(m));
    case 'POST /security/check':
      m.securityChecked = true;
      logEntry(m, { kind: 'event', action: 'security.live_check', actor: USER.email });
      return ok({ migrationId: m.id, source: liveReport('source', envById(m.sourceEnvId)), target: liveReport('target', envById(m.targetEnvId)) });
    case 'GET /live-traffic':
      return ok(liveOf(m));
    case 'GET /traffic-shift':
      return ok(shiftOf(m));
    case 'GET /agent-review':
      return ok(agentReviewOf(m));
    case 'POST /agent-review/run':
      m.agentDoneAt = Date.now() + AGENT_RUN_MS;
      m.agentRan = false;
      return ok({ runId: `run-${m.id}`, migrationId: m.id, kind: body.kind ?? 'remediate', status: 'queued' }, 202);
    case 'POST /start':
      if (m.status !== 'approved') return fail(409, 'INVALID_TRANSITION', `${m.status} -> provisioning`);
      setStatus(m, 'provisioning', { actor: USER.email });
      return ok({ id: m.id }, 202);
    case 'POST /rollback': {
      if (!ROLLBACKABLE.includes(m.status)) return fail(409, 'INVALID_TRANSITION', `${m.status} -> rolling_back`);
      if (m.status === 'rollback_window' && Date.parse(m.rollbackWindowEndsAt ?? '0') <= Date.now()) return fail(409, 'GUARD_FAILED', 'rollback window is over');
      const from = m.status;
      // 사람이 누른 롤백은 서버처럼 실패 코드를 비운다 (자동 롤백만 코드가 남는다)
      m.failureCode = null;
      m.pausedFrom = null;
      setStatus(m, 'rolling_back', { actor: USER.email });
      return ok({ id: m.id, from, status: 'rolling_back' }, 202);
    }
    case 'POST /reclaim':
      if (m.status !== 'rollback_window') return fail(409, 'INVALID_TRANSITION', `${m.status} -> cleanup`);
      m.rollbackWindowEndsAt = nowIso();
      m.nextAt = Date.now();
      logEntry(m, { kind: 'event', action: 'migration.reclaim_requested', actor: USER.email });
      return ok({ id: m.id, status: 'rollback_window', windowEndsAt: m.rollbackWindowEndsAt }, 202);
    case 'POST /resume': {
      if (m.status !== 'paused') return fail(409, 'NOT_PAUSED', m.status);
      if (!m.failureCode && body.ruleCleared !== true) return fail(409, 'GUARD_FAILED', 'rule not cleared');
      const to = m.pausedFrom ?? 'shifting';
      m.pausedFrom = null;
      m.failureCode = null;
      setStatus(m, to, { actor: USER.email });
      return ok({ id: m.id, from: 'paused', status: to, queue: to, jobQueued: true }, 202);
    }
    case 'POST /cancel': {
      if (!CANCELABLE.includes(m.status)) return fail(409, 'INVALID_TRANSITION', `${m.status} → cancelled not allowed`);
      if (m.status === 'failed' && body.manualCleanupConfirmed !== true) return fail(409, 'GUARD_FAILED', 'manual cleanup not confirmed');
      const from = m.status;
      setStatus(m, 'cancelled', { actor: USER.email });
      return ok({ id: m.id, from, status: 'cancelled' });
    }
  }
  return fail(501, 'MOCK_NOT_HANDLED', key);
}

// ---- 화면 신호 (SSE) ----
// 실제 서버 GET /api/v1/events 와 같은 형식: 처음에 retry 줄, 쉬는 동안 주석 줄, 신호마다 `data: <SseEvent JSON>` 과 빈 줄.
// 패널의 '신호 끊기'는 열린 연결을 닫고 새 연결을 503 으로 막는다. 화면이 폴링으로 돌아가는지, 다시 켜면 붙는지 본다

const SIGNALS_OFF_KEY = 'kross.dev-mock.signals-off';
const encoder = new TextEncoder();
const signalStreams = new Map<ReadableStreamDefaultController<Uint8Array>, number>();
// 새로 고침해도 끊은 채로 둔다 (이 탭 동안)
let signalsOff = (() => {
  try {
    return sessionStorage.getItem(SIGNALS_OFF_KEY) === '1';
  } catch {
    return false;
  }
})();

function setSignalsOff(off: boolean) {
  signalsOff = off;
  try {
    if (off) sessionStorage.setItem(SIGNALS_OFF_KEY, '1');
    else sessionStorage.removeItem(SIGNALS_OFF_KEY);
  } catch {
    /* 저장에 실패해도 이 페이지에서는 끊긴 채로 돈다 */
  }
  if (off) closeSignals();
  updateSignalButton();
}
let signalButton: HTMLButtonElement | null = null;

function dropSignal(c: ReadableStreamDefaultController<Uint8Array>) {
  window.clearInterval(signalStreams.get(c));
  signalStreams.delete(c);
  updateSignalButton();
}

function emitSignal(event: SseEvent) {
  const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const c of [...signalStreams.keys()]) {
    try {
      c.enqueue(bytes);
    } catch {
      dropSignal(c);
    }
  }
}

function closeSignals() {
  for (const c of [...signalStreams.keys()]) {
    try {
      c.close();
    } catch {
      /* 이미 닫힘 */
    }
    dropSignal(c);
  }
}

function signalResponse(signal?: AbortSignal | null): Response {
  if (signalsOff) return toResponse(fail(503, 'MOCK_SIGNALS_OFF', 'signals are switched off in the mock panel'));
  let me: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      me = c;
      c.enqueue(encoder.encode(`retry: ${SIGNAL_RETRY_MS}\n\n`));
      signalStreams.set(c, window.setInterval(() => {
        try {
          c.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          dropSignal(c);
        }
      }, SIGNAL_PING_MS));
      updateSignalButton();
    },
    cancel() {
      if (me) dropSignal(me);
    },
  });
  // 화면이 연결을 끊으면(로그아웃·탭 닫기) 실제 fetch 처럼 읽기가 AbortError 로 끝난다
  signal?.addEventListener('abort', () => {
    if (!me) return;
    dropSignal(me);
    try {
      me.error(new DOMException('aborted', 'AbortError'));
    } catch {
      /* 이미 닫힘 */
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' } });
}

function updateSignalButton() {
  if (!signalButton) return;
  signalButton.textContent = signalsOff ? '신호 다시 켜기' : `신호 끊기 (연결 ${signalStreams.size})`;
}

// ---- 세션과 fetch ----

const isActive = () => {
  try {
    return sessionStorage.getItem(STORE_KEY) !== null;
  } catch {
    return store !== null;
  }
};

function startSession(existing?: Store) {
  store = existing ?? freshStore();
  save();
  if (timer === null) timer = window.setInterval(tick, 150);
  mountPanel();
}

function endSession() {
  if (timer !== null) window.clearInterval(timer);
  setSignalsOff(false);
  timer = null;
  store = null;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* 무시 */
  }
  unmountPanel();
}

const toResponse = (reply: Reply) =>
  reply.html !== undefined
    ? new Response(reply.html, { status: reply.status, headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  const path = url.pathname.slice(4);
  const method = init?.method ?? 'GET';
  const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;

  if (path === '/auth/login' && method === 'POST') {
    if (body.email === ACCOUNT.email && body.password === ACCOUNT.password) {
      startSession();
      await delay(LATENCY_MS);
      return toResponse(ok(token()));
    }
    if (isActive()) endSession();
    return realFetch(input, init);
  }
  if (!isActive()) return realFetch(input, init);
  if (!store) restore();
  await delay(LATENCY_MS);
  if (path === '/events' && method === 'GET') return signalResponse(init?.signal);
  if (path === '/auth/logout' && method === 'POST') {
    endSession();
    return toResponse({ status: 204 });
  }
  const reply = route(method, path, url.searchParams, body);
  if (reply.status === 501) console.warn('[목업] 처리하지 않은 경로', method, path);
  save();
  return toResponse(reply);
};

function restore() {
  try {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) startSession(JSON.parse(saved) as Store);
  } catch {
    startSession();
  }
}

// ---- 화면 점검 ----
// 지금 창 크기에서 레이아웃이 깨진 곳을 잰다. 패널의 '화면 점검' 버튼이나 콘솔의 __layoutCheck() 로 부른다.
// '전체 점검'(__layoutSweep())은 모든 화면과 아래 상황을 차례로 넘기며 잰다. 새로 고침해도 이어 가고, 끝나면 표를 남긴다.
// 크기별로 보려면 창을 1024×768, 1280×720, 1440×900, 1920×1080 으로 바꿔 가며 다시 부른다.

type LayoutProblem = { kind: '겹침' | '가로 넘침' | '버튼 화면 밖' | '쌓는 순서' | '대비'; detail: string };
type Box = { top: number; left: number; right: number; bottom: number };

const label = (el: Element) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) || el.tagName.toLowerCase();

/** 스크롤 칸과 overflow 로 잘린 부분을 뺀, 실제로 보이는 사각형. 다 잘렸으면 null. */
function shownBox(el: Element): Box | null {
  const r = el.getBoundingClientRect();
  let box: Box = { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    const style = getComputedStyle(up);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = up.getBoundingClientRect();
    box = { top: Math.max(box.top, c.top), left: Math.max(box.left, c.left), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom) };
  }
  return box.right - box.left > 1 && box.bottom - box.top > 1 ? box : null;
}

const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

function rgb(color: string) {
  const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return { r, g, b, a };
}
function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const [R, G, B] = [r, g, b].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
}
function backgroundOf(el: Element | null) {
  for (let up = el; up; up = up.parentElement) {
    const color = rgb(getComputedStyle(up).backgroundColor);
    if (color.a > 0.5) return color;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

function layoutCheck(): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const main = document.querySelector('main');
  if (!main) return problems;
  const scroller = document.scrollingElement ?? document.documentElement;
  const keep = scroller.scrollTop;
  const narrow = window.innerWidth < 1200;
  // 색이 바뀌는 중에 재지 않도록 잴 동안 전환을 끈다
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.append(still);

  // 1. 겹침: 카드(section), 버튼, 행동 버튼 줄끼리 보이는 부분이 겹치면 안 된다. 좁은 화면은 버튼 줄이 화면 아래에 붙으므로 맨 아래로 내려서 잰다.
  if (narrow) scroller.scrollTop = scroller.scrollHeight;
  const blocks = [...main.querySelectorAll('section, button, [data-dock]')].filter((el) => !panel?.contains(el));
  const boxes = blocks.map((el) => ({ el, box: shownBox(el) })).filter((item): item is { el: Element; box: Box } => item.box !== null);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (overlapArea(a.box, b.box) > 4) problems.push({ kind: '겹침', detail: `${label(a.el)} ↔ ${label(b.el)}` });
    }
  }
  scroller.scrollTop = 0;

  // 2. 가로로 넘치면 안 된다.
  if (scroller.scrollWidth > window.innerWidth + 1) problems.push({ kind: '가로 넘침', detail: `${scroller.scrollWidth}px > ${window.innerWidth}px` });

  // 3. 처음 연 화면에서 행동 버튼이 화면 안에 있어야 한다.
  for (const button of main.querySelectorAll('[data-dock] button')) {
    const r = button.getBoundingClientRect();
    if (r.bottom > window.innerHeight + 1 || r.top < 0) problems.push({ kind: '버튼 화면 밖', detail: `${label(button)} (${Math.round(r.top)}~${Math.round(r.bottom)}, 창 ${window.innerHeight})` });
  }

  // 4. 좁은 화면에서는 진행 단계가 큰 카드 바로 다음에 와야 한다.
  const hero = main.querySelector('[style*="tile-hero"]');
  const steps = main.querySelector('[style*="tile-steps"]');
  if (narrow && hero && steps) {
    const heroBottom = hero.getBoundingClientRect().bottom;
    const stepsTop = steps.getBoundingClientRect().top;
    const between = [...main.querySelectorAll('section')].filter((el) => !hero.contains(el) && !steps.contains(el)).some((el) => {
      const top = el.getBoundingClientRect().top;
      return top > heroBottom && top < stepsTop;
    });
    if (stepsTop < heroBottom || between) problems.push({ kind: '쌓는 순서', detail: '진행 단계가 큰 카드 바로 다음에 있지 않습니다' });
  }

  // 5. 일반 크기 글자는 바탕과 4.5:1 이상. 누를 수 없는 버튼의 글자는 기준에서 뺀다(WCAG 1.4.3).
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent?.trim() || panel?.contains(el) || el.closest('[aria-hidden="true"], :disabled')) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (large || style.visibility === 'hidden' || !shownBox(el)) continue;
    const fg = luminance(rgb(style.color));
    const bg = luminance(backgroundOf(el));
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (ratio < 4.5) problems.push({ kind: '대비', detail: `${label(el)} ${ratio.toFixed(2)}:1 (${size}px)` });
  }

  scroller.scrollTop = keep;
  still.remove();
  const unique = new Map(problems.map((p) => [`${p.kind}|${p.detail}`, p]));
  return [...unique.values()];
}

(window as unknown as { __layoutCheck?: () => LayoutProblem[] }).__layoutCheck = () => {
  const problems = layoutCheck();
  console.info(`[화면 점검] ${window.innerWidth}×${window.innerHeight} ${window.location.hash || '#/'}: 문제 ${problems.length}건`);
  if (problems.length > 0) console.table(problems);
  return problems;
};

// ---- 조작 패널 ----

type Scenario = { label: string; apply: (m: MockMigration) => void };

const stopAt = (m: MockMigration, status: MigrationStatus, extra: Partial<MockMigration> = {}) => {
  Object.assign(m, { pausedFrom: null, failedAtStatus: null, failureCode: null, ...extra });
  setStatus(m, status);
  m.nextAt = null;
};

/** 워커 shift 가 멈추거나 되돌릴 때 감사 detail.lastJudgement 로 남기는 판정 (contracts TrafficJudgement 모양) */
const badJudgement = (m: MockMigration) => ({
  migrationId: m.id, stepPct: 50, samples: 1840, target5xx: 63, targetErrorRatePct: 3.42, sourceErrorRatePct: 0.11,
  targetP95Ms: 912, sourceP95Ms: 124, verdict: 'bad', at: nowIso(),
});

const SCENARIOS: Scenario[] = [
  { label: '명세 검토', apply: (m) => stopAt(m, 'spec_review') },
  {
    label: '사전 점검 막힘',
    apply: (m) => {
      m.status = 'prechecking';
      stopAt(m, 'spec_review');
      m.log.at(-1)!.detail = { precheck: [
        { id: 'PC-03', level: 'block', message: '기본 키 없는 표가 있습니다: audit_log', fix: '표에 기본 키를 추가해 주세요' },
        { id: 'PC-07', level: 'warn', message: '도착 리전의 vCPU 한도가 80%입니다' },
      ] };
    },
  },
  { label: '계획 승인', apply: (m) => stopAt(m, 'awaiting_approval') },
  { label: '낡은 계획', apply: (m) => stopAt(m, 'stale') },
  { label: '거절', apply: (m) => stopAt(m, 'rejected') },
  { label: '트래픽 이동', apply: (m) => setStatus(m, 'shifting') },
  {
    label: '가드레일 멈춤',
    apply: (m) => {
      setStatus(m, 'shifting');
      stopAt(m, 'paused', { pausedFrom: 'shifting', trafficPct: 10 });
      m.log.at(-1)!.detail = { evidence: { guardrailRule: 'MG-2-07' } };
    },
  },
  {
    label: '오류율 멈춤',
    apply: (m) => {
      setStatus(m, 'shifting');
      stopAt(m, 'paused', { pausedFrom: 'shifting', failureCode: 'TRAFFIC_ERROR_RATE', trafficPct: 50 });
      Object.assign(m.log.at(-1)!, { failureCode: 'TRAFFIC_ERROR_RATE', detail: { reachedPct: 50, lastJudgement: badJudgement(m) } });
    },
  },
  {
    label: '자동 롤백',
    apply: (m) => {
      setStatus(m, 'shifting');
      Object.assign(m, { pausedFrom: null, failedAtStatus: null, failureCode: 'TRAFFIC_ERROR_RATE', trafficPct: 50 });
      setStatus(m, 'rolling_back', { failureCode: 'TRAFFIC_ERROR_RATE', detail: { reachedPct: 50, rollbackReason: 'error_rate', lastJudgement: badJudgement(m) } });
    },
  },
  { label: '작업 멈춤', apply: (m) => stopAt(m, 'paused', { pausedFrom: 'deploying', failureCode: 'ARGO_TIMEOUT', trafficPct: 0 }) },
  { label: '실패', apply: (m) => stopAt(m, 'failed', { failedAtStatus: 'provisioning', failureCode: 'TF_APPLY_FAILED', trafficPct: 0 }) },
  { label: '롤백 대기', apply: (m) => setStatus(m, 'rollback_window') },
  { label: '완료', apply: (m) => stopAt(m, 'completed', { trafficPct: 100 }) },
];

let panel: HTMLElement | null = null;

function currentMigration() {
  const id = /(?:migrations|security|audit|agent)\/([\w-]+)/.exec(window.location.hash)?.[1];
  return store?.migrations.find((m) => m.id === id) ?? store?.migrations.find((m) => !['completed', 'rolled_back', 'cancelled'].includes(m.status)) ?? store?.migrations[0];
}

function pillButton(label: string, onClick: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = 'padding:6px 10px;border:0;border-radius:999px;background:var(--color-bg-subtle);color:var(--color-fg-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer';
  button.addEventListener('click', onClick);
  return button;
}

function mountPanel() {
  if (panel) return;
  panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;display:flex;flex-direction:column;align-items:flex-start;gap:6px;font-size:12px;view-transition-name:dev-mock-panel';
  const menu = document.createElement('div');
  menu.style.cssText = 'display:none;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--color-border-default);border-radius:16px;background:var(--color-bg-surface)';
  for (const scenario of SCENARIOS) {
    menu.append(pillButton(scenario.label, () => {
      const m = currentMigration();
      if (!m || !store) return;
      scenario.apply(m);
      save();
      window.location.hash = `#/migrations/${m.id}`;
      // 신호가 붙어 있으면 화면이 신호를 받고 다시 읽는다. 끊겨 있으면 끝난 이전은 다시 읽지 않아서 새로 고침으로 맞춘다
      if (signalStreams.size === 0) window.location.reload();
    }));
  }
  const result = document.createElement('span');
  result.style.cssText = 'max-width:220px;padding:0 4px;color:var(--color-fg-secondary);white-space:pre-line';
  menu.append(pillButton('화면 점검', () => {
    const problems = (window as unknown as { __layoutCheck: () => LayoutProblem[] }).__layoutCheck();
    result.textContent = problems.length === 0 ? '문제 없음' : problems.slice(0, 6).map((p) => `${p.kind}: ${p.detail}`).join('\n');
  }), result);
  menu.append(pillButton('전체 점검', () => {
    result.textContent = '모든 화면을 넘기며 재는 중입니다. 결과는 콘솔에 나옵니다';
    (window as unknown as { __layoutSweep: () => void }).__layoutSweep();
  }));
  signalButton = pillButton('', () => setSignalsOff(!signalsOff));
  updateSignalButton();
  menu.append(signalButton);
  menu.append(pillButton('데이터 처음으로', () => {
    store = freshStore();
    save();
    window.location.hash = '#/';
    window.location.reload();
  }));
  const toggle = pillButton('목업', () => {
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
  });
  toggle.style.background = 'var(--color-bg-tone-warning)';
  toggle.style.color = 'var(--color-fg-tone-warning)';
  panel.append(menu, toggle);
  document.body.append(panel);
}

function unmountPanel() {
  panel?.remove();
  panel = null;
  signalButton = null;
}

// ---- 전체 점검 ----

const SWEEP_KEY = 'kross.layout-sweep';
type SweepResult = { step: string; problems: LayoutProblem[] };
type Sweep = { steps: string[]; pending: string | null; results: SweepResult[] };

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const readSweep = () => JSON.parse(sessionStorage.getItem(SWEEP_KEY) ?? 'null') as Sweep | null;
const writeSweep = (sweep: Sweep) => sessionStorage.setItem(SWEEP_KEY, JSON.stringify(sweep));

function sweepSteps() {
  const id = store?.migrations[0]?.id ?? '';
  const pages = ['#/', '#/migrations', '#/migrations/new', 'new:출발 고른 뒤', '#/environments', '#/settings', '#/design-system'];
  const perMigration = ['cost', 'security', 'audit', 'agent'].map((page) => (page === 'cost' ? `#/migrations/${id}/cost` : `#/${page}/${id}`));
  return [...pages, ...perMigration, ...SCENARIOS.map((scenario) => `상황:${scenario.label}`)];
}

async function record(sweep: Sweep, step: string) {
  await wait(2000);
  sweep.results.push({ step, problems: layoutCheck() });
  writeSweep(sweep);
}

/** 한 걸음씩 진행한다. 상황을 바꾸는 걸음은 새로 고침이 필요해서, 다시 열린 뒤 이어서 잰다. */
async function runSweep() {
  const sweep = readSweep();
  if (!sweep) return;
  if (sweep.pending) {
    const step = sweep.pending;
    sweep.pending = null;
    await record(sweep, step);
  }
  while (sweep.steps.length > 0) {
    const step = sweep.steps.shift()!;
    if (step.startsWith('상황:')) {
      const scenario = SCENARIOS.find((item) => `상황:${item.label}` === step);
      const m = store?.migrations[0];
      if (!scenario || !m) continue;
      scenario.apply(m);
      save();
      sweep.pending = step;
      writeSweep(sweep);
      window.location.hash = `#/migrations/${m.id}`;
      window.location.reload();
      return;
    }
    if (step.startsWith('new:')) {
      window.location.hash = '#/migrations/new';
      await wait(1500);
      document.querySelector<HTMLButtonElement>('main section button:not(:disabled)')?.click();
    } else {
      window.location.hash = step;
    }
    await record(sweep, step);
  }
  sessionStorage.removeItem(SWEEP_KEY);
  const rows = sweep.results.flatMap(({ step, problems }) => problems.map((problem) => ({ 화면: step, ...problem })));
  console.info(`[전체 점검] ${window.innerWidth}×${window.innerHeight}: 화면 ${sweep.results.length}개, 문제 ${rows.length}건`);
  if (rows.length > 0) console.table(rows);
  sessionStorage.setItem(`${SWEEP_KEY}-result`, JSON.stringify({ size: `${window.innerWidth}×${window.innerHeight}`, screens: sweep.results.length, rows }));
}

(window as unknown as { __layoutSweep?: () => void }).__layoutSweep = () => {
  sessionStorage.removeItem(`${SWEEP_KEY}-result`);
  writeSweep({ steps: sweepSteps(), pending: null, results: [] });
  void runSweep();
};

// 새로 고침해도 이 탭의 목업 세션을 이어 간다
if (isActive()) restore();
// 전체 점검 중에 새로 고침됐으면 이어서 잰다
if (isActive() && readSweep()) void runSweep();
