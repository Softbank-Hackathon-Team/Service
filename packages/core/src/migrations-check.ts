import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "./obs/log.js";

// PF FM-ORC-26: 시작할 때 안 넣은 DB 마이그레이션이 있으면 분명한 오류로 멈춘다.
//   예전엔 base 를 바꾸고 db:migrate 를 잊어도 readyz ok·워커 정상 → shifting 에서 traffic_lease_take 없음으로 paused, 롤백도 ROLLBACK_FAILED.
// 비교: 레포 db/migrations/NNNN_*.sql 번호 ⟷ migrate.applied (tools/db-migrate.sh 기록, 0042 가 app_user 에 읽기를 연다)
// DRAFT(ai): 끄기 MIGRATION_CHECK=0 (컨테이너 배포처럼 레포 폴더가 없으면 저절로 건너뜀). 기록 표가 없는 DB(docker 초기화 폴더)는 경고만
export type MigrationCheck =
  | { ok: true; applied: number; files: number }
  | { ok: false; pending: string[]; reason: "pending" | "no_read_access" }
  | { ok: true; skipped: string };

type Q = { query: (sql: string) => Promise<{ rows: Array<{ version: string }> }> };

export function migrationFiles(dir = defaultDir()): string[] | null {
  try { return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort(); } catch { return null; }
}
function defaultDir(): string {
  return process.env.MIGRATIONS_DIR || fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
}

export async function checkMigrations(db: Q, o: { env?: NodeJS.ProcessEnv; dir?: string } = {}): Promise<MigrationCheck> {
  const env = o.env ?? process.env;
  if (env.MIGRATION_CHECK === "0") return { ok: true, skipped: "MIGRATION_CHECK=0" };
  const files = migrationFiles(o.dir ?? (env.MIGRATIONS_DIR || undefined));
  if (!files) return { ok: true, skipped: "no migrations dir" };
  let applied: Set<string>;
  try {
    applied = new Set((await db.query("SELECT version FROM migrate.applied")).rows.map((r) => r.version));
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 42501 = 읽기 권한 없음 → 0042 도 아직 안 넣음. 그 뒤 번호는 전부 남았다고 본다
    if (code === "42501") return { ok: false, reason: "no_read_access", pending: files.filter((f) => f.slice(0, 4) >= "0042") };
    // 3F000·42P01 = 기록 표 없음 (docker 초기화 폴더 DB). 판정 못 함
    if (code === "3F000" || code === "42P01") return { ok: true, skipped: "no migrate.applied (docker init DB?)" };
    throw e;
  }
  const pending = files.filter((f) => !applied.has(f.slice(0, 4)));
  return pending.length ? { ok: false, reason: "pending", pending } : { ok: true, applied: applied.size, files: files.length };
}

/** main 에서 부른다. 남은 마이그레이션이 있으면 사람용 줄 + 끝 코드 2 */
export async function assertMigrations(service: string, db: Q, o: { env?: NodeJS.ProcessEnv; dir?: string; exit?: (code: number) => void; log?: (line: string) => void } = {}): Promise<MigrationCheck> {
  const r = await checkMigrations(db, o);
  const lg = createLogger(service, { component: "migrations" });
  if ("skipped" in r) { lg.warn({ skipped: r.skipped }, "migration check skipped"); return r; }
  if (r.ok) return r;
  lg.error({ pending: r.pending, reason: r.reason }, "db migrations pending: not starting");
  const say = o.log ?? ((l: string) => process.stderr.write(l + "\n"));
  say(`DB 마이그레이션 ${r.pending.length}개를 안 넣음 (${service} 시작 안 함): ${r.pending.join(", ")}`);
  say("  → npm run db:migrate 뒤 다시 시작 (일부러 건너뛰려면 MIGRATION_CHECK=0)");
  (o.exit ?? ((c: number) => process.exit(c)))(2);
  return r;
}
