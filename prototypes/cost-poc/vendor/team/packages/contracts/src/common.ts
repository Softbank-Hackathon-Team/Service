import { z } from "zod";

// 모든 번호는 uuid 문자열이다
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

export const Provider = z.enum(["aws", "gcp", "onprem", "azure_mock"]);
export type Provider = z.infer<typeof Provider>;

// 모든 오류 응답의 한 모양
export const ApiError = z.object({
  status: z.number().int(),
  code: z.string(),          // 예: INVALID_TRANSITION
  message: z.string(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

// 시각은 ISO 8601 문자열로 주고받는다
export const Ts = z.iso.datetime({ offset: true });
