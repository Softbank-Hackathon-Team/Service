// APP-20 (지휘 결정 11/4 00:51Z, ADR-072 유지): 플랫폼은 비밀 값을 복사하지 않는다. 대신 gitops 커밋 전에 도착 비밀 그릇에 값(버전)이 들었는지 본다.
//   값이 없으면 ExternalSecret 동기가 실패해 파드가 못 뜨고 Argo Degraded → 그 전에 paused(SECRET_VALUES_MISSING)로 멈추고 어느 그릇인지 알려 준다.
//   읽기만 한다(버전 메타데이터). 값은 안 읽는다. CLI 는 도착 실행 역할을 빌린 env 로 부른다 (deploy.ts secret_check)
import { spawnExec, type Exec } from "@svc/adapters";

export interface SecretValueCheck { ok: boolean; checked: string[]; missing: string[]; unknown: Array<{ key: string; error: string }> }

/** 명령 출력 → 값이 있나. aws: 지워지는 중이 아니고 AWSCURRENT 버전이 있음. gcp: 최신 버전이 ENABLED */
function hasValue(provider: "aws" | "gcp", stdout: string): boolean {
  if (provider === "gcp") return stdout.trim() === "ENABLED";
  try {
    const d = JSON.parse(stdout) as { deleted?: unknown; stages?: Record<string, string[]> | null };
    return !d.deleted && Object.values(d.stages ?? {}).some((s) => s.includes("AWSCURRENT"));
  } catch { return false; }
}

// DRAFT(ai): 고객 역할에 이미 있는 읽기만 쓴다. aws secretsmanager:DescribeSecret, gcp secretmanager.versions.get. 고객 템플릿을 다시 돌리지 않아도 된다
export async function checkSecretValues(o: { provider: "aws" | "gcp"; keys: string[]; projectId?: string | null; region: string; env?: NodeJS.ProcessEnv },
  exec: Exec = spawnExec): Promise<SecretValueCheck> {
  const out: SecretValueCheck = { ok: true, checked: [], missing: [], unknown: [] };
  for (const key of [...new Set(o.keys)].sort()) {
    const args = o.provider === "gcp"
      ? ["secrets", "versions", "describe", "latest", `--secret=${key}`, ...(o.projectId ? [`--project=${o.projectId}`] : []), "--format=value(state)"]
      : ["secretsmanager", "describe-secret", "--secret-id", key, "--region", o.region,
         "--query", "{deleted:DeletedDate,stages:VersionIdsToStages}", "--output", "json"];
    const r = await exec(o.provider === "gcp" ? "gcloud" : "aws", args, { cwd: process.cwd(), env: o.env ?? process.env, timeoutMs: 30_000 });
    out.checked.push(key);
    if (r.code === 0) { if (!hasValue(o.provider, r.stdout)) out.missing.push(key); continue; }
    // 그릇이 없음 = 값도 없음 (apply 가 안 만들었거나 지워짐)
    if (/NOT_FOUND|ResourceNotFoundException|was not found/i.test(r.stderr)) { out.missing.push(key); continue; }
    out.unknown.push({ key, error: r.stderr.trim().slice(0, 200) || `exit ${r.code}` });
  }
  out.ok = out.missing.length === 0 && out.unknown.length === 0;
  return out;
}
