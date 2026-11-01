import { z } from "zod";
import { Provider } from "./common.js";

// 환경 연결 상태 8개
export const ConnectionStatus = z.enum([
  "draft", "awaiting_customer", "verifying", "connected",
  "unstable", "failed", "expired", "disconnected",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

// 화면이 받는 환경 한 개
export const EnvironmentView = z.object({
  id: z.uuid(),
  provider: Provider,
  name: z.string(),
  connectionStatus: ConnectionStatus,
  accountId: z.string().nullable(),     // 고객 계정 번호 (확인 뒤)
  lastVerifiedAt: z.string().nullable(),
  failureReason: z.string().nullable(), // 예: 권한 부족 + 동작 이름
}).strict();
export type EnvironmentView = z.infer<typeof EnvironmentView>;

// 연결 링크 발급 응답
export const ConnectionLink = z.object({
  url: z.url(),           // CloudFormation 빠른 생성 / Cloud Shell / Agent 설치 한 줄
  externalId: z.string(), // 확인 문구 (비밀 아님, 회사마다 다름)
  expiresAt: z.string(),  // 24시간
}).strict();
