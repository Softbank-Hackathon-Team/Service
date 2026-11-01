// cleanup-flood.sh 가 부른다. seed: 고아 rollback_window 이전 + cleanup 작업. measure: 새 이전의 창 끝 → completed 시간 + 고아 반복 수
import { randomUUID } from "node:crypto";
import { owner, TENANT } from "./lib.js";

const mode = process.argv[2];
const TAG = "flood-orphan";
if (mode === "seed") {
  const n = Number(process.env.FLOOD ?? 500);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID(), src = randomUUID(), dst = randomUUID();
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
      ($1,$3,'aws',$4,'connected'), ($2,$3,'gcp',$5,'connected')`, [src, dst, TENANT, `${TAG}-s-${i}`, `${TAG}-d-${i}`]);
    await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, rollback_window_ends_at)
      VALUES ($1,$2,$3,$4,'rollback_window', now() - interval '1 hour')`, [id, TENANT, src, dst]);
    await owner.query(`INSERT INTO pgboss.job (name, data, singleton_key, policy) VALUES ('cleanup', $1, $2, 'stately')`,
      [{ tenantId: TENANT, requestId: `r-${TAG}`, migrationId: id }, `cleanup:${id}`]);
    ids.push(id);
  }
  console.log(`seeded orphans=${ids.length}`);
} else {
  const RUN_START = new Date(Number(process.env.RUN_START));
  const fresh = (await owner.query(
    // 창 끝 = rollback_window 에 들어간 시각 + ROLLBACK_WINDOW_SEC (rollback_window_ends_at 은 정리 뒤 비워진다)
    `SELECT m.id, m.status, (extract(epoch from (SELECT max(at) FROM audit_events a WHERE a.target = m.id::text AND a.action LIKE '%.completed')
                                   - (SELECT max(at) FROM audit_events a WHERE a.target = m.id::text AND a.action LIKE '%.rollback_window'))
                             - $2)::float AS s
       FROM migrations m JOIN environments e ON e.id = m.source_env_id
      WHERE m.created_at >= $1 AND e.name NOT LIKE '${TAG}-%'`, [RUN_START, Number(process.env.ROLLBACK_WINDOW_SEC ?? 3)])).rows as { id: string; status: string; s: number | null }[];
  const orphanRuns = (await owner.query(
    `SELECT count(*)::int n FROM pgboss.job j JOIN migrations m ON m.id::text = j.data->>'migrationId' JOIN environments e ON e.id = m.source_env_id
      WHERE j.name = 'cleanup' AND e.name LIKE '${TAG}-%'`)).rows[0].n as number;
  const orphans = (await owner.query(
    `SELECT count(*)::int n FROM migrations m JOIN environments e ON e.id = m.source_env_id WHERE e.name LIKE '${TAG}-%'`)).rows[0].n as number;
  const done = fresh.filter((f) => f.status === "completed" && f.s != null).map((f) => f.s!);
  const max = done.length ? Math.max(...done) : NaN;
  const p50 = done.length ? [...done].sort((a, b) => a - b)[Math.floor(done.length / 2)]! : NaN;
  console.log(`fresh=${fresh.length} completed=${done.length} window_end_to_completed_s p50=${p50.toFixed(2)} max=${max.toFixed(2)}`);
  console.log(`orphans=${orphans} orphan_cleanup_jobs_total=${orphanRuns} (반복 없음이면 = orphans)`);
  const ok = done.length === fresh.length && max <= 2 && orphanRuns <= orphans;
  console.log(ok ? "FLOOD VERDICT PASS" : "FLOOD VERDICT FAIL");
  await owner.end();
  process.exit(ok ? 0 : 1);
}
await owner.end();
