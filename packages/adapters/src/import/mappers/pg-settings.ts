import type { MetaTuple } from "../types.js";
import { cpuMilliOf, mibOf } from "./k8s-deployment.js";

// N8·SSL-1 DRAFT(ai): 출발 Postgres 설정 읽기 도우미 (RDS·Cloud SQL·CNPG 매퍼가 같이 씀). 순수 함수.
//   크기(compute)는 상품 등급 이름에서 환산 (표 밖이면 null → 비움). 파라미터는 출발 값 그대로 (도착 모듈은 플랫폼 요구가 이김).
//   확장(extensions)은 클라우드 API 로 안 보임(DB 안 pg_extension) → 칸을 비워 둠 (복제 사전 점검 몫).

type Amount = { cpuMilli: number | null; memMiB: number | null };

// RDS 등급: db.<계열>.<크기>. 메모리 = vCPU × 계열 배수 (t 계열은 크기별 표). 계열 표 밖이면 null
const SIZE_VCPU: Record<string, number> = { micro: 2, small: 2, medium: 2, large: 2, xlarge: 4, "2xlarge": 8, "4xlarge": 16, "8xlarge": 32, "12xlarge": 48, "16xlarge": 64, "24xlarge": 96, "32xlarge": 128, "48xlarge": 192 };
const T_MEM: Record<string, number> = { micro: 1024, small: 2048, medium: 4096, large: 8192, xlarge: 16384, "2xlarge": 32768 };
const FAMILY_GIB_PER_VCPU: Record<string, number> = { m: 4, r: 8, x: 16, c: 2, z: 8 };
export function rdsComputeOf(cls: unknown): Amount | null {
  const m = /^db\.([a-z])(\d+)[a-z]*\.([a-z0-9]+)$/.exec(String(cls ?? ""));
  if (!m) return null;
  const [, fam, , size] = m as unknown as [string, string, string, string];
  const vcpu = SIZE_VCPU[size];
  if (!vcpu) return null;
  if (fam === "t") { const mem = T_MEM[size]; return mem ? { cpuMilli: vcpu * 1000, memMiB: mem } : null; }
  const per = FAMILY_GIB_PER_VCPU[fam];
  return per ? { cpuMilli: vcpu * 1000, memMiB: vcpu * per * 1024 } : null;
}

// Cloud SQL tier: db-custom-<vCPU>-<MiB> · 공유 코어 2개. 나머지(perf-optimized 등)는 null
export function cloudSqlComputeOf(tier: unknown): Amount | null {
  const t = String(tier ?? "");
  const m = /^db-custom-(\d+)-(\d+)$/.exec(t);
  if (m) return { cpuMilli: Number(m[1]) * 1000, memMiB: Number(m[2]) };
  if (t === "db-f1-micro") return { cpuMilli: 200, memMiB: 614 };
  if (t === "db-g1-small") return { cpuMilli: 500, memMiB: 1740 };
  return null;
}

// CNPG: spec.resources.requests (없으면 limits)
export function cnpgComputeOf(res: unknown): Amount | null {
  const r = (res ?? {}) as { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
  const src = r.requests ?? r.limits;
  if (!src || (src.cpu == null && src.memory == null)) return null;
  return { cpuMilli: cpuMilliOf(src.cpu), memMiB: mibOf(src.memory) };
}

/** 문자열 값 표로 (숫자·불은 글자로) */
export const strParams = (x: unknown): Record<string, string> | null => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (v != null) out[k] = String(v);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

// CNPG 운영자가 정하는 파라미터는 고객 설정이 아니다 (cloudnative-pg "Fixed parameters" + 운영자가 spec 에 채우는 기본값).
//   그대로 옮기면 RDS·Cloud SQL 이 거부한다 (2026-11-07 온프레 → AWS 실측: ModifyDBParameterGroup "The parameter logging_collector cannot be modified")
//   고정 목록은 값과 상관없이 뺀다. 운영자 기본값 목록은 값이 그 기본값일 때만 뺀다 (고객이 바꾼 값이면 남긴다)
const CNPG_FIXED = new Set(["allow_system_table_mods", "archive_cleanup_command", "archive_command", "archive_mode", "bonjour", "bonjour_name",
  "cluster_name", "config_file", "data_directory", "data_sync_retry", "event_source", "external_pid_file", "full_page_writes", "hba_file",
  "hot_standby", "ident_file", "jit_provider", "listen_addresses", "log_destination", "log_directory", "log_file_mode", "log_filename",
  "log_rotation_age", "log_rotation_size", "log_truncate_on_rotation", "logging_collector", "port", "primary_conninfo", "primary_slot_name",
  "promote_trigger_file", "recovery_end_command", "recovery_min_apply_delay", "recovery_target", "recovery_target_action",
  "recovery_target_inclusive", "recovery_target_lsn", "recovery_target_name", "recovery_target_time", "recovery_target_timeline",
  "recovery_target_xid", "restart_after_crash", "restore_command", "shared_preload_libraries", "ssl", "ssl_ca_file", "ssl_cert_file",
  "ssl_crl_file", "ssl_dh_params_file", "ssl_ecdh_curve", "ssl_key_file", "ssl_passphrase_command", "ssl_passphrase_command_supports_reload",
  "ssl_prefer_server_ciphers", "stats_temp_directory", "synchronous_standby_names", "syslog_facility", "syslog_ident",
  "syslog_sequence_numbers", "syslog_split_messages", "unix_socket_directories", "unix_socket_group", "unix_socket_permissions",
  "wal_level", "wal_log_hints"]);
const CNPG_DEFAULTS: Record<string, string> = { archive_timeout: "5min", dynamic_shared_memory_type: "posix", max_parallel_workers: "32",
  max_worker_processes: "32", shared_memory_type: "mmap", ssl_max_protocol_version: "TLSv1.3", ssl_min_protocol_version: "TLSv1.3",
  wal_keep_size: "512MB", wal_receiver_timeout: "5s", wal_sender_timeout: "5s" };
/** CNPG spec.postgresql.parameters 에서 고객이 정한 것만 */
export const cnpgUserParams = (p: Record<string, string> | null): Record<string, string> | null => {
  if (!p) return null;
  const kept = Object.entries(p).filter(([k, v]) => !CNPG_FIXED.has(k) && CNPG_DEFAULTS[k] !== v);
  return kept.length ? Object.fromEntries(kept) : null;
};

// N8 DRAFT(ai): IR 의 다른 칸이나 플랫폼 요구로 이미 옮겨지는 벤더 파라미터는 parameters 에서 뺀다.
//   rds.force_ssl·ssl 계열 → tlsRequired(SSL-1), 논리 복제 켜기 → 도착 모듈이 항상 켬(CDC 이전).
//   남은 rds.*·cloudsql.* 는 그 클라우드 도착만 받음(pg.param.<vendor>) → 다른 클라우드면 계획에서 막힘
const COVERED_PARAMS = new Set(["rds.force_ssl", "rds.logical_replication", "cloudsql.logical_decoding", "cloudsql.enable_pglogical"]);
export const portableParams = (p: Record<string, string>): { kept: Record<string, string>; covered: string[] } => {
  const kept: Record<string, string> = {}; const covered: string[] = [];
  for (const [k, v] of Object.entries(p)) (COVERED_PARAMS.has(k) ? covered.push(k) : (kept[k] = v));
  return { kept, covered: covered.sort() };
};

// SSL-1 DRAFT(ai): 출발이 평문 연결을 거절하는지
/** RDS: 파라미터 rds.force_ssl. 기본 그룹(default.*)이면 버전 기본값 (15 이상은 1, 그 아래는 0 — AWS 문서 기준 【추정: 실측 안 함】) */
export function rdsTls(params: Record<string, string> | null, groupName: string | null, major: string | null, id: string): { v: boolean | null; meta: MetaTuple } {
  const src = `rds:${id}.parameters.rds.force_ssl`;
  if (params && "rds.force_ssl" in params) return { v: params["rds.force_ssl"] === "1", meta: [src, 1] };
  if (groupName?.startsWith("default.") || (params && groupName)) {
    if (!major) return { v: null, meta: [src, 0.6, "버전을 몰라 기본 TLS 강제 여부를 모름"] };
    return { v: Number(major) >= 15, meta: [src, 0.9, `파라미터 그룹에 값이 없음 → Postgres ${major} 기본값(15 이상 = 강제)으로 봄`] };
  }
  return { v: null, meta: [src, 0.6, "파라미터 그룹을 못 읽음 → TLS 강제 여부 모름"] };
}
/** Cloud SQL: ipConfiguration.sslMode (없으면 requireSsl, 둘 다 없으면 기본 = 평문 허용) */
export function cloudSqlTls(ipc: unknown, name: string): { v: boolean | null; meta: MetaTuple } {
  const o = (ipc ?? null) as { sslMode?: string; requireSsl?: boolean } | null;
  const src = `cloudsql:${name}.settings.ipConfiguration.sslMode`;
  if (!o) return { v: null, meta: [src, 0.6, "ipConfiguration 을 못 읽음"] };
  if (o.sslMode) return { v: o.sslMode !== "ALLOW_UNENCRYPTED_AND_ENCRYPTED", meta: [src, 1] };
  if (typeof o.requireSsl === "boolean") return { v: o.requireSsl, meta: [`cloudsql:${name}.settings.ipConfiguration.requireSsl`, 1] };
  return { v: false, meta: [src, 0.9, "sslMode·requireSsl 이 없음 → Cloud SQL 기본(평문 허용)으로 봄"] };
}
/** CNPG: 사용자 pg_hba 에 "hostnossl … reject" 가 있으면 강제. 없으면 CNPG 기본 규칙(host … scram-sha-256 = 평문 허용) */
export function cnpgTls(pgHba: unknown, name: string): { v: boolean | null; meta: MetaTuple } {
  const lines = Array.isArray(pgHba) ? pgHba.map(String) : [];
  const src = `cnpg:${name}.spec.postgresql.pg_hba`;
  if (lines.some((l) => /^\s*hostnossl\s+all\s+all\s+\S+\s+reject\b/.test(l))) return { v: true, meta: [src, 1] };
  return { v: false, meta: [src, 0.9, lines.length ? "사용자 pg_hba 에 평문 거절 줄이 없음 → CNPG 기본(평문 허용)" : "pg_hba 없음 → CNPG 기본(평문 허용)"] };
}
