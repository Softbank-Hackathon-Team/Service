import { DB_RAW_KINDS } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, RawItem } from "../types.js";

// DRAFT(ai): AWS RDS DescribeDBInstances 한 줄 → postgres 리소스. Postgres 가 아니면 unmapped C (v2 는 막지 않음)
//   용량은 자르지 않는다(v1 의 100 자르기 없음). 못 읽은 값은 null
type Rds = {
  DBInstanceIdentifier?: string; Engine?: string; EngineVersion?: string | number; AllocatedStorage?: number | null;
  Endpoint?: string | { Address?: string } | null; MultiAZ?: boolean | null; PubliclyAccessible?: boolean | null;
  MaxAllocatedStorage?: number | null; DBInstanceArn?: string | null;
};
export const majorOf = (v: unknown): string | null => {
  const m = /^(\d{1,2})/.exec(String(v ?? ""));
  return m ? m[1]! : null;
};
export const rdsMapper: KindMapper = {
  nativeTypes: [DB_RAW_KINDS.rds],
  kind: "postgres",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as Rds;
    if (!it.DBInstanceIdentifier) return { skip: "DBInstanceIdentifier 없음 (깨진 원본)", grade: "C" };
    if (it.Engine !== "postgres") return { skip: `엔진 ${String(it.Engine)} → postgres 종류 아님`, grade: "C" };
    const id = it.DBInstanceIdentifier;
    const endpoint = typeof it.Endpoint === "string" ? it.Endpoint : it.Endpoint?.Address ?? null;
    const major = majorOf(it.EngineVersion);
    const storage = typeof it.AllocatedStorage === "number" && it.AllocatedStorage >= 1 ? it.AllocatedStorage : null;
    const props: Record<string, unknown> = { majorVersion: major, storageGb: storage };
    if (typeof it.MultiAZ === "boolean") props.ha = it.MultiAZ;
    if (typeof it.MaxAllocatedStorage === "number") props.storageMaxGb = it.MaxAllocatedStorage;
    return {
      name: id, kind: "postgres",
      native: { type: DB_RAW_KINDS.rds, name: id, endpoint, uid: it.DBInstanceArn ?? null },
      props,
      meta: {
        majorVersion: major ? [`rds:${id}.EngineVersion`, 1] : [`rds:${id}.EngineVersion`, 0.6, "버전 못 읽음"],
        storageGb: storage ? [`rds:${id}.AllocatedStorage`, 1] : [`rds:${id}.AllocatedStorage`, 0.6, "용량 못 읽음"],
        ...(typeof it.MultiAZ === "boolean" ? { ha: [`rds:${id}.MultiAZ`, 1] as [string, 1] } : {}),
      },
      network: { ingress: "unknown", public: typeof it.PubliclyAccessible === "boolean" ? it.PubliclyAccessible : null },
    };
  },
};
