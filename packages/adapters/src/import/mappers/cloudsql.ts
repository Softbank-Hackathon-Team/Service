import { DB_RAW_KINDS } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, RawItem } from "../types.js";

// DRAFT(ai): GCP Cloud SQL instances.get → postgres 리소스. 엔진이 POSTGRES_ 가 아니면 unmapped C
//   endpoint = 첫 IP (사설 우선). ha = availabilityType REGIONAL. 못 읽은 값은 null
type CloudSql = {
  name?: string; databaseVersion?: string; selfLink?: string | null; ipAddress?: string;
  ipAddresses?: Array<{ type?: string | null; ipAddress?: string | null }>;
  settings?: { dataDiskSizeGb?: string | number | null; availabilityType?: string | null;
    ipConfiguration?: { ipv4Enabled?: boolean; authorizedNetworks?: Array<{ value?: string; name?: string }> } | null };
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
    const av = it.settings?.availabilityType;
    const ipc = it.settings?.ipConfiguration;
    const props: Record<string, unknown> = { majorVersion: major, storageGb: storage };
    if (av === "REGIONAL" || av === "ZONAL") props.ha = av === "REGIONAL";
    return {
      name: it.name, kind: "postgres",
      native: { type: DB_RAW_KINDS.cloudsql, name: it.name, endpoint, uid: it.selfLink ?? null },
      props,
      meta: {
        majorVersion: major ? [`cloudsql:${it.name}.databaseVersion`, 1] : [`cloudsql:${it.name}.databaseVersion`, 0.6, "버전 못 읽음"],
        storageGb: storage ? [`cloudsql:${it.name}.settings.dataDiskSizeGb`, 1] : [`cloudsql:${it.name}.settings.dataDiskSizeGb`, 0.6, "용량 못 읽음"],
        ...(props.ha !== undefined ? { ha: [`cloudsql:${it.name}.settings.availabilityType`, 1] as [string, 1] } : {}),
      },
      network: {
        ingress: ipc?.authorizedNetworks ? ipc.authorizedNetworks.map((a) => ({ from: String(a.value ?? a.name ?? "") })) : "unknown",
        public: typeof ipc?.ipv4Enabled === "boolean" ? ipc.ipv4Enabled : null,
      },
    };
  },
};
