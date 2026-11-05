import { ReplicationEndpoint } from "@svc/contracts";
import type { Tx } from "./db.js";

// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// 이전마다 복제 끝점 읽기·쓰기 (db 0050). withTenant 안에서만 (RLS 가 남의 회사 줄을 숨긴다)
// password_ref 는 참조 글자 그대로 읽고 쓴다. 진짜 비밀번호는 여기서 만들지 않는다 (워커 @svc/replication 이 실행할 때만)

type Row = {
  tenant_id: string; migration_id: string; side: string; label: string; provider: string; host: string; port: number;
  dbname: string; username: string; password_ref: string; peer_host: string | null; peer_port: number | null; app_role: string;
  fence_roles: string[]; schema_name: string | null; sslmode: string | null; tls_servername: string | null; ca_pem: string | null;
};
const COLS = `tenant_id, migration_id, side, label, provider, host, port, dbname, username, password_ref, peer_host, peer_port,
  app_role, fence_roles, schema_name, sslmode, tls_servername, ca_pem`;

const fromRow = (r: Row): ReplicationEndpoint => ReplicationEndpoint.parse({
  tenantId: r.tenant_id, migrationId: r.migration_id, side: r.side, label: r.label, provider: r.provider, host: r.host, port: r.port,
  dbname: r.dbname, username: r.username, passwordRef: r.password_ref, peerHost: r.peer_host, peerPort: r.peer_port, appRole: r.app_role,
  fenceRoles: r.fence_roles, schemaName: r.schema_name, sslmode: r.sslmode, tlsServername: r.tls_servername, caPem: r.ca_pem,
});

/** 이 이전의 끝점 줄 (0·1·2줄, source 먼저). 남의 회사 이전이면 빈 목록 */
export async function replicationEndpointsFor(tx: Tx, migrationId: string): Promise<ReplicationEndpoint[]> {
  const r = await tx.query<Row>(`SELECT ${COLS} FROM replication_endpoints WHERE migration_id = $1 ORDER BY side`, [migrationId]);
  return r.rows.map(fromRow);
}

/** 한쪽 등록. 같은 이전·같은 쪽이면 덮어쓴다. 회사 번호는 행 값과 withTenant 값이 같아야 한다 (RLS WITH CHECK) */
export async function upsertReplicationEndpoint(tx: Tx, e: ReplicationEndpoint): Promise<void> {
  const v = ReplicationEndpoint.parse(e);
  // 같은 이전·같은 쪽 줄이 다른 회사 것이면 아래 WHERE 로 0줄이 된다 (조용히 성공하면 안 됨) → 오류. 남의 이전인지 아닌지 안 드러나게 같은 글자
  const r = await tx.query(
    `INSERT INTO replication_endpoints (${COLS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (migration_id, side) DO UPDATE SET label = EXCLUDED.label, provider = EXCLUDED.provider, host = EXCLUDED.host,
       port = EXCLUDED.port, dbname = EXCLUDED.dbname, username = EXCLUDED.username, password_ref = EXCLUDED.password_ref,
       peer_host = EXCLUDED.peer_host, peer_port = EXCLUDED.peer_port, app_role = EXCLUDED.app_role, fence_roles = EXCLUDED.fence_roles,
       schema_name = EXCLUDED.schema_name, sslmode = EXCLUDED.sslmode, tls_servername = EXCLUDED.tls_servername, ca_pem = EXCLUDED.ca_pem,
       updated_at = now()
     WHERE replication_endpoints.tenant_id = EXCLUDED.tenant_id`,
    [v.tenantId, v.migrationId, v.side, v.label, v.provider, v.host, v.port, v.dbname, v.username, v.passwordRef, v.peerHost, v.peerPort,
      v.appRole, v.fenceRoles, v.schemaName, v.sslmode, v.tlsServername, v.caPem]);
  if (r.rowCount !== 1) throw new Error(`복제 끝점을 못 썼다: 이전 ${v.migrationId} 이 이 회사에 없다`);
}
