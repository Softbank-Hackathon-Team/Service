import type { EnvironmentView } from "./types";

// 환경 번호 → 이름. 목록에 없으면 fallback(번호 앞 8자 등)
export function envNameOf(envs: EnvironmentView[], id: string, fallback: (id: string) => string = (x) => x.slice(0, 8)): string {
  return envs.find((e) => e.id === id)?.name ?? fallback(id);
}
export const isMockEnv = (envs: EnvironmentView[], id: string) => envs.find((e) => e.id === id)?.provider === "azure_mock";

// Z83: 시험용 환경(부하 시험·e2e 가 만든 것). 목록에서 기본 접힘, 실 환경이 먼저
export const TEST_ENV_PREFIX = /^(load|e2e|test|tmp)-/i;
export const isTestEnv = (e: Pick<EnvironmentView, "name">) => TEST_ENV_PREFIX.test(e.name);
export function splitEnvs<T extends Pick<EnvironmentView, "name">>(envs: T[]): { real: T[]; test: T[] } {
  return { real: envs.filter((e) => !isTestEnv(e)), test: envs.filter(isTestEnv) };
}
