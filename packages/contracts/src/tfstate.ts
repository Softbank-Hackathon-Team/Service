import { z } from "zod";
import { tenantSlug } from "./gitops.js";

// 고객 Terraform state 내려받기 계약 (api GET /migrations/:id/tfstate ↔ worker 안 창구 /internal/state/...)
// state 는 worker 디스크(TF_WORK_DIR)에만 있다. api 는 worker 창구에서 받아 그대로 흘려보낸다 (복사본 없음, 원본 안 지움)

/** app = 이전마다 앱 층(<회사>/<이전>/terraform.tfstate), env = 도착 환경 층(<회사>/env-<환경>/terraform.tfstate, GCP 자동 생성 때만 있음) */
export const TfStateLayer = z.enum(["app", "env"]);
export type TfStateLayer = z.infer<typeof TfStateLayer>;

export const TfStateQuery = z.object({ layer: TfStateLayer.default("app") }).strict();
export type TfStateQuery = z.infer<typeof TfStateQuery>;

/** 200 본문 = terraform.tfstate 그대로. 문서용 모양 (api 는 흘려보내므로 이 스키마로 직렬화·검사하지 않는다) */
export const TfStateFile = z.looseObject({
  version: z.number().int(),
  terraform_version: z.string().optional(),
  serial: z.number().int().optional(),
  lineage: z.string().optional(),
});

/** api 가 내는 오류 코드 (ApiError.code) */
export const TFSTATE_ERRORS = {
  notFound: "STATE_NOT_FOUND",                 // 404: worker 에 그 state 파일이 없음
  unavailable: "STATE_EXPORT_UNAVAILABLE",     // 503: worker 창구 연결 실패·시간 초과·5xx
  notConfigured: "STATE_EXPORT_NOT_CONFIGURED", // 503: api 에 WORKER_STATE_EXPORT_URL 또는 INTERNAL_STATE_TOKEN 없음
} as const;

/** worker 창구 경로 앞부분과 토큰 머리글. 양쪽이 이 값 하나를 본다 */
export const STATE_EXPORT_PATH_PREFIX = "/internal/state/";
export const STATE_EXPORT_TOKEN_HEADER = "x-internal-token";

/** api → worker 창구 경로. 회사 폴더 이름은 gitops tenantSlug 와 같다 (adapters TENANT_DIR_RE) */
export function stateExportPath(tenantId: string, layer: TfStateLayer, id: string): string {
  return `${STATE_EXPORT_PATH_PREFIX}${tenantSlug(tenantId)}/${layer}/${id}`;
}
