// APP-20 (지휘 결정 11/4 00:51Z, ADR-072 유지): 플랫폼은 비밀 값을 복사하지 않는다. 대신 gitops 커밋 전에 도착 비밀 그릇에 값(버전)이 들었는지 본다.
//   값이 없으면 ExternalSecret 동기가 실패해 파드가 못 뜨고 Argo Degraded → 그 전에 paused(SECRET_VALUES_MISSING)로 멈추고 어느 그릇인지 알려 준다.
//   읽기만 한다(버전 목록·이름). 값은 안 읽는다. CLI 는 워커 프로세스 자격 (실행 자격 env 는 코드에 없음)
import { spawnExec, type Exec } from "@svc/adapters";

export interface SecretValueCheck { ok: boolean; checked: string[]; missing: string[]; unknown: Array<{ key: string; error: string }> }

// DRAFT(ai): aws 는 AWSCURRENT 단계 버전이 하나라도 있으면, gcp 는 ENABLED 버전이 하나라도 있으면 "값 있음"
export async function checkSecretValues(o: { provider: "aws" | "gcp"; keys: string[]; projectId?: string | null; region: string; env?: NodeJS.ProcessEnv },
  exec: Exec = spawnExec): Promise<SecretValueCheck> {
  const out: SecretValueCheck = { ok: true, checked: [], missing: [], unknown: [] };
  for (const key of [...new Set(o.keys)].sort()) {
    const args = o.provider === "gcp"
      ? ["secrets", "versions", "list", key, ...(o.projectId ? [`--project=${o.projectId}`] : []), "--filter=state:ENABLED", "--limit=1", "--format=value(name)"]
      : ["secretsmanager", "list-secret-version-ids", "--secret-id", key, "--region", o.region,
         "--query", "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId", "--output", "text"];
    const r = await exec(o.provider === "gcp" ? "gcloud" : "aws", args, { cwd: process.cwd(), env: o.env ?? process.env, timeoutMs: 30_000 });
    out.checked.push(key);
    if (r.code === 0) { if (!r.stdout.trim() || r.stdout.trim() === "None") out.missing.push(key); continue; }
    // 그릇이 없음 = 값도 없음 (apply 가 안 만들었거나 지워짐)
    if (/NOT_FOUND|ResourceNotFoundException|was not found/i.test(r.stderr)) { out.missing.push(key); continue; }
    out.unknown.push({ key, error: r.stderr.trim().slice(0, 200) || `exit ${r.code}` });
  }
  out.ok = out.missing.length === 0 && out.unknown.length === 0;
  return out;
}
