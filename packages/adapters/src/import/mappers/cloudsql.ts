import { DB_RAW_KINDS } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { cloudSqlComputeOf, cloudSqlTls, portableParams } from "./pg-settings.js";

// DRAFT(ai): GCP Cloud SQL instances.get → postgres 리소스. 엔진이 POSTGRES_ 가 아니면 unmapped C
//   endpoint = 첫 IP (사설 우선). ha = availabilityType REGIONAL. 못 읽은 값은 null
//   DM-4: 나머지 IP(공인 등)는 별칭. 연결 이름(프로젝트:리전:인스턴스)·/cloudsql/<연결 이름> 은 proxyAliases (Auth Proxy·소켓 연결의 근거)
type CloudSql = {
  name?: string; databaseVersion?: string; selfLink?: string | null; ipAddress?: string; connectionName?: string | null;
  ipAddresses?: Array<{ type?: string | null; ipAddress?: string | null }>;
  replicaIpAddresses?: string[];   // G3b-3: 읽기 복제본 IP (원본 DB 의 별칭으로만, 따로 안 옮김)
  settings?: { dataDiskSizeGb?: string | number | null; availabilityType?: string | null; tier?: string | null;
    ipConfiguration?: { ipv4Enabled?: boolean; authorizedNetworks?: Array<{ value?: string; name?: string }>; sslMode?: string; requireSsl?: boolean } | null;
    databaseFlags?: Array<{ name?: string; value?: string }> | null;
    // BK-1
    backupConfiguration?: { enabled?: boolean; pointInTimeRecoveryEnabled?: boolean; backupRetentionSettings?: { retainedBackups?: number; retentionUnit?: string } } | null;
    maintenanceWindow?: { day?: number; hour?: number } | null };
  // N8
  replicaNames?: string[] | null; databases?: string[] | null;
};
export const cloudSqlMapper: KindMapper = {
  nativeTypes: [DB_RAW_KINDS.cloudsql],
  kind: "postgres",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as CloudSql;
    if (!it.name) return { skip: "name 없음 (깨진 원본)", grade: "C" };
    const ver = String(it.databaseVersion ?? "");
    if (!ver.startsWith("POSTGRES_")) return { skip: `엔진 ${ver} → postgres 종류 아님`, grade: "C" };
    const major = /^POSTGRES_(\d{1,2})/.exec(ver)?.[1] ?? null;
    const raw = it.settings?.dataDiskSizeGb;
    const n = raw == null || raw === "" ? NaN : Number(raw);
    const storage = Number.isInteger(n) && n >= 1 ? n : null;
    const ips = it.ipAddresses ?? [];
    const endpoint = (ips.find((a) => a.type === "PRIVATE") ?? ips[0])?.ipAddress ?? it.ipAddress ?? null;
    const aliases = [...new Set([...ips.map((a) => a.ipAddress), it.ipAddress].filter((x): x is string => typeof x === "string" && x.length > 0 && x !== endpoint))].sort();
    const av = it.settings?.availabilityType;
    const ipc = it.settings?.ipConfiguration;
    const props: Record<string, unknown> = { majorVersion: major, storageGb: storage };
    if (av === "REGIONAL" || av === "ZONAL") props.ha = av === "REGIONAL";
    // N8·SSL-1
    const extra: Record<string, MetaTuple> = {};
    const compute = cloudSqlComputeOf(it.settings?.tier);
    if (compute) { props.compute = compute; extra.compute = [`cloudsql:${it.name}.settings.tier(${String(it.settings?.tier)})`, 1]; }
    else if (it.settings?.tier) extra.compute = [`cloudsql:${it.name}.settings.tier`, 0.6, `tier ${String(it.settings.tier)} 를 환산 못 함 → 도착은 기본 등급. 사람이 확인`];
    if (Array.isArray(it.replicaNames)) { props.readReplicas = it.replicaNames.length; extra.readReplicas = [`cloudsql:${it.name}.replicaNames`, 1]; }
    if (Array.isArray(it.databases)) {
      const dbs = it.databases.filter((x) => x !== "postgres" && x !== "cloudsqladmin").sort();
      if (dbs.length) { props.databases = dbs; extra.databases = [`cloudsql:${it.name}.databases`, 1]; }
      // DBN-1: 사용자 DB 가 하나뿐이면 그것이 앱 DB (앱 주소에서 읽으면 그 값으로 덮임). 계정 목록은 안 읽음 → appUser 는 앱 주소에서만
      if (dbs.length === 1) { props.appDatabase = dbs[0]; extra.appDatabase = [`cloudsql:${it.name}.databases`, 0.9, "사용자 DB 가 하나뿐이라 앱 DB 로 봄"]; }
    }
    if (Array.isArray(it.settings?.databaseFlags)) {
      const flags = Object.fromEntries(it.settings.databaseFlags.filter((f) => f.name).map((f) => [String(f.name), String(f.value ?? "on")]).sort(([a], [b]) => String(a).localeCompare(String(b))));
      const { kept } = portableParams(flags as Record<string, string>);
      if (Object.keys(kept).length) { props.parameters = kept; extra.parameters = [`cloudsql:${it.name}.settings.databaseFlags`, 1]; }
    }
    // BK-1: 백업 켬·보관 개수(하루 1번 → 날로 봄, 0.9)·PITR, 유지보수 창(요일 1=월…7=일, 시 UTC → 1시간 창)
    const bc = it.settings?.backupConfiguration;
    if (bc && typeof bc.enabled === "boolean") {
      const n = bc.backupRetentionSettings?.retainedBackups;
      const days = !bc.enabled ? 0 : typeof n === "number" && (bc.backupRetentionSettings?.retentionUnit ?? "COUNT") === "COUNT" ? n : null;
      props.backup = { retentionDays: days, pitr: bc.enabled ? bc.pointInTimeRecoveryEnabled === true : false };
      extra.backup = days === null ? [`cloudsql:${it.name}.settings.backupConfiguration`, 0.6, "백업 보관 개수를 못 읽음 → 도착 상품 기본. 사람이 확인"]
        : bc.enabled ? [`cloudsql:${it.name}.settings.backupConfiguration.backupRetentionSettings`, 0.9, "보관 개수(하루 1번 자동 백업)를 날로 봄"] : [`cloudsql:${it.name}.settings.backupConfiguration.enabled`, 1];
    }
    const mw = it.settings?.maintenanceWindow;
    if (mw && typeof mw.day === "number" && mw.day >= 1 && mw.day <= 7 && typeof mw.hour === "number" && mw.hour >= 0 && mw.hour <= 23) {
      const D = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], h2 = (mw.hour + 1) % 24, d2 = mw.hour === 23 ? D[mw.day % 7] : D[mw.day - 1];
      props.maintenanceWindow = `${D[mw.day - 1]}:${String(mw.hour).padStart(2, "0")}:00-${d2}:${String(h2).padStart(2, "0")}:00`;
      extra.maintenanceWindow = [`cloudsql:${it.name}.settings.maintenanceWindow`, 1];
    }
    if (it.settings && "ipConfiguration" in it.settings) { const tls = cloudSqlTls(ipc, it.name); props.tlsRequired = tls.v; extra.tlsRequired = tls.meta; }
    return {
      name: it.name, kind: "postgres",
      native: { type: DB_RAW_KINDS.cloudsql, name: it.name, endpoint, uid: it.selfLink ?? null,
        ...(aliases.length ? { aliases } : {}),
        ...(it.connectionName ? { proxyAliases: [it.connectionName, `/cloudsql/${it.connectionName}`] } : {}) },
      props,
      meta: {
        majorVersion: major ? [`cloudsql:${it.name}.databaseVersion`, 1] : [`cloudsql:${it.name}.databaseVersion`, 0.6, "버전 못 읽음"],
        storageGb: storage ? [`cloudsql:${it.name}.settings.dataDiskSizeGb`, 1] : [`cloudsql:${it.name}.settings.dataDiskSizeGb`, 0.6, "용량 못 읽음"],
        ...(props.ha !== undefined ? { ha: [`cloudsql:${it.name}.settings.availabilityType`, 1] as [string, 1] } : {}),
        ...extra,
      },
      network: {
        ingress: ipc?.authorizedNetworks ? ipc.authorizedNetworks.map((a) => ({ from: String(a.value ?? a.name ?? "") })) : "unknown",
        public: typeof ipc?.ipv4Enabled === "boolean" ? ipc.ipv4Enabled : null,
      },
    };
  },
};
