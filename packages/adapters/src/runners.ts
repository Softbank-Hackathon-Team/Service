import type { Provider, TargetEnv, TfOutputs } from "@svc/contracts";
import type { InfraRunner, RunnerStatus } from "./common/runner.js";
import { RunnerUnavailable } from "./common/errors.js";
import { createAzureMockRunner, DEFAULT_LATENCY_MS } from "./azure-mock/runner.js";
import { envNumber } from "@svc/contracts";

// 클라우드 → 실행기. "진짜/Mock 실행기냐, STUB 이냐, 막혔냐"를 정하는 곳은 여기 chooseRunner 하나다 (Z44).
// 예전에는 api(환경 상태)와 worker(apply)가 각자 runnerFor()의 null·예외를 해석했다.
// AZURE_MOCK=1(기본) 이면 Azure는 Mock 실행기. 0이면 Azure 이전을 막는다 (진짜 Azure 실행기는 만들지 않기로 함)
// AZURE_MOCK_LATENCY_MS 로 기다리는 시간 조절 (기본 300ms, 시험은 0)
export { RunnerUnavailable };

export type RunnerChoice =
  | { kind: "runner"; runner: InfraRunner }           // 실행기 있음 (지금은 Azure Mock 뿐)
  | { kind: "stub"; provider: Provider }              // aws/gcp/onprem: worker 는 진짜 terraform(real-runner), MOCK_IAC=1 일 때만 흉내. api 상태 화면은 아직 "모름"(Z86)
  | { kind: "unavailable"; error: RunnerUnavailable }; // 설정으로 막힘 (AZURE_MOCK=0)

export function azureMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AZURE_MOCK ?? "1") !== "0";
}

export function chooseRunner(p: Provider, env: NodeJS.ProcessEnv = process.env): RunnerChoice {
  if (p !== "azure_mock") return { kind: "stub", provider: p };   // Z89: apply 는 worker jobs/apply.ts 가 real-runner 로 (기본 진짜)
  if (!azureMockEnabled(env))
    return { kind: "unavailable", error: new RunnerUnavailable("AZURE_MOCK_DISABLED", "AZURE_MOCK=0: Azure는 Mock 실행기만 있다") };
  const ms = envNumber(env.AZURE_MOCK_LATENCY_MS, DEFAULT_LATENCY_MS);
  return { kind: "runner", runner: createAzureMockRunner({
    latencyMs: Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_LATENCY_MS,
    failOn: env.AZURE_MOCK_FAIL === "apply" || env.AZURE_MOCK_FAIL === "destroy" ? env.AZURE_MOCK_FAIL : null }) };
}

// 예전 모양 그대로: 실행기 | null(STUB) | throw RunnerUnavailable. 새 코드는 chooseRunner 를 쓴다
export function runnerFor(p: Provider, env: NodeJS.ProcessEnv = process.env): InfraRunner | null {
  const c = chooseRunner(p, env);
  if (c.kind === "unavailable") throw c.error;
  return c.kind === "runner" ? c.runner : null;
}

// ---- STUB 길에서 쓰는 값 (실행기가 없는 aws/gcp/onprem) ----

// STUB: 어댑터 toHelmValues가 찾는 출력 이름을 모든 프로바이더 몫으로 가짜 값을 채운다 (gitops 배포가 로컬에서 끝까지 돌게, N2).
// 진짜 apply가 들어오면 Terraform output 그대로 바뀐다. (Z44: worker jobs/apply.ts 에 있던 표를 옮김, 값 같음)
export const STUB_TF_OUTPUTS: Readonly<TfOutputs> = Object.freeze({
  db_endpoint: "pgbouncer.target.internal", cluster_name: "stub-target-cluster",
  db_address: "stub-db.target.internal", db_master_secret_arn: "stub-db-master-secret",
  app_gsa_email: "stub-app@stub-project.iam.gserviceaccount.com", db_private_ip: "10.0.3.12",
  db_password_secret_id: "stub-db-password", app_identity_client_id: "00000000-0000-0000-0000-000000000000",
  db_fqdn: "stub-db.postgres.database.azure.com",
});

// STUB: 실행기가 없는 환경의 상태 = health "unknown" + 빈 목록 (Z44: api routes/environments.ts 에 있던 것을 옮김, 값 같음)
// region 은 regionOf 가 아니라 받은 그대로 ("default") 낸다 — 예전 응답과 같게
export function stubStatus(t: TargetEnv, now: () => Date = () => new Date()): RunnerStatus {
  return { provider: t.provider, mock: false, envId: t.envId, region: t.region, health: "unknown",
           checkedAt: now().toISOString(), resources: [] };
}
