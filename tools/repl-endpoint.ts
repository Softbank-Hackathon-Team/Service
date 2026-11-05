// 이전마다 복제 끝점 등록·보기 (db 0050 replication_endpoints). 운영자·중계기 스크립트가 쓴다
// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
//   npm run repl:endpoint -- set --tenant <회사> --migration <이전> --side source|target --label aws-rds-src --provider rds \
//        --host db.example.internal --port 5432 --dbname shop --user repl_admin --password-ref derive:admin \
//        [--peer-host 10.0.0.5] [--peer-port 5432] [--app-role shop_app] [--fence-roles a,b] [--schema public] \
//        [--sslmode require|verify-ca|verify-full] [--tls-servername db.example.com] [--ca-file ca.pem]
//        [--relay-host 203.0.113.7 --relay-known-hosts-file relay_known_hosts [--relay-port 22]]   (도착 줄만: 온프레 터널 중계기)
//   npm run repl:endpoint -- show --tenant <회사> --migration <이전>
//   npm run repl:endpoint -- pubkey --tenant <회사> --migration <이전>
//     이 이전의 터널 SSH 공개 키 한 줄 (중계기 tunnel_public_key). REPL_SECRET_MASTER_KEY 로 파생 = 워커가 봉인하는 개인 키의 짝. DB 안 씀
// 비밀번호는 참조 글자로만 받는다 (derive:<용도> | env:REPL_SECRET_<이름>). 진짜 비밀번호 플래그는 없다.
// show 는 password_ref 를 그대로 보여 주고, 풀린 값은 절대 출력하지 않는다. 이 도구는 참조를 풀지 않는다
// 필요한 .env: DATABASE_URL (app_user, RLS 아래). 회사는 --tenant 로 꼭 준다 (기본값 없음)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ReplicationEndpoint } from "@svc/contracts";
import { pool, replicationEndpointsFor, upsertReplicationEndpoint, withTenant } from "@svc/core";
// 워커와 같은 파생 (tools/seal-test.ts 와 같은 방식으로 워커 파일을 직접 쓴다). 개인 키는 출력하지 않는다
import { deriveSshKeypair } from "../apps/worker/src/gitops/migration-secrets.js";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const need = (n: string) => { const v = opt(n); if (v === undefined || v.startsWith("--")) throw new Error(`--${n} 필요`); return v; };
const int = (n: string, v: string) => { if (!/^\d+$/.test(v)) throw new Error(`--${n} 는 숫자`); return Number(v); };
const USAGE = "사용: repl-endpoint.ts set --tenant <uuid> --migration <uuid> --side source|target --label … --provider … --host … --port … --dbname … --user … --password-ref derive:<용도>|env:REPL_SECRET_<이름> [옵션] | show --tenant <uuid> --migration <uuid> | pubkey --tenant <uuid> --migration <uuid>";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const cmd = args[0];
  // 진짜 비밀번호를 플래그로 넘기려는 실수를 막는다 (셸 기록·프로세스 목록에 남는다)
  if (args.some((a) => a === "--password" || a.startsWith("--password="))) throw new Error("--password 는 없다. --password-ref derive:<용도> 또는 env:REPL_SECRET_<이름> 만 받는다");
  const tenantId = need("tenant"), migrationId = need("migration");
  if (cmd === "pubkey") {
    // 공개 키만. 회사·이전 번호가 uuid 가 아니면 워커가 쓰는 값과 달라지므로 막는다
    if (!UUID.test(tenantId) || !UUID.test(migrationId)) throw new Error("--tenant·--migration 은 uuid");
    console.log(deriveSshKeypair(process.env.REPL_SECRET_MASTER_KEY ?? "", tenantId, migrationId).publicKeyLine);
    return;
  }
  if (cmd === "set") {
    const peerPort = opt("peer-port"), caFile = opt("ca-file"), relayFile = opt("relay-known-hosts-file"), relayPort = opt("relay-port");
    const rec = ReplicationEndpoint.parse({
      tenantId, migrationId,
      side: need("side"), label: need("label"), provider: need("provider"),
      host: need("host"), port: int("port", need("port")), dbname: need("dbname"), username: need("user"),
      passwordRef: need("password-ref"),
      peerHost: opt("peer-host") ?? null, peerPort: peerPort ? int("peer-port", peerPort) : null,
      appRole: opt("app-role") ?? "app_user",
      fenceRoles: (opt("fence-roles") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      schemaName: opt("schema") ?? null, sslmode: opt("sslmode") ?? null, tlsServername: opt("tls-servername") ?? null,
      caPem: caFile ? readFileSync(caFile, "utf8") : null,
      relayHost: opt("relay-host") ?? null,
      relayKnownHosts: relayFile ? readFileSync(relayFile, "utf8").trim() : null,
      relayPort: relayPort ? int("relay-port", relayPort) : 22,
    });
    await withTenant(tenantId, (tx) => upsertReplicationEndpoint(tx, rec));
    console.log(JSON.stringify({ ok: true, migrationId, side: rec.side, label: rec.label, host: rec.host, port: rec.port, passwordRef: rec.passwordRef,
      ...(rec.relayHost ? { relayHost: rec.relayHost, relayPort: rec.relayPort } : {}) }));
  } else if (cmd === "show") {
    const rows = await withTenant(tenantId, (tx) => replicationEndpointsFor(tx, migrationId));
    // CA PEM 은 길어서 지문(sha256 앞 16자)만. 공개 값이지만 화면을 덮지 않게
    const view = rows.map((r) => ({ ...r, caPem: r.caPem ? `sha256:${createHash("sha256").update(r.caPem).digest("hex").slice(0, 16)}` : null }));
    console.log(JSON.stringify({ ok: true, migrationId, endpoints: view }, null, 2));
  } else {
    throw new Error(USAGE);
  }
}
main().then(() => pool.end(), async (e) => {
  // zod 오류 원문에는 입력값이 들어갈 수 있다 → 경로·메시지만
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  const error = issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
  console.error(JSON.stringify({ ok: false, error }));
  await pool.end(); process.exit(1);
});
