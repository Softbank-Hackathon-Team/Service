// 온프레 CNPG 로의 DB 이전에 필요한 것을 gitops 배포 값으로 배달한다 (끌어오기 모델, 사람이 비밀을 옮기지 않는다)
// DECISION(team): 온프레 CNPG 로의 DB 복제는 이전마다 최소 권한 역할 + 플랫폼이 발급한 CNPG 서버 인증서 + SSH 터널을 쓴다.
//   플랫폼은 비밀을 저장하지 않는다: 마스터 키 + 번호로 파생하고, SealedSecret 으로 봉인해 gitops 레포에 커밋한다 (2026-11-05 팀 결정)
// 무엇을 넣나 (차트 계약 packages/contracts chart-values.ts, 차트 gitops/charts/app):
//   postgres[i].certificates   = <cnpg>-server-ca (ca.crt) + <cnpg>-server-tls (kubernetes.io/tls)
//   sealedSecrets[]            = <cnpg>-migrate (basic-auth, 이전 역할 비밀번호) · <cnpg>-server-ca · <cnpg>-server-tls · db-tunnel-key (id = 터널 개인 키)
//   dbTunnel                   = 도착 줄의 중계기 사실 + 정방향 목적지 = 출발 줄 host:port + 역방향 켬
// 그리고 끝점 줄에 되쓴다: 도착 줄 ca_pem·tls_servername·sslmode=verify-full·sealed_material, 출발 줄 peer = db-tunnel.<ns>.svc:5432 (비어 있을 때만)
//
// 다시 렌더해도 같은 바이트 (리허설 지문·재개가 어긋나지 않게):
//   봉인은 무작위 세션 키라 같은 평문도 매번 다른 암호문이 되고, 서버 인증서도 매번 새 키·일련번호다. 그런데 리허설은 렌더(작업 1회)와
//   커밋(다른 작업 실행)을 나눠 하고, 커밋 직전 렌더 지문이 리허설 지문과 다르면 REHEARSAL_BUNDLE_MISMATCH 로 멈춘다 (repo.ts commitBundle).
//   그래서 처음 봉인한 암호문을 도착 줄 sealed_material 에 남기고, 다음 렌더는 입력 지문(digest)이 같으면 그 암호문을 그대로 다시 쓴다.
//   DRAFT(ai): 대안 "결정적 봉인(세션 키·OAEP seed 를 HMAC 으로)" 은 버림: 서버 인증서의 ECDSA 서명이 openssl 에서 무작위라 인증서까지는
//   결정적으로 못 만든다. 대안 "지문 비교에서 봉인 값 빼기" 도 버림: 묶음 지문은 gitops 레포 render.mjs 가 계산한다 (이 레포 밖)
import { createHash, createHmac, X509Certificate } from "node:crypto";
import type { ChartDbTunnel, ChartPgCertificates, ChartSealedSecret, HelmValues, ReplicationEndpoint, ReplicationSealedMaterial } from "@svc/contracts";
import type { ReplicationDeliveryWrite } from "@svc/core";
import {
  MIN_MASTER_KEY_LENGTH, MigrationSecretError, cnpgServerDnsNames, deriveCaSeed, derivePassword, deriveSshKeypair, issueServerCert,
  sealedSecretValues, type OpensslDeps, type ServerCert, type ServerCertInput,
} from "./migration-secrets.js";
import { configFromEnv, GitopsRepo } from "./repo.js";
import type { BundleRef } from "./bundle.js";

// 【사실】 deploy/helm/onprem-db-tunnel/values.yaml 의 image 와 같은 글자 (시험이 두 값을 맞춘다). ssh 클라이언트만 쓴다
export const DB_TUNNEL_IMAGE = "alpine/git:v2.54.0@sha256:ac6c828f15d82775d204d3d75112e1d34af8945da80ccf922713c9891ba68e7a";
export const DB_TUNNEL_KEY_SECRET = "db-tunnel-key";
/** 이전 역할 비밀번호의 derive 용도. 도착 줄 password_ref 가 derive:migrate 이면 워커가 같은 비밀번호로 붙는다 */
export const MIGRATE_PURPOSE = "migrate";
// DRAFT(ai): 서버 인증서·CA 수명 365일, 남은 날이 30일보다 적으면 다시 발급한다 (이전 한 번 + 롤백 창보다 넉넉하게)
export const SERVER_CERT_DAYS = 365;
export const SERVER_CERT_RENEW_DAYS = 30;

export const tunnelServiceHost = (namespace: string) => `db-tunnel.${namespace}.svc`;
export const cnpgServername = (cnpg: string, namespace: string) => `${cnpg}-rw.${namespace}.svc`;
export const serverCaSecret = (cnpg: string) => `${cnpg}-server-ca`;
export const serverTlsSecret = (cnpg: string) => `${cnpg}-server-tls`;

export type DeliveryCode = "SEALING_CERT_MISSING" | "REPL_SECRET_UNRESOLVED" | "REPL_DELIVERY_FAILED";
export class DeliveryError extends Error {
  constructor(readonly code: DeliveryCode, message: string) { super(message); this.name = "DeliveryError"; }
}

interface PgEntry { mode?: string; name?: string; replication?: { enabled?: boolean; role?: string; passwordSecret?: string; ensure?: string }; [k: string]: unknown }
export interface CnpgTarget { index: number; name: string; role: string; passwordSecret: string }

/** 값 postgres[] 중 이전 복제를 켠 CNPG (어댑터 onprem.ts 가 replication.enabled 를 넣는다). 기본값은 차트 cnpg.yaml 과 같다 */
export function replicationCnpgs(values: HelmValues): CnpgTarget[] {
  const pgs = (values.postgres as PgEntry[] | undefined) ?? [];
  return pgs.flatMap((p, index) => p.mode === "cnpg" && p.name && p.replication?.enabled
    ? [{ index, name: p.name, role: p.replication.role ?? "svc_migrate", passwordSecret: p.replication.passwordSecret ?? `${p.name}-migrate` }] : []);
}

export interface DeliveryInput {
  tenantId: string;
  migrationId: string;
  namespace: string;
  cnpg: CnpgTarget;
  source: ReplicationEndpoint;
  target: ReplicationEndpoint;
  /** 온프레 CNPG 줄이 어느 쪽인가 (기본 target = AWS→온프레, source = 온프레→AWS, ADR-031 R4). 그 줄에 중계기 칸·인증서·봉인 값이 붙는다 */
  onpremSide?: "source" | "target";
  sealingCertPem: string;
  masterKey: string;
  stored: ReplicationSealedMaterial | null;
  now?: Date;
}

export interface ReplicationDelivery {
  cnpg: CnpgTarget;
  certificates: ChartPgCertificates;
  sealedSecrets: ChartSealedSecret[];
  dbTunnel: ChartDbTunnel;
  /** 끝점 줄에 되쓸 것. 저장된 값을 그대로 다시 썼고 줄도 이미 맞으면 null */
  write: ReplicationDeliveryWrite | null;
  /** true = 도착 줄 sealed_material 의 암호문을 다시 씀 (새로 봉인·발급 안 함) */
  reused: boolean;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** 봉인 입력 지문. 평문은 전부 (마스터 키, 회사, 이전)에서 파생되므로 마스터 키로 HMAC 하면 키를 바꿨을 때도 다시 봉인한다.
 *  봉인 인증서(컨트롤러 키)·네임스페이스·이름이 바뀌어도 다시 봉인한다 (strict 범위 = 이름·네임스페이스에 묶임) */
export function deliveryDigest(i: Pick<DeliveryInput, "tenantId" | "migrationId" | "namespace" | "cnpg" | "sealingCertPem" | "masterKey">): string {
  let cert: X509Certificate;
  try { cert = new X509Certificate(i.sealingCertPem); } catch {
    throw new DeliveryError("SEALING_CERT_MISSING", "봉인 인증서 PEM 을 읽을 수 없다");
  }
  const facts = { v: 1, tenantId: i.tenantId, migrationId: i.migrationId, namespace: i.namespace, cnpg: i.cnpg.name, role: i.cnpg.role,
    passwordSecret: i.cnpg.passwordSecret, keySecret: DB_TUNNEL_KEY_SECRET, sealingCert: sha256(cert.raw), certDays: SERVER_CERT_DAYS };
  return createHmac("sha256", i.masterKey).update(JSON.stringify(facts)).digest("hex");
}

// 봉인 비밀 한 칸의 글자 순서를 고정한다 (name, type, encryptedData 키 정렬). 저장 칸이 jsonb 라 읽어 오면 키 순서가 바뀐다
//   → 순서를 안 고치면 처음 렌더(새로 봉인)와 다음 렌더(저장 값)의 values.yaml 글자가 달라 리허설 지문이 어긋난다 (DB 시험에서 재현)
const canonical = (s: ChartSealedSecret): ChartSealedSecret => ({ name: s.name, ...(s.type ? { type: s.type } : {}),
  encryptedData: Object.fromEntries(Object.keys(s.encryptedData).sort().map((k) => [k, s.encryptedData[k]!])) });

const expectedNames = (c: CnpgTarget) => [c.passwordSecret, serverCaSecret(c.name), serverTlsSecret(c.name), DB_TUNNEL_KEY_SECRET];

/** 온프레 줄 / 상대 줄 (onpremSide 기준) */
const rowsOf = (i: Pick<DeliveryInput, "source" | "target" | "onpremSide">) =>
  (i.onpremSide ?? "target") === "target" ? { op: i.target, other: i.source } : { op: i.source, other: i.target };

/** 저장된 암호문을 다시 써도 되나: 지문이 같고, 온프레 줄 ca_pem 이 그때 발급한 CA 이고, CA 가 곧 만료되지 않고, 네 비밀이 다 있다 */
function reusable(i: DeliveryInput, digest: string): boolean {
  const s = i.stored, { op } = rowsOf(i);
  if (!s || s.digest !== digest || !op.caPem || sha256(op.caPem) !== s.caSha256) return false;
  let notAfter: number;
  try { notAfter = new Date(new X509Certificate(op.caPem).validTo).getTime(); } catch { return false; }
  if (notAfter - (i.now ?? new Date()).getTime() < SERVER_CERT_RENEW_DAYS * 86_400_000) return false;
  const have = new Set(s.sealedSecrets.map((x) => x.name));
  return expectedNames(i.cnpg).every((n) => have.has(n));
}

/** 정방향 목적지 "<출발 DB 이름>:5432". 차트(db-tunnel.yaml)와 중계 sshd PermitOpen 이 이 모양만 받는다.
 *  출발 줄에 tls_servername 이 있으면 그게 진짜 DB 이름이다 (중계기 출발 입구: host = 중계 공개 IP·port = 15432, relay-step relayEndpointRows) */
export function forwardTarget(source: ReplicationEndpoint): string {
  const real = source.tlsServername ?? source.host;
  if ((!source.tlsServername && source.port !== 5432) || !/^[A-Za-z0-9.-]+$/.test(real))
    throw new DeliveryError("REPL_DELIVERY_FAILED", `출발 줄 ${source.host}:${source.port} 로는 터널 목적지를 못 만든다 (이름 또는 IPv4, 포트 5432 만)`);
  return `${real}:5432`;
}

function tunnelValues(i: DeliveryInput): ChartDbTunnel {
  const { op: t, other } = rowsOf(i);
  if (!t.relayHost || !t.relayKnownHosts)
    throw new DeliveryError("REPL_DELIVERY_FAILED", "온프레 줄에 중계기 주소·호스트 키(relay_host·relay_known_hosts)가 없다 → tools/repl-endpoint.ts set --relay-host … --relay-known-hosts-file … 로 넣고 재개");
  return {
    relay: { host: t.relayHost, port: t.relayPort, knownHosts: t.relayKnownHosts.trim() },
    keySecret: DB_TUNNEL_KEY_SECRET,
    // 정방향(-L) 목적지 = 상대 클라우드 DB (AWS→온프레: 출발 RDS, 온프레→AWS: 도착 RDS. 롤백 창 역구독 길)
    forward: { target: forwardTarget(other) },
    reverse: { enabled: true, cnpgName: i.cnpg.name },
    image: DB_TUNNEL_IMAGE,
  };
}

export interface DeliveryDeps { issue?: (i: ServerCertInput, d?: OpensslDeps) => Promise<ServerCert> }

/** 봉인·발급(또는 저장된 암호문 재사용) → 배포 값에 넣을 것 + 끝점 줄에 되쓸 것. 평문은 이 함수 밖으로 안 나간다 */
export async function prepareDelivery(i: DeliveryInput, deps: DeliveryDeps = {}): Promise<ReplicationDelivery> {
  if (i.masterKey.length < MIN_MASTER_KEY_LENGTH)
    throw new DeliveryError("REPL_SECRET_UNRESOLVED", `REPL_SECRET_MASTER_KEY 는 ${MIN_MASTER_KEY_LENGTH}자 이상이어야 한다`);
  const dbTunnel = tunnelValues(i);
  const c = i.cnpg;
  const certificates = { serverCASecret: serverCaSecret(c.name), serverTLSSecret: serverTlsSecret(c.name) };
  const servername = cnpgServername(c.name, i.namespace);
  const peerHost = tunnelServiceHost(i.namespace);
  const onpremSide = i.onpremSide ?? "target";
  const { op, other } = rowsOf(i);
  // 상대 클라우드 DB 줄의 peer = 터널 Service (온프레 CNPG 가 -L 로 상대를 구독). 이름은 예전 그대로 sourcePeer (core ReplicationDeliveryWrite)
  const sourcePeer = other.peerHost === null ? { host: peerHost, port: 5432 } : undefined;
  const digest = deliveryDigest(i);
  const side = onpremSide === "target" ? {} : { onpremSide };

  if (reusable(i, digest)) {
    const byName = new Map(i.stored!.sealedSecrets.map((s) => [s.name, s]));
    const sealedSecrets = expectedNames(c).map((n) => canonical(byName.get(n)!));
    const rowOk = !sourcePeer && op.tlsServername === servername && op.sslmode === "verify-full";
    return { cnpg: c, certificates, sealedSecrets, dbTunnel, reused: true,
      write: rowOk ? null : { migrationId: i.migrationId, ...side, target: { caPem: op.caPem!, tlsServername: servername, sealed: i.stored! }, ...(sourcePeer ? { sourcePeer } : {}) } };
  }

  const cert = await (deps.issue ?? issueServerCert)({
    caSeed: deriveCaSeed(i.masterKey, i.tenantId, i.migrationId), cnName: `${c.name}-rw`,
    dnsNames: cnpgServerDnsNames(c.name, i.namespace), days: SERVER_CERT_DAYS,
  });
  // 워커는 온프레 줄의 쪽(side)으로 derive:migrate 를 푼다 (replication secret-ref: tenant:migration:side:purpose) → 같은 쪽으로 파생
  const password = derivePassword(i.masterKey, i.tenantId, i.migrationId, onpremSide, MIGRATE_PURPOSE);
  const ssh = deriveSshKeypair(i.masterKey, i.tenantId, i.migrationId);
  const seal = (name: string, type: string | undefined, data: Record<string, string>): ChartSealedSecret =>
    canonical({ ...sealedSecretValues(i.sealingCertPem, i.namespace, name, data), ...(type ? { type } : {}) });
  const sealedSecrets = [
    seal(c.passwordSecret, "kubernetes.io/basic-auth", { username: c.role, password }),
    seal(serverCaSecret(c.name), undefined, { "ca.crt": cert.caCertPem }),
    seal(serverTlsSecret(c.name), "kubernetes.io/tls", { "tls.crt": cert.serverCertPem, "tls.key": cert.serverKeyPem }),
    seal(DB_TUNNEL_KEY_SECRET, undefined, { id: ssh.privateKeyOpenssh }),
  ];
  const sealed: ReplicationSealedMaterial = { version: 1, digest, caSha256: sha256(cert.caCertPem), sealedSecrets };
  return { cnpg: c, certificates, sealedSecrets, dbTunnel, reused: false,
    write: { migrationId: i.migrationId, ...side, target: { caPem: cert.caCertPem, tlsServername: servername, sealed }, ...(sourcePeer ? { sourcePeer } : {}) } };
}

/** 값에 배달물을 넣는다 (순수). 같은 이름의 봉인 비밀은 바꾼다 */
export function withDelivery(values: HelmValues, d: ReplicationDelivery): HelmValues {
  const pgs = ((values.postgres as PgEntry[] | undefined) ?? []).map((p, i) => (i === d.cnpg.index ? { ...p, certificates: d.certificates } : p));
  const names = new Set(d.sealedSecrets.map((s) => s.name));
  const kept = ((values.sealedSecrets as ChartSealedSecret[] | undefined) ?? []).filter((s) => !names.has(s.name));
  return { ...values, postgres: pgs, dbTunnel: d.dbTunnel, sealedSecrets: [...kept, ...d.sealedSecrets] };
}

/** 정리 값 (순수): 이전 역할 ensure=absent (역할 칸은 남겨 CNPG 가 지우게), 터널 빼기, 터널 키·역할 비밀번호 봉인 비밀 빼기.
 *  서버 인증서(certificates·server-ca·server-tls)는 남긴다 (CNPG 가 계속 쓰고, 바꾸면 인스턴스가 다시 뜬다).
 *  배달물이 없던 값(터널·역할 비밀번호 봉인이 없음 = 로컬 데모)이거나 이미 정리했으면 null */
export function withoutDelivery(values: HelmValues): HelmValues | null {
  const pgs = (values.postgres as PgEntry[] | undefined) ?? [];
  const sealed = (values.sealedSecrets as ChartSealedSecret[] | undefined) ?? [];
  const tunnel = values.dbTunnel as ChartDbTunnel | undefined;
  const drop = new Set<string>([DB_TUNNEL_KEY_SECRET, ...(tunnel ? [tunnel.keySecret] : [])]);
  for (const c of replicationCnpgs(values)) drop.add(c.passwordSecret);
  const delivered = !!tunnel || sealed.some((s) => drop.has(s.name));
  if (!delivered) return null;
  const nextPg = pgs.map((p) => (p.mode === "cnpg" && p.replication?.enabled && p.replication.ensure !== "absent"
    ? { ...p, replication: { ...p.replication, ensure: "absent" } } : p));
  const nextSealed = sealed.filter((s) => !drop.has(s.name));
  const { dbTunnel: _t, sealedSecrets: _s, ...rest } = values;
  return { ...rest, ...(values.postgres ? { postgres: nextPg } : {}), ...(nextSealed.length ? { sealedSecrets: nextSealed } : {}) };
}

// ── 배포 단계가 부르는 판정 (DB·env 읽기는 부르는 쪽이 한다. 여기는 순수 + prepareDelivery) ──
export interface DeliveryFacts {
  provider: string;
  /** 온프레 CNPG 가 어느 쪽인가 (기본 target). source = 온프레 → 클라우드 (출발 묶음에 배달) */
  onpremSide?: "source" | "target";
  /** 온프레 끌어오기(ONPREM_FLOOR_VIA_GIT != "0") */
  pullMode: boolean;
  values: HelmValues;          // 자리표시를 채운 승인 값
  tenantId: string;
  migrationId: string;
  records: readonly ReplicationEndpoint[];
  stored: ReplicationSealedMaterial | null;
  sealingCertPem: string | null;
  masterKey: string | undefined;
  now?: Date;
}
export type DeliveryDecision =
  | { kind: "none"; warnings: string[] }
  | { kind: "ok"; delivery: ReplicationDelivery; warnings: string[] }
  | { kind: "stop"; code: DeliveryCode; reason: string; warnings: string[] };

export async function decideDelivery(f: DeliveryFacts, deps: DeliveryDeps = {}): Promise<DeliveryDecision> {
  const warnings: string[] = [];
  if (f.provider !== "onprem") return { kind: "none", warnings };
  const cnpgs = replicationCnpgs(f.values);
  if (!cnpgs.length) return { kind: "none", warnings };
  if (!f.pullMode) {
    warnings.push("ONPREM_FLOOR_VIA_GIT=0 (끌어오기 아님): CNPG 이전 역할 비밀번호·서버 인증서·터널을 gitops 로 보내지 않는다");
    return { kind: "none", warnings };
  }
  const source = f.records.find((r) => r.side === "source"), target = f.records.find((r) => r.side === "target");
  const onpremSide = f.onpremSide ?? "target";
  if (!source || !target) {
    warnings.push(f.records.length === 0
      ? "복제 끝점 줄(replication_endpoints)이 없다: 서버 인증서·봉인 비밀·터널을 넣지 않았다 (로컬 데모 길). 진짜 이전이면 tools/onprem-relay.sh 로 줄을 넣고 재개"
      : "복제 끝점 줄이 한쪽만 있다: 서버 인증서·봉인 비밀·터널을 넣지 않았다 (sync 가 REPL_ENDPOINT_INCOMPLETE 로 멈춘다)");
    return { kind: "none", warnings };
  }
  const stop = (code: DeliveryCode, reason: string): DeliveryDecision => ({ kind: "stop", code, reason, warnings });
  if (cnpgs.length !== 1) return stop("REPL_DELIVERY_FAILED", `복제를 켠 CNPG 가 ${cnpgs.length}개다 (끝점 줄은 이전마다 도착 하나). 하나만 켜야 한다`);
  const cnpg = cnpgs[0]!;
  const namespace = String(f.values.namespace ?? "");
  if (!f.masterKey) return stop("REPL_SECRET_UNRESOLVED", "REPL_SECRET_MASTER_KEY 가 없다: 이전 역할 비밀번호·터널 키를 파생할 수 없다");
  if (!f.sealingCertPem)
    return stop("SEALING_CERT_MISSING", "도착 환경 Agent 보고에 sealed-secrets 봉인 인증서가 없다 (또는 만료·폐기된 키의 보고뿐): 비밀을 봉인할 수 없다 → 클러스터에 sealed-secrets 컨트롤러를 두고 Agent 가 facts 를 다시 보고한 뒤 재개");
  const op = onpremSide === "target" ? target : source, other = onpremSide === "target" ? source : target;
  if (op.username !== cnpg.role || op.passwordRef !== `derive:${MIGRATE_PURPOSE}`)
    warnings.push(`온프레 줄 계정이 ${op.username} / ${op.passwordRef} 다: 차트 이전 역할(${cnpg.role}, derive:${MIGRATE_PURPOSE})과 다르면 워커가 봉인한 비밀번호로 못 붙는다`);
  if (other.peerHost !== null && other.peerHost !== tunnelServiceHost(namespace))
    warnings.push(`상대 줄 peer_host 가 이미 ${other.peerHost} 다 (터널 ${tunnelServiceHost(namespace)} 아님): 그대로 둔다`);
  try {
    const delivery = await prepareDelivery({ tenantId: f.tenantId, migrationId: f.migrationId, namespace, cnpg, source, target, onpremSide,
      sealingCertPem: f.sealingCertPem, masterKey: f.masterKey, stored: f.stored, ...(f.now ? { now: f.now } : {}) }, deps);
    return { kind: "ok", delivery, warnings };
  } catch (e) {
    if (e instanceof DeliveryError) return stop(e.code, e.message);
    if (e instanceof MigrationSecretError) {
      const code: DeliveryCode = e.code === "MASTER_KEY_TOO_SHORT" ? "REPL_SECRET_UNRESOLVED" : e.code.startsWith("SEALING_CERT") ? "SEALING_CERT_MISSING" : "REPL_DELIVERY_FAILED";
      return stop(code, e.message);
    }
    throw e;
  }
}

// ── 정리 커밋 (cleanup·롤백 걷기·repl-cleanup 이 복제 걷기를 끝낸 뒤) ──
type CleanupRepo = Pick<GitopsRepo, "readValues" | "readPlan" | "commitBundle">;

/** 도착 묶음 값에서 배달물을 걷어 커밋한다. 실패는 던지지 않고 결과에 남긴다 (정리·롤백을 막지 않는다).
 *  순서: 복제 걷기(teardown, 구독이 남으면 DROP ROLE 이 실패한다)가 먼저 끝나야 부른다. 터널이 사라지면 워커가 도착 DB 에 못 붙는다 */
export async function commitReplicationCleanup(bundle: BundleRef | null, repo?: CleanupRepo): Promise<{ commit?: string; skipped?: string; error?: string }> {
  const cfg = repo ? null : configFromEnv();
  if (!bundle || (!repo && !cfg)) return { skipped: "no_gitops" };
  try {
    const r = repo ?? new GitopsRepo(cfg!);
    const next = withoutDelivery(await r.readValues(bundle));
    if (!next) return { skipped: "no_delivery" };
    const c = await r.commitBundle("cleanup", bundle, next, await r.readPlan(bundle), "replication cleanup (role absent, tunnel removed)");
    return { commit: c.commit };
  } catch (e) {
    return { error: ((e as Error).message ?? String(e)).slice(0, 200) };
  }
}
