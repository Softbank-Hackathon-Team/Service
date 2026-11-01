import type { Provider, TargetEnv, TfOutputs } from "@svc/contracts";
import { AdapterError } from "./errors.js";

// 계약의 TargetEnv는 {envId, provider, region}뿐이다. 계정 번호·프로젝트·테넌트는 아직 칸이 없다.
// 넘겨주면(구조적으로 추가 칸) 쓰고, 없으면 "<env:키>" 자리표시를 넣는다.
// 자리표시는 apply 직전 worker가 연결 정보로 채운다 → 같은 입력이면 같은 출력(결정적).
// TODO(human): TargetEnv에 아래 칸을 정식으로 넣을지 (packages/contracts 소관, 통합 스레드에 요청함)
export interface TargetExtras {
  tenantId?: string;
  migrationId?: string;
  accountId?: string;      // aws
  projectId?: string;      // gcp
  networkId?: string;      // gcp: env 모듈 출력 (VPC self link)
  vpcId?: string;          // aws: env 모듈 출력
  subnetIds?: string[];    // aws: env 모듈 출력 (DB 서브넷)
  clusterName?: string;    // aws/gcp: env 모듈 출력
  clusterLocation?: string; // gcp: env 모듈 출력 (GKE 영역). contracts TargetEnv엔 아직 없음
  registryHost?: string;   // onprem / azure
  arch?: "amd64" | "arm64";
  moduleSha?: string;      // infra 모듈 git sha. 없으면 모듈 내용 지문
}
export type Target = TargetEnv & TargetExtras;

export const envRef = (k: string) => `<env:${k}>`;
export const tfOut = (k: string) => `<tf-output:${k}>`;

// DECISION(team): region이 "default"(plan 처리기가 넘기는 값)면 서울 리전을 쓴다 (10/31, AWS 계정·비용 가격표와 같은 리전)
const DEFAULT_REGION: Record<Provider, string> = {
  aws: "ap-northeast-2", gcp: "asia-northeast3", onprem: "local", azure_mock: "koreacentral",
};
export function regionOf(t: Target): string {
  return !t.region || t.region === "default" ? DEFAULT_REGION[t.provider] : t.region;
}

// tenantId가 없으면 envId로 대신한다 (envId도 테넌트 안에서 유일)
export const tenantOf = (t: Target) => t.tenantId ?? envRef("tenantId");
export const nameSeed = (t: Target) => t.tenantId ?? t.envId;

// apply 전(계획 단계)에는 out이 비어 있다 → 자리표시. apply 뒤엔 진짜 값
export const fromOut = (out: TfOutputs, k: string) => out[k] ?? tfOut(k);

export function digestOf(image: string): string {
  const i = image.indexOf("@sha256:");
  if (i < 0) throw new AdapterError("IMAGE_DIGEST_MISSING", `digest 없는 이미지: ${image}`);
  return image.slice(i + 1);
}

// 원본 이미지 주소의 마지막 경로 조각 = 저장소 이름 (registry/foo/bar@sha → bar)
// Z44: aws/index.ts 에 있던 것을 공통으로 옮김 (gcp·onprem·azure 가 aws 파일을 import 하던 것 정리). aws.repoName 으로도 그대로 보인다
export function repoName(src: string): string {
  return src.split("@")[0]!.split("/").pop()!.split(":")[0]!;
}
