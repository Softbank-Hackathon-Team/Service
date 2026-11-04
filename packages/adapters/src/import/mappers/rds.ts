import { DB_RAW_KINDS } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { portableParams, rdsComputeOf, rdsTls, strParams } from "./pg-settings.js";

// DRAFT(ai): AWS RDS DescribeDBInstances 한 줄 → postgres 리소스. Postgres 가 아니면 unmapped C (v2 는 막지 않음)
//   용량은 자르지 않는다(v1 의 100 자르기 없음). 못 읽은 값은 null
type Rds = {
  DBInstanceIdentifier?: string; Engine?: string; EngineVersion?: string | number; AllocatedStorage?: number | null;
  Endpoint?: string | { Address?: string; Port?: number } | null; Port?: number | null; MultiAZ?: boolean | null; PubliclyAccessible?: boolean | null;
  MaxAllocatedStorage?: number | null; DBInstanceArn?: string | null;
  // N8·SSL-1
  DBInstanceClass?: string | null; ReadReplicaDBInstanceIdentifiers?: string[] | null; DBName?: string | null;
  DBParameterGroupName?: string | null; Parameters?: Record<string, unknown> | null;
  MasterUsername?: string | null;   // DBN-1
  BackupRetentionPeriod?: number | null; PreferredMaintenanceWindow?: string | null;   // BK-1
  // G3b-3: 읽기 복제본 주소(원본의 별칭) · Aurora 클러스터 이름
  ReplicaEndpoints?: string[]; DBClusterIdentifier?: string | null;
  // FM-IR-02: 보안 그룹 들어오는 규칙 (discover 가 읽음. null = 못 읽음) · 앱 자신(출발 클러스터 SG) 규칙 수
  Ingress?: Array<{ from: string; port?: number }> | null; IngressAppSg?: number;
};
/** BK-1: 유지보수 창 모양 (RDS PreferredMaintenanceWindow, UTC) */
export const MW = /^(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d-(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d$/;
/** G3b-3 DRAFT(ai): Aurora 인스턴스 주소 <인스턴스>.<해시>.<리전>.rds.amazonaws.com → 클러스터 주소 <클러스터>.cluster-<해시>… · 읽기 주소 …cluster-ro-<해시>…
 *  【추정: AWS 문서의 Aurora 엔드포인트 이름 규칙】 앱은 보통 클러스터 주소를 쓴다 */
export function auroraEndpoints(instanceEndpoint: string | null, cluster: string | null): string[] {
  const m = instanceEndpoint && cluster ? /^[^.]+\.([^.]+)\.(.+)$/.exec(instanceEndpoint) : null;
  return m ? [`${cluster}.cluster-${m[1]}.${m[2]}`, `${cluster}.cluster-ro-${m[1]}.${m[2]}`] : [];
}
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
    const aurora = it.Engine === "aurora-postgresql";
    if (it.Engine !== "postgres" && !aurora) return { skip: `엔진 ${String(it.Engine)} → postgres 종류 아님`, grade: "C" };
    // G3b-3: Aurora Postgres 는 클러스터 하나 = postgres 하나. 주소는 클러스터·읽기 주소를 같이 (앱이 쓰는 주소), 용량은 자동이라 null
    const id = aurora && it.DBClusterIdentifier ? it.DBClusterIdentifier : it.DBInstanceIdentifier;
    const instEndpoint = typeof it.Endpoint === "string" ? it.Endpoint : it.Endpoint?.Address ?? null;
    const [clusterEp, ...auroraAliases] = aurora ? auroraEndpoints(instEndpoint, it.DBClusterIdentifier ?? null) : [];
    const endpoint = clusterEp ?? instEndpoint;
    const aliases = [...auroraAliases, ...(clusterEp && instEndpoint ? [instEndpoint] : []), ...(it.ReplicaEndpoints ?? [])];
    const major = majorOf(it.EngineVersion);
    const storage = !aurora && typeof it.AllocatedStorage === "number" && it.AllocatedStorage >= 1 ? it.AllocatedStorage : null;
    const props: Record<string, unknown> = { majorVersion: major, storageGb: storage };
    if (typeof it.MultiAZ === "boolean") props.ha = it.MultiAZ;
    if (typeof it.MaxAllocatedStorage === "number") props.storageMaxGb = it.MaxAllocatedStorage;
    // DM-7: 접속 포트 (보안 관례로 5433 등으로 바꾼 RDS 가 흔함)
    const port = typeof it.Port === "number" ? it.Port : typeof it.Endpoint === "object" && typeof it.Endpoint?.Port === "number" ? it.Endpoint.Port : null;
    if (port !== null) props.port = port;
    // N8: 크기·읽기 복제본·처음 DB·파라미터 (출발 값 그대로). SSL-1: TLS 강제 여부
    const extra: Record<string, MetaTuple> = {};
    const compute = rdsComputeOf(it.DBInstanceClass);
    if (compute) { props.compute = compute; extra.compute = [`rds:${id}.DBInstanceClass(${String(it.DBInstanceClass)})`, 0.9, "등급 이름에서 vCPU·메모리 환산"]; }
    else if (it.DBInstanceClass) extra.compute = [`rds:${id}.DBInstanceClass`, 0.6, `등급 ${String(it.DBInstanceClass)} 을 환산표에서 못 찾음 → 도착은 기본 등급. 사람이 확인`];
    if (Array.isArray(it.ReadReplicaDBInstanceIdentifiers)) { props.readReplicas = it.ReadReplicaDBInstanceIdentifiers.length; extra.readReplicas = [`rds:${id}.ReadReplicaDBInstanceIdentifiers`, 1]; }
    if (typeof it.DBName === "string" && it.DBName) { props.databases = [it.DBName]; extra.databases = [`rds:${id}.DBName`, 0.9, "RDS API 는 처음 만든 DB 이름만 보여 줌 → 나머지 DB 는 복제 사전 점검에서 확인"]; }
    // BK-1: 자동 백업 보관 일수(0 = 끔). RDS 는 자동 백업이 켜져 있으면 시점 복구(PITR)도 됨 【사실: RDS 자동 백업 = PITR】. 유지보수 창은 UTC 그대로
    if (typeof it.BackupRetentionPeriod === "number") {
      props.backup = { retentionDays: it.BackupRetentionPeriod, pitr: it.BackupRetentionPeriod > 0 };
      extra.backup = [`rds:${id}.BackupRetentionPeriod`, 1];
    }
    if (typeof it.PreferredMaintenanceWindow === "string" && MW.test(it.PreferredMaintenanceWindow.toLowerCase())) {
      props.maintenanceWindow = it.PreferredMaintenanceWindow.toLowerCase(); extra.maintenanceWindow = [`rds:${id}.PreferredMaintenanceWindow`, 1];
    }
    // DBN-1 DRAFT(ai): 앱 DB·계정 후보. 앱 주소(user@…/db)에서 읽으면 가져오기가 그 값으로 덮는다 (db-identity.ts)
    if (typeof it.DBName === "string" && it.DBName) { props.appDatabase = it.DBName; extra.appDatabase = [`rds:${id}.DBName`, 0.9, "처음 만든 DB 를 앱 DB 로 봄 (앱 주소에서 못 읽음)"]; }
    if (typeof it.MasterUsername === "string" && it.MasterUsername) { props.appUser = it.MasterUsername; extra.appUser = [`rds:${id}.MasterUsername`, 0.6, "마스터 사용자를 앱 계정으로 봄 (앱 주소에서 못 읽음). 앱이 다른 계정을 쓰면 사람이 고침"]; }
    const params = it.Parameters === undefined ? null : strParams(it.Parameters);
    const pp = params ? portableParams(params) : null;
    if (pp && Object.keys(pp.kept).length) { props.parameters = pp.kept; extra.parameters = [`rds:${id}.DBParameterGroup(${String(it.DBParameterGroupName)})`, 1, ...(pp.covered.length ? [`${pp.covered.join(",")} 는 다른 칸(TLS·논리 복제)으로 옮김`] : [])] as MetaTuple; }
    else if (it.Parameters === null) extra.parameters = [`rds:${id}.DBParameterGroup(${String(it.DBParameterGroupName)})`, 0.6, "사용자 파라미터 그룹 값을 못 읽음 (rds:DescribeDBParameters 권한 확인)"];
    if (it.DBParameterGroupName !== undefined) {
      const tls = rdsTls(params, it.DBParameterGroupName ?? null, major, id);
      props.tlsRequired = tls.v; extra.tlsRequired = tls.meta;
    }
    return {
      name: id, kind: "postgres",
      native: { type: DB_RAW_KINDS.rds, name: id, endpoint, uid: aurora ? null : it.DBInstanceArn ?? null, ...(aliases.length ? { aliases } : {}) },
      props,
      meta: {
        majorVersion: major ? [`rds:${id}.EngineVersion`, 1] : [`rds:${id}.EngineVersion`, 0.6, "버전 못 읽음"],
        storageGb: storage ? [`rds:${id}.AllocatedStorage`, 1] : [`rds:${id}.AllocatedStorage`, 0.6, aurora ? "Aurora 는 저장 용량이 자동으로 늘어 정해진 값이 없음 → 도착 용량을 사람이 정함" : "용량 못 읽음"],
        ...(aurora ? { engine: [`rds:${id}.Engine(aurora-postgresql)`, 0.6, "출발은 Aurora Postgres → 도착은 일반 Postgres(관리형 또는 CNPG)로 그림. 출발과 달라짐, 사람 확인"] as MetaTuple } : {}),
        ...(typeof it.MultiAZ === "boolean" ? { ha: [`rds:${id}.MultiAZ`, 1] as [string, 1] } : {}),
        ...(port !== null ? { port: [`rds:${id}.Endpoint.Port`, 1] as [string, 1] } : {}),
        ...extra,
        // FM-IR-02 DRAFT(ai): 앱 자신(출발 클러스터 SG)에서 오는 규칙은 도착 링크로 열어 뺐다고 적는다
        ...(Array.isArray(it.Ingress) ? { network: [`rds:${id}.VpcSecurityGroups`, 0.9, `보안 그룹에서 읽음${it.IngressAppSg ? ` (출발 클러스터 보안 그룹 ${it.IngressAppSg}건 = 옮기는 앱 → 도착은 연결 의존성으로 엶)` : ""}`] as MetaTuple }
          : { network: [`rds:${id}.VpcSecurityGroups`, 0.6, "보안 그룹을 못 읽음 (ec2:DescribeSecurityGroups 권한 확인)"] as MetaTuple }),
      },
      network: { ingress: Array.isArray(it.Ingress) ? it.Ingress : "unknown", public: typeof it.PubliclyAccessible === "boolean" ? it.PubliclyAccessible : null },
    };
  },
};
