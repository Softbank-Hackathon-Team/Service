import type { AppSpecV2, HelmValues, Provider, TfRootCall } from "@svc/contracts";
import { targetBuilderFor, withDbNetworkV2 } from "@svc/adapters";

// TA3 DRAFT(ai): PLAN_IR=v2 길의 공통 조각 (설계 27번 3.5). 계획(plan)·적용(apply-real)·배포(deploy)가 같은 함수를 불러야
//   지문이 같다 (사람이 본 계획 = 실행할 계획). 깃발은 계획 단계에서만 본다. apply·deploy 는 계획서 irVersion 으로 고른다

/** 깃발. 기본 v1 (= 지금 동작). IMPORT_IR 과 따로 (가져오기는 v2 로 쌓으면서 계획·적용은 v1 로 데모 지킴) */
export const planIrV2 = (env: NodeJS.ProcessEnv = process.env) => env.PLAN_IR?.trim() === "v2";

export interface TargetRef { envId: string; provider: Provider; region: string }

/** 계획·적용이 같이 쓰는 Terraform 입력 (데모 DB 네트워크 변수 포함, v1 withDbNetwork 와 같은 규칙) */
export function tfCallV2(spec: AppSpecV2, t: TargetRef, env: NodeJS.ProcessEnv = process.env): TfRootCall {
  return withDbNetworkV2(targetBuilderFor(t.provider).toTerraformV2(spec, t), t.provider, env);
}

/** 계획·배포가 같이 쓰는 Helm 값 (출력 빈 값 = 자리표시) */
export function helmValuesV2(spec: AppSpecV2, t: TargetRef): HelmValues {
  return targetBuilderFor(t.provider).toWorkloadValues(spec, {}, t);
}

export const builderVersion = (p: Provider) => targetBuilderFor(p).version;
