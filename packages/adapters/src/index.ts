import type { EnvironmentAdapter, Provider } from "@svc/contracts";
import { awsAdapter } from "./aws/index.js";
import { gcpAdapter } from "./gcp/index.js";
import { onpremAdapter } from "./onprem/index.js";
import { azureMockAdapter } from "./azure-mock/index.js";

const REGISTRY: Record<Provider, EnvironmentAdapter> = {
  aws: awsAdapter, gcp: gcpAdapter, onprem: onpremAdapter, azure_mock: azureMockAdapter,
};
export const adapterFor = (p: Provider) => REGISTRY[p];

export * as aws from "./aws/index.js";
export * as gcp from "./gcp/index.js";
export * as onprem from "./onprem/index.js";
export * as azure from "./azure-mock/index.js";
export * as azureRunner from "./azure-mock/runner.js";
export { runnerFor, chooseRunner, azureMockEnabled, RunnerUnavailable, STUB_TF_OUTPUTS, stubStatus, type RunnerChoice } from "./runners.js";
export { AdapterError, isAdapterError, type AdapterErrorCode } from "./common/errors.js";
export type * from "./common/runner.js";
export { unexpectedPlanTypes, type Purpose } from "./common/actions.js";
export { DEMO_INVENTORY } from "./common/fixtures.js";
export { DEMO_SPEC } from "./common/demo-spec.js";
export type { Target, TargetExtras } from "./common/target.js";
export { registryOf, isPublicImage } from "./common/base.js";
// 리허설: 샌드박스 Postgres 가 도착과 같은 DB 이름·앱 계정을 쓰게 (worker rehearsal)
export { dbIdentityFor } from "./target/data-fit.js";
export { realTerraformEnabled, iacMockEnabled, findWorkDir, readImported, type ImportedInfra, TENANT_DIR_RE, createRealTerraformRunner, fillTfVars, factsFromEnv, factEnvName, parseOutputs, childEnv,
  workRootOf, workDirOf, PLAN_ONLY_ID, planOnlyId, spawnExec, REAL_MODULE_BASE, ROOT_DIR, layoutOf, type TfLayout, DEFAULT_MODULE_ROOT, type Exec, type ExecResult, type RealApplyResult, type RealTerraformRunner } from "./terraform/real-runner.js";
export { dbNetworkFromEnv, withDbNetworkV2, cidrProblem, DbNetworkError, type DbNetworkSummary } from "./terraform/db-network.js";
// Z86: 환경 실자원 읽기(읽기 전용 CLI) + 클라우드 서비스 대응표
export { readInventory, cachedInventory, clearInventoryCache, inventoryToStatus, itemState, agentInventory, type AgentInventory, type CloudInventory, type InventoryGroup, type InventoryItem, type InventoryDeps } from "./inventory.js";
export { SERVICE_NAME, METHOD_LABEL, type ServiceMapRow, type ServiceCategory, type MoveMethod, type PlanStepId } from "./common/service-map.js";
// Z88: 출발 환경 진짜 읽기 (가져오기). MOCK_SEED=1 이면 어댑터 discover 는 데모 원본
export { discoverSource, inventoryForAudit, discoverAws, discoverGcp, discoverOnprem, discoverForImport, type DiscoverOpts } from "./discover/index.js";
export { AWS_NET_READ_ACTIONS, GCP_NET_READ_PERMISSIONS } from "./discover/net.js";
export { AWS_COMMAND_ACTIONS, GCP_COMMAND_PERMISSIONS, actionsOfCommands } from "./common/observe-permissions.js";
export { readAlbRequestRate, ALB_RATE_AWS_COMMANDS, type AlbRate, type AlbRateResult } from "./aws/alb-request-rate.js";
export { AWS_DATA_READ_ACTIONS, GCP_DATA_READ_PERMISSIONS, AWS_DATA_READ_PENDING, GCP_DATA_READ_PENDING } from "./discover/data.js";
export { readK8sNamespace, type K8sNamespaceRead, type K8sNamespaceOpts } from "./discover/k8s.js";
// I2: k8s 원본 타입 + 종류 문자열
export * from "./import/raw-k8s.js";
export { mockSeed, CliError, classifyCliError, sourceFail, type CliErrorKind, type CliDeps } from "./common/cli.js";
export { runCloudPrecheck, toPrecheckItems, mockPrecheckEnabled, mockChecks, cliProblem, tcpProbe, apiEndpoint, AWS_QUOTAS, GCP_APIS, CLOUDSQL_PG_MAJORS_DEFAULT, MIN_REPL_PG_MAJOR,
  type CloudCheck, type Verdict, type PrecheckEnvInfo, type PrecheckInput, type PrecheckDeps, type CloudProvider } from "./precheck/cloud-precheck.js";
export { relayPathApplies } from "./precheck/cloud-precheck.js";
export { RELAY_ACTIONS, relayPermVerdict, relaySimArgs, relaySimContext, RELAY_PERM_FIX } from "./precheck/relay-permissions.js";   // 온프레 이전 중계기 권한
// L4: 연결 확인 (빌린 관찰 역할로 고객 AWS 읽어 보기)
export { verifyAwsObserve, envFor, EKS_CLUSTER_NAME_RE, trustHasExternalId, type VerifyAwsInput, type VerifyAwsResult } from "./verify/aws.js";
// I3a: 가져오기 (원본 → 공통 명세)
export { normalizeV2, KIND_MAPPERS, EVIDENCE_TYPES, ENVIRONMENT_TYPES } from "./import/pipeline.js";
export type { SourceReader, KindMapper, RawItem, MappedComponent, NativeRef, NormalizeV2Options, NormalizeV2Output } from "./import/types.js";
// TA1: 도착 Builder (공통 명세 → 고정 루트 Terraform 변수 + workloads[] Helm 값)
export { renderViewV2, isInClusterData, targetBuilderFor, awsTarget, gcpTarget, onpremTarget, onpremGitFloorOutputs, azureMockTarget, rdsClassFor, cloudSqlTierFor, requirementsV2, v2Blockers, V2_FIELD_COVERAGE,
  K8S_RENDER_CAPS, UNSUPPORTED_V2, LINK_OUTPUT_UNKNOWN, identitiesOf, targetNamespace, sourceNamespacesOf, meshesOf, RESERVED_NAMESPACES, resourceTypesV2For, type FieldRule, type IdentityPlan,
  managedBlockers, managedServicesOf, managedServiceVars, managedSecretName, managedJobsOf, managedJobVars,
  dbWriterVar, dbLinkSecretName, type DbWriter, type SourceDbLinkRef } from "./target/index.js";   // TA13 · JOBBUILD · APP-22 (가)
export { targetFactsV2, sourceFactsV2, sourceDbsV2, appEnvV2, workloadSecurityV2, MODULE_DB_FACTS, type EnvSide, type AgentFacts } from "./target/security-facts.js";   // 보안 판정용 환경 사실
export { verifyGcpObserve, OPTIONAL_PROBES, gcpEnvFor, gcpReasonOf, type VerifyGcpInput, type VerifyGcpResult } from "./verify/gcp.js";   // L7i
export { freezeGkeUpgrades, releaseGkeUpgrades, freezeArgs, releaseArgs, freezeExclusionName, FREEZE_DEFAULT_HOURS, FREEZE_MAX_HOURS, type GkeFreezeTarget, type GkeFreezeResult } from "./gcp/upgrade-freeze.js";
// L5b: 빌린 AWS 실행 자격 → terraform 자식 프로세스 (credential_process 임시 파일)
export { borrowedAwsCreds, type BorrowedAwsCreds, type AwsSessionKeys } from "./terraform/borrowed-aws.js";
// DEPLOYNONK8S: Terraform 이 앱까지 띄우는 도착(ECS·Cloud Run·VM)의 배포 확인
export { terraformRuntimeOf, checkTerraformRuntime, type TerraformRuntime, type RuntimeHealth, type RuntimeHealthCode, type RuntimeHealthInput, type RuntimeHealthDeps } from "./target/runtime-health.js";
export { GCP_KIND_APIS, GCP_ENV_APIS, gcpRequiredApis, gcpKindsOfVars, type GcpApiKind } from "./target/gcp-apis.js";   // FM-CLD-14
// TA10: Azure Mock 도착 Builder (capability 표 + mock plan)
export { azureMockPlanV2, azureMockOutputsV2, azureResourceTypesV2, type AzureMockPlanV2 } from "./target/index.js";
// TA3: 계획·적용 연결 — 명세 고르기·precheck 대조·출력 펼치기·흉내 출력
export { k8sRenderWarnings } from "./target/render-warnings.js";
export { resolveSpecV2, specV2OrThrow, specV2ForPlan, v2PrecheckItems, flattenTfOutputsV2, stubTfOutputsV2, NEEDS_HUMAN, type SpecV2Source, type ResolvedSpecV2 } from "./target/plan-v2.js";
// I9: ECS 출발 갈래 (Reader·매퍼). 원본 모양·관찰 권한 목록
export { readEcs, ECS_OBSERVE_ACTIONS, type EcsRead } from "./import/readers/aws-ecs.js";
export { ecsServiceMapper, secretRefOf, roleNameOf } from "./import/mappers/ecs-service.js";
export { readCloudRun, CLOUDRUN_COMMANDS, CLOUDRUN_OBSERVE_PERMISSIONS, type CloudRunRead } from "./import/readers/gcp-cloudrun.js";
export { cloudRunServiceMapper, cloudRunJobMapper, saNameOf } from "./import/mappers/cloudrun-service.js";
export { CLOUDRUN_RAW_KINDS, type RawCloudRunService, type RawCloudRunJob } from "./import/raw-cloudrun.js";
export { ECS_RAW_KIND, type RawEcsService, type RawEcsContainer } from "./import/raw-ecs.js";
export { readEc2, EC2_OBSERVE_ACTIONS } from "./import/readers/aws-ec2.js";
export { readGce, GCE_OBSERVE_PERMISSIONS } from "./import/readers/gcp-gce.js";
export { VM_RAW_KIND, type RawVmGroup, type RawVmIngress } from "./import/raw-vm.js";
export { measureImportAccuracy, ACCURACY_COMPARED, ACCURACY_NOT_COMPARED, type MeasureInput } from "./import/accuracy.js";   // ALIGN-v2 IR-10: 가져오기 정확도 %
export { carryHumanEdits, CARRY_NOTE, type PrevSpecV2, type CarryReport } from "./import/carry.js";
export { applyInclude, IncludeError, type IncludeFailure, type IncludeOut } from "./import/include.js";
export { serviceMapV2, categoryOfTypeV2, type ServiceMapRowV2, type ServiceCategoryV2 } from "./common/service-map-v2.js";
// APP-22 (가): 컷오버 전 도착 앱 → 출발 RDS 잇기 (계획·SQL·사전 점검은 순수, 열기·걷기만 AWS CLI)
export { planSourceDbLink, sourceDbLinkGrantSql, sourceDbLinkDropSql, sourceDbLinkMode, sourceDbLinkInputFromEnv, sourceDbLinkPrecheck,
  openSourceDbLinkAws, closeSourceDbLinkAws, SOURCE_DB_LINK_AWS_ACTIONS, SOURCE_DB_LINK_SG_TAG, sourceDbLinkOperatePolicy, type SqlRunner, type SourceDbLinkMode, type OpenAwsResult } from "./aws/source-db-link.js";
