import type { AppSpec, FieldMeta } from "./spec.js";
import type { Provider } from "./common.js";

export type Capability = string;      // 예: "db.postgres.16"
export interface TargetEnv {
  envId: string; provider: Provider; region: string;
  // 아래는 선택. 없으면 어댑터가 "<env:키>" 자리표시를 넣고, apply 직전 워커가 채운다
  tenantId?: string; migrationId?: string;
  accountId?: string;      // aws
  projectId?: string;      // gcp
  networkId?: string;      // gcp: env 모듈 출력 (VPC self link)
  vpcId?: string;          // aws: env 모듈 출력
  subnetIds?: string[];    // aws: env 모듈 출력 (DB 서브넷)
  clusterName?: string;    // aws/gcp: env 모듈 출력
  clusterLocation?: string; // gcp: env 모듈 출력 (리전 또는 존)
  registryHost?: string;   // onprem / azure
  arch?: "amd64" | "arm64";
  moduleSha?: string;      // infra 모듈 git sha. 없으면 모듈 내용 지문
}
export interface ModuleRef { path: string; gitSha: string }
export type TfVars = Record<string, string | number | boolean>;
export type TfOutputs = Record<string, string>;
export type HelmValues = Record<string, unknown>;
export interface RawInventory { provider: Provider; items: unknown[]; coverage: Record<string, number> }
// DRAFT(ai): 경계 계약이지만 함수 사이로만 넘기고 직렬화하지 않아 Zod 대신 인터페이스로 둔다 (CLAUDE.md 5-1 예외)
export interface ObserveSession {
  accountId: string;
  expiresAt: string;
  region?: string;                   // 지금은 선택. 가져오기가 세션을 쓰게 되면 필수로
  cliEnv?: Record<string, string>;   // 자식 CLI 프로세스에만 넘긴다. 로그·DB·감사·에러 메시지에 절대 넣지 않는다
}
// 가져오기 출처 종류. 비면 k8s
export type ImportOrigin = "k8s" | "managedContainer" | "vm" | "source";
export interface ImportScope {
  kind: "container" | "k8s";         // v1 경로 그대로
  selector: string;
  origins?: ImportOrigin[];          // 비면 k8s
  cluster?: string;
  namespace?: string;                // 오면 IMPORT_NAMESPACE 보다 우선
  repo?: { url: string; ref: string; installationId?: number };
}

// 어댑터 하나 = 함수 묶음. discover만 네트워크를 쓰고 나머지는 순수 함수다
export interface EnvironmentAdapter {
  readonly provider: Provider;
  readonly version: string;                          // 계획 지문에 들어감
  capabilities(): Capability[];
  discover(s: ObserveSession, scope: ImportScope): Promise<RawInventory>;
  normalize(raw: RawInventory): { spec: Partial<AppSpec>; fieldMeta: FieldMeta };
  requiredOperateActions(spec: AppSpec): string[];
  toTerraform(spec: AppSpec, t: TargetEnv): { moduleRef: ModuleRef; vars: TfVars };
  toHelmValues(spec: AppSpec, out: TfOutputs, t: TargetEnv): HelmValues;
  imageRef(srcImage: string, t: TargetEnv): string;  // digest는 그대로
}
