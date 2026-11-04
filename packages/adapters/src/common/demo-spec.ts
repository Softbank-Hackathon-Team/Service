import type { AppSpecV2 } from "@svc/contracts";
import { DEMO_INVENTORY } from "./fixtures.js";
import { normalizeV2 } from "../import/pipeline.js";

// 데모 명세 = 데모 원본(gcp: GKE 3티어 + Cloud SQL)을 가져오기 규칙 그대로 돌린 결과.
// 명세가 아직 없을 때 비용 미리보기 등이 쓴다. 손으로 쓴 값이 아니라 규칙에서 나오므로 가져오기와 어긋나지 않는다
export const DEMO_SPEC: AppSpecV2 = normalizeV2(DEMO_INVENTORY.gcp).result.spec;
