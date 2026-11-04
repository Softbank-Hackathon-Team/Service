import { hash6 } from "../common/names.js";

// Azure Mock 가짜 식별자 (실행기·도착 Builder 가 같이 쓴다)
// 모양만 맞춘 가짜 구독 번호 (packages/adapters/scripts/write-tfvars.ts와 같은 값)
export const MOCK_SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";

// 해시로 만든 UUID 모양 문자열 (클라이언트 ID 같은 칸에 넣는 가짜 값)
export function fakeUuid(...parts: string[]): string {
  const h = [0, 1, 2, 3, 4, 5].map((i) => hash6(...parts, String(i))).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const resourceGroupOf = (envId: string) => `rg-platform-${hash6(envId)}`;
