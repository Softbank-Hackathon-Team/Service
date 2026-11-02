import { z } from "zod";
import type { Provider } from "./common.js";
import type { Capability, HelmValues, ModuleRef, TargetEnv, TfOutputs, TfVars } from "./adapter.js";
import type { AppSpecV2 } from "./spec-v2.js";
import { TF_VAR_KINDS } from "./tf-kinds.js";

// DRAFT(ai): 도착 쪽 계약(Builder). 설계 27번 3.1 (A0).
//   Zod 는 계획서(PlanDoc.strict)에 들어갈 ModuleInstance 만. 함수 묶음은 직렬화 안 해서 인터페이스(adapter.ts 와 같은 CLAUDE.md 5-1 예외).
//   adapter.ts·spec-v2.ts·PlanDoc 은 이 파일에서 고치지 않는다 (PlanDoc 쪽 연결은 A3).

// 매트릭스 한 줄 = module.<종류>["<id>"]. kind 는 Terraform 종류 모듈 이름 (IR 리소스 유형 + namespace·identity)
export const ModuleKind = z.enum(TF_VAR_KINDS);
export type ModuleKind = z.infer<typeof ModuleKind>;
export const ModuleInstance = z.object({
  kind: ModuleKind,
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),   // IR id (for_each 키)
  module: z.string(),                                // 예: "aws/kinds/postgres"
}).strict();
export type ModuleInstance = z.infer<typeof ModuleInstance>;

// 권한 목적. adapters 의 Purpose 와 같은 값 (contracts 가 adapters 를 import 할 수 없어 다시 정의)
export const TargetPurpose = z.enum(["plan", "apply", "destroy"]);
export type TargetPurpose = z.infer<typeof TargetPurpose>;

export interface TfRootCall {
  root: ModuleRef;                  // infra/modules/<p>/root
  modules: ModuleRef[];             // 켜진 kinds/* 만, 경로 이름순
  vars: TfVars;                     // 평평한 값. 종류별 목록은 *_json 문자열
  instances: ModuleInstance[];      // 매트릭스 줄 = module.<종류>["<id>"]
}

export interface TargetBuilder {
  readonly provider: Provider;
  readonly version: string;         // 계획서 adapterVersion 에 들어감 (v2 경로면 이 값)
  capabilities(): Capability[];     // + "runtime.k8s", "kind.postgres", "render.sidecars" …
  toTerraformV2(spec: AppSpecV2, t: TargetEnv): TfRootCall;
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: TargetEnv): HelmValues;   // runtime=k8s 인 것만
  operateActionsV2(spec: AppSpecV2, purpose: TargetPurpose): string[];
  imageRef(src: string, t: TargetEnv): string;
}
