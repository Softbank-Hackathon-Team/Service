import type { TargetBuilder } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { azureMockAdapter } from "../azure-mock/index.js";
import { UNSUPPORTED_V2 } from "./shared.js";

// Azure 는 Mock 만 (아키텍처 전제). v2 Builder 는 껍데기: capability 는 "mock" 하나, 렌더는 UNSUPPORTED_V2 (A10 전까지)
// STUB: A10 에서 capability·mock plan 만 채움
const nope = (): never => { throw new AdapterError(UNSUPPORTED_V2, "도착 렌더 미지원: azure_mock 은 v2 Builder 가 없음 (A10)"); };
export const azureMockTarget: TargetBuilder = {
  provider: "azure_mock",
  version: "azure-mock-target@0.0.0",
  capabilities: () => ["mock"],
  imageRef: (src, t) => azureMockAdapter.imageRef(src, t),
  operateActionsV2: () => [],   // Mock 이라 실행 권한 없음 (v1 과 같음)
  toTerraformV2: nope,
  toWorkloadValues: nope,
};
