import { authedClient, DEFAULT_TENANT, store, unwrap } from "../api";
import type { CostEstimate, EnvironmentView, MigrationStatus, MigrationView, Provider } from "../types";
import { isTestEnv } from "../envs";

// Z85: 비용·모니터링·보안감사 페이지가 함께 쓰는 것.
// api.ts(Z83 담당)를 고치지 않으려고 새 경로 3개는 여기서 같은 http.ts 클라이언트로 부른다.
// 회사 번호는 App.tsx 가 저장하는 web.tenant 를 요청 순간에 읽는다 (헤더·멱등 키·재시도 규칙은 http.ts 그대로)
const { get, post } = authedClient(() => store.get("web.tenant") || DEFAULT_TENANT);   // Z104 05: 로그인 토큰 포함

// ---- POST /cost/estimate (packages/contracts/src/cost.ts CostEstimateRequest 를 손으로 옮긴 것) ----
export interface EstimateInput {
  spec: DemoSpec;
  from?: Provider;
  targets: Provider[];
  traffic: { peakRps: number } | { mau: number };
  profile: "startup" | "finance";
  applyCredits: boolean;
}
export interface Recommendation {
  rank: number; provider: Provider; security: "basic" | "hardened"; monthlyUsd: number; score: number;
  scoreParts: { cost: number; risk: number; time: number };
}
export interface Breakpoint { fromRps: number; cheapest: Provider; nodes: number }
export type FullEstimate = CostEstimate & { recommendations: Recommendation[]; breakpoints: Breakpoint[] };

// 명세 모양 (packages/contracts/src/spec.ts AppSpec). 값은 서버 DEMO_SPEC(apps/api/src/routes/migration-cost.ts)과 같게 시작
export interface DemoSpec {
  schemaVersion: "1";
  app: { name: string };
  service: { image: string; port: number; healthPath: string; replicas: number; cpu: "250m" | "500m" | "1";
    memory: "512Mi" | "1Gi" | "2Gi"; env: never[]; secretRefs: never[] };
  database?: { engine: "postgres"; majorVersion: "15" | "16" | "17"; storageGb: number };
  ingress: { hostname: string; entry: "cloudflare-lb" };
}
export const DEMO_SPEC: DemoSpec = {
  schemaVersion: "1",
  app: { name: "demo-shop" },
  service: { image: `ghcr.io/demo/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz",
    replicas: 1, cpu: "250m", memory: "512Mi", env: [], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
};

// ---- GET /migrations/:id/report (apps/api/src/report/schema.ts EvidenceReport 중 화면이 쓰는 칸) ----
export interface ChainCheck {
  ok: boolean; checked: number; firstSeq: number | null; lastSeq: number | null;
  brokenAtSeq: number | null; reason: string | null; partial: boolean;
}
export interface EvidenceReport {
  generatedAt: string;
  migration: { id: string; status: MigrationStatus; source: { name: string; provider: string };
    target: { name: string; provider: string }; failureCode: string | null };
  summary: { startedAt: string | null; endedAt: string | null; totalMs: number | null; transitions: number;
    reachedCutover: boolean; rolledBack: boolean; deniedOrError: number };
  integrity: ChainCheck;
  approvals: { planId: string; decision: "approve" | "reject"; approvedBy: string; at: string;
    approvedPlanHash: string; storedPlanHash: string | null; hashMatches: boolean }[];
  incidents: { seq: number; at: string; actor: string; action: string; result: "denied" | "error"; note: string }[];
  measurements: { name: string; value: number; unit: "ms" | "s" | "count" | "pct" | "rps"; env: string; at: string }[];
  gaps: string[];
  reportHash: string;
}


export const pageApi = {
  estimate: (body: EstimateInput) => post<FullEstimate>("/cost/estimate", body),
  report: (id: string) => get<EvidenceReport>(`/migrations/${id}/report`),
  readyz: () => get<{ ok: boolean }>("/readyz"),
  listMigrations: async () => unwrap(await get<MigrationView[] | { items: MigrationView[] }>("/migrations")),
  listEnvironments: async () => unwrap(await get<EnvironmentView[] | { items: EnvironmentView[] }>("/environments")),
};

// 시험용 환경(load-/e2e-/test-/tmp-)끼리 이전은 기본으로 숨긴다 (Z83 Environments 와 같은 규칙)
export function isTestMigration(m: MigrationView, envs: EnvironmentView[]): boolean {
  const name = (id: string) => envs.find((e) => e.id === id);
  const s = name(m.sourceEnvId), t = name(m.targetEnvId);
  return (!!s && isTestEnv(s)) || (!!t && isTestEnv(t));
}

export const usd = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? "—"
    : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export const shortId = (id: string) => id.slice(0, 8);
