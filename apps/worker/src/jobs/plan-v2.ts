import type { AppSpecV2, HelmValues, Provider, TfRootCall } from "@svc/contracts";
import { targetBuilderFor, withDbNetworkV2 } from "@svc/adapters";

// TA3 DRAFT(ai): 계획·적용·배포의 공통 조각 (설계 27번 3.5). 계획(plan)·적용(apply-real)·배포(deploy)가 같은 함수를 불러야
//   지문이 같다 (사람이 본 계획 = 실행할 계획)

// G8-1: migrationId 는 자원 이름 seed (같은 앱을 같은 환경으로 다시 옮겨도 이름이 안 겹치게). 계획·apply·배포가 같은 값을 넣어야 지문이 같다
export interface TargetRef { envId: string; provider: Provider; region: string; migrationId?: string }

/** 계획·적용이 같이 쓰는 Terraform 입력 (데모 DB 네트워크 변수 포함) */
export function tfCallV2(spec: AppSpecV2, t: TargetRef, env: NodeJS.ProcessEnv = process.env): TfRootCall {
  return withDbNetworkV2(targetBuilderFor(t.provider).toTerraformV2(spec, t), t.provider, env);
}

/** 계획·배포가 같이 쓰는 Helm 값 (출력 빈 값 = 자리표시) */
export function helmValuesV2(spec: AppSpecV2, t: TargetRef): HelmValues {
  return targetBuilderFor(t.provider).toWorkloadValues(spec, {}, t);
}

export const builderVersion = (p: Provider) => targetBuilderFor(p).version;
