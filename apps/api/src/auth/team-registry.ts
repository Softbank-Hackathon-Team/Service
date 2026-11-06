import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { TeamRegistry, type TeamSlot } from "@svc/contracts";
import { DomainError } from "@svc/core";
import { checkCreateEnvironment } from "../routes/environments.js";

// 팀 가입 명부 읽기 (POST /auth/signup). 서버가 뜰 때 한 번 읽고 검사해서 경로 플러그인이 들고 있는다 (요청마다 파일을 안 읽음)
//   파일: TEAM_REGISTRY_PATH (기본 /app/team-env/registry.yaml = api 이미지에 docs/team-env/registry.yaml 을 복사한 곳)
//   없거나 틀리면 가입만 꺼진다 (경고 한 줄, 서버는 뜬다). 이메일·GitHub 로그인은 그대로
// 명부를 바꾸려면: registry.yaml 고침 → 머지 → api 이미지 다시 빌드 (실행 중 다시 읽기는 없다)
export const DEFAULT_TEAM_REGISTRY_PATH = "/app/team-env/registry.yaml";
export const teamRegistryPath = (env: NodeJS.ProcessEnv = process.env) => env.TEAM_REGISTRY_PATH?.trim() || DEFAULT_TEAM_REGISTRY_PATH;

export type RegistryLoad =
  | { ok: true; registry: TeamRegistry; path: string }
  | { ok: false; path: string; reason: "missing" | "unreadable" | "bad_yaml" | "invalid"; issues: string[] };

const MAX_BYTES = 256 * 1024;

export function loadTeamRegistry(path: string = teamRegistryPath()): RegistryLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, path, reason: (e as { code?: string }).code === "ENOENT" ? "missing" : "unreadable", issues: [] };
  }
  if (text.length > MAX_BYTES) return { ok: false, path, reason: "invalid", issues: [`file larger than ${MAX_BYTES} bytes`] };
  let raw: unknown;
  try { raw = parseYaml(text); }
  catch (e) { return { ok: false, path, reason: "bad_yaml", issues: [String((e as Error).message ?? e).split("\n")[0]!.slice(0, 200)] }; }
  const p = TeamRegistry.safeParse(raw);
  if (!p.success)
    return { ok: false, path, reason: "invalid", issues: p.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  // POST /environments 와 같은 입력 검사 (AWS 리전·EKS 클러스터 이름). 가입 때 400 으로 터지기 전에 뜰 때 막는다
  const issues: string[] = [];
  p.data.slots.forEach((s, i) => s.environments.forEach((e, j) => {
    try { checkCreateEnvironment({ provider: e.provider, name: e.name, region: e.region, clusterName: e.cluster }); }
    catch (err) { issues.push(`slots.${i}.environments.${j}: ${err instanceof DomainError ? err.code : "invalid"}`); }
  }));
  if (issues.length) return { ok: false, path, reason: "invalid", issues };
  return { ok: true, registry: p.data, path };
}

/** 열린 자리(코드 해시가 있는 자리)가 하나라도 있으면 가입을 받는다 */
export const signupOpen = (r: TeamRegistry | null): boolean => !!r && r.slots.some((s) => s.signup_code_sha256 !== "");

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
const ZERO = Buffer.alloc(32);

/**
 * 로그인 → 자리, 초대 코드 확인. 자리 없음·닫힘·코드 틀림은 전부 null (부르는 쪽이 같은 403 을 낸다).
 * 셋 다 같은 계산(sha256 한 번 + 32바이트 고정 시간 비교)을 해서 응답 시간으로 로그인이 있는지 알 수 없게 한다
 */
export function matchSlot(r: TeamRegistry, login: string, code: string): TeamSlot | null {
  const want = login.trim().toLowerCase();
  const slot = r.slots.find((s) => s.login === want);
  const stored = slot && slot.signup_code_sha256 !== "" ? Buffer.from(slot.signup_code_sha256, "hex") : ZERO;
  const same = timingSafeEqual(sha256(code), stored);
  return slot && slot.signup_code_sha256 !== "" && same ? slot : null;
}
