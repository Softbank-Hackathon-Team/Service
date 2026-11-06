import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 고객 배포 Terraform state 를 어디에 둘지 한 곳 (앱 층 real-runner, 환경 층 env-layer 가 같이 쓴다).
//   환경변수 TF_STATE_BACKEND 가 없으면(또는 local) 예전과 같은 작업 폴더 로컬 파일.
//   s3 면 우리 플랫폼 AWS 계정의 "고객 state 전용 버킷" 하나에 키 접두사로 회사를 나눈다:
//     앱 층    tenants/<회사>/migrations/<이전 id>/terraform.tfstate
//     환경 층  tenants/<회사>/envs/<환경 id>/terraform.tfstate
// 환경변수는 워커 Node 만 읽는다. terraform 자식 env 로는 안 넘긴다 (real-runner PASS_ENV 에 넣지 않음).
//
// 자격 분리 (가장 중요): terraform 자식 env 의 AWS_CONFIG_FILE [default] 는 고객 실행 역할이다 (borrowed-aws.ts, credential_process).
//   backend 에 bucket 만 적으면 고객 자격으로 우리 버킷을 불러 403. GCP 도착이면 아예 AWS 자격이 없다.
//   그래서 backend 는 작업 폴더의 별도 설정 파일 + 별도 profile(svc-tfstate) 만 본다. 고객용 AWS_CONFIG_FILE 은 건드리지 않는다.
//   빈 자격 파일을 따로 줘서 ~/.aws/credentials·고객 자격 파일을 읽지 않게 한다.
// 설정 파일 내용·경로는 로그에 남기지 않는다 (비밀은 없지만 역할 ARN·버킷 이름이 계정 정보다).

export const TF_STATE_PROFILE = "svc-tfstate";
export const TF_STATE_CONFIG_FILE = "tfstate-aws-config";
export const TF_STATE_CREDENTIALS_FILE = "tfstate-aws-credentials";

export type StateBackend =
  | { kind: "local"; hcl: string }
  | { kind: "s3"; hcl: string; key: string };

export interface StateBackendInput {
  /** 원격 키. appStateKey / envStateKey 로 만든다 */
  key: string;
  /** local 일 때 backend "local" path (terraform 이 도는 폴더 기준 상대 경로) */
  localPath: string;
  /** s3 일 때 설정 파일 두 개를 쓰는 폴더 (작업 폴더). HCL 에는 절대 경로로 들어간다 */
  dir: string;
}

// 작업 폴더 이름 규칙과 같다 (real-runner TENANT_DIR_RE·workDirOf). 순환 import 를 피하려고 여기서 다시 적는다
const TENANT_RE = /^t-[0-9a-f]{8}$/;
const ID_RE = /^[0-9a-f-]{8,}$/i;
const KEY_RE = /^tenants\/t-[0-9a-f]{8}\/(migrations|envs)\/[0-9a-f-]{8,}\/terraform\.tfstate$/i;
// DRAFT(ai): 설정 파일·HCL 에 들어가는 값의 모양. 줄바꿈(설정 파일에 다른 키 끼워 넣기)·따옴표·역슬래시·${ (HCL 보간) 를 막는 게 목적
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function checkId(what: string, v: string) {
  if (!ID_RE.test(v)) throw new Error(`state key: bad ${what}`);
}
/** 앱 층 키. 회사·이전 id 모양이 틀리면 throw (키 밖으로 못 나가게) */
export function appStateKey(tenant: string, migrationId: string): string {
  if (!TENANT_RE.test(tenant)) throw new Error("state key: bad tenant");
  checkId("migration id", migrationId);
  return `tenants/${tenant}/migrations/${migrationId}/terraform.tfstate`;
}
/** 환경 층 키 */
export function envStateKey(tenant: string, envId: string): string {
  if (!TENANT_RE.test(tenant)) throw new Error("state key: bad tenant");
  checkId("env id", envId);
  return `tenants/${tenant}/envs/${envId}/terraform.tfstate`;
}

/** HCL 문자열·설정 파일 한 줄에 들어갈 값 검사. 값은 에러 글에 안 넣는다 */
function hclSafe(what: string, v: string): string {
  if (/["\\\r\n]/.test(v) || /[$%]\{/.test(v)) throw new Error(`state backend: ${what} has characters not allowed in HCL`);
  return v;
}

export function stateBackendKind(env: NodeJS.ProcessEnv): "local" | "s3" {
  const k = (env.TF_STATE_BACKEND ?? "").trim();
  if (k === "" || k === "local") return "local";
  if (k === "s3") return "s3";
  // 오타(S3, s3 ) 로 조용히 local 이 되면 state 가 디스크에만 남는다 → 멈춘다
  throw new Error("TF_STATE_BACKEND must be s3 or empty (local)");
}

const localHcl = (path: string) => `terraform {\n  backend "local" {\n    path = "${path}"\n  }\n}\n`;

/** backend 블록 하나 (backend.tf 로 쓴다). s3 면 dir 에 설정 파일 두 개(0600)를 쓴다 */
export function stateBackend(env: NodeJS.ProcessEnv, i: StateBackendInput): StateBackend {
  if (!KEY_RE.test(i.key) || i.key.includes("..")) throw new Error("state backend: bad key");
  if (stateBackendKind(env) === "local") return { kind: "local", hcl: localHcl(hclSafe("local path", i.localPath)) };

  const bucket = env.TF_STATE_BUCKET?.trim() ?? "";
  const roleArn = env.TF_STATE_ROLE_ARN?.trim() ?? "";
  const region = env.TF_STATE_REGION?.trim() ?? "";
  const missing = [["TF_STATE_BUCKET", bucket], ["TF_STATE_ROLE_ARN", roleArn], ["TF_STATE_REGION", region]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`TF_STATE_BACKEND=s3 needs ${missing.join(", ")}`);
  if (!BUCKET_RE.test(hclSafe("TF_STATE_BUCKET", bucket))) throw new Error("TF_STATE_BUCKET: not an S3 bucket name");
  if (!ROLE_ARN_RE.test(hclSafe("TF_STATE_ROLE_ARN", roleArn))) throw new Error("TF_STATE_ROLE_ARN: not an IAM role ARN");
  if (!REGION_RE.test(hclSafe("TF_STATE_REGION", region))) throw new Error("TF_STATE_REGION: not an AWS region");
  const cfg = hclSafe("work dir", join(i.dir, TF_STATE_CONFIG_FILE));
  const cred = hclSafe("work dir", join(i.dir, TF_STATE_CREDENTIALS_FILE));

  const config = [
    `[profile ${TF_STATE_PROFILE}]`,
    `role_arn = ${roleArn}`,
    // DRAFT(ai): 워커 자기 자격(EKS Pod Identity)을 소스로 tf-state 역할을 빌린다.
    //   【추정】 EcsContainer 는 AWS_CONTAINER_CREDENTIALS_FULL_URI + AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE(Pod Identity 가 주입)을 읽는다.
    //   terraform s3 backend(aws-sdk-go-v2) 에서 Pod Identity 로 실측하지 않았다. 두 변수는 PASS_ENV(AWS_*) 로 자식 env 에 넘어간다.
    // TODO(human): 안 되면 대안 = 워커 Node 에서 STS AssumeRole(TF_STATE_ROLE_ARN) → borrowed-aws.ts 처럼 credential_process 파일을 이 설정 파일에 둔다.
    `credential_source = EcsContainer`,
    `region = ${region}`,
    "",
  ].join("\n");
  writeFileSync(cfg, config, { mode: 0o600 });
  chmodSync(cfg, 0o600);
  writeFileSync(cred, "", { mode: 0o600 });
  chmodSync(cred, 0o600);

  const hcl = [
    "terraform {",
    `  backend "s3" {`,
    `    bucket                   = "${bucket}"`,
    `    key                      = "${i.key}"`,
    `    region                   = "${region}"`,
    `    encrypt                  = true`,
    `    use_lockfile             = true`,
    `    profile                  = "${TF_STATE_PROFILE}"`,
    `    shared_config_files      = ["${cfg}"]`,
    `    shared_credentials_files = ["${cred}"]`,
    "  }",
    "}",
    "",
  ].join("\n");
  return { kind: "s3", hcl, key: i.key };
}
