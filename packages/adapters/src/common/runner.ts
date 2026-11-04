import type { AppSpecV2, Provider, TargetEnv, TfOutputs, TfVars } from "@svc/contracts";

// 실행기(InfraRunner) = 어댑터가 만든 Terraform 입력을 "실제로 돌리는" 쪽.
// 어댑터(EnvironmentAdapter)는 순수 번역 함수만 갖고, 네트워크·시간이 드는 일은 여기로 모은다.
// 지금 진짜 실행기는 없다(aws/gcp/onprem은 워커 STUB). Azure만 Mock 실행기가 있다.
// DRAFT(ai): 이 타입은 계약(packages/contracts/src/adapter.ts)으로 옮기자는 제안을 X/CONTRACTS-PROPOSAL.md에 적었다

export type ResourceState = "Creating" | "Succeeded" | "Deleting" | "Deleted" | "Failed";

export interface RunnerResource {
  type: string;            // 예: azurerm_key_vault
  name: string;            // 클라우드 안 이름
  id: string;              // 클라우드 자원 ID (Mock이면 모양만 맞춘 가짜)
  state: ResourceState;
}

export interface RunnerPlan {
  provider: Provider;
  mock: boolean;
  region: string;
  moduleRef: { path: string; gitSha: string };
  vars: TfVars;
  summary: { add: number; change: number; destroy: number };
  resources: RunnerResource[];   // 만들어질 자원 (state = Creating)
  elapsedMs: number;
}

export interface RunnerApplyResult {
  provider: Provider;
  mock: boolean;
  ok: boolean;
  tfOutputs: TfOutputs;
  resources: RunnerResource[];
  elapsedMs: number;
  log: string[];               // terraform 출력 흉내 (화면·감사 기록용, 비밀 없음)
}

export interface RunnerDestroyResult {
  provider: Provider; mock: boolean; ok: boolean; destroyed: number; elapsedMs: number; log: string[];
}

export interface RunnerStatus {
  provider: Provider;
  mock: boolean;
  envId: string;
  region: string;
  health: "healthy" | "degraded" | "unknown";
  checkedAt: string;
  resources: RunnerResource[];
}

export interface InfraRunner {
  readonly provider: Provider;
  readonly mock: boolean;
  plan(spec: AppSpecV2, t: TargetEnv): Promise<RunnerPlan>;
  apply(spec: AppSpecV2, t: TargetEnv): Promise<RunnerApplyResult>;
  destroy(spec: AppSpecV2, t: TargetEnv): Promise<RunnerDestroyResult>;
  // 환경 단위 상태 (이전 하나가 아니라 연결된 환경 자체: 리소스 그룹·클러스터 등)
  status(t: TargetEnv): Promise<RunnerStatus>;
}
