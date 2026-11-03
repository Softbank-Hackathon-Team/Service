import { DATA_RAW_KINDS, type RawElastiCache } from "../raw-data.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): AWS ElastiCache 복제 그룹 → cache (설계 20번 6.5장). 캐시는 데이터를 옮기지 않고 비우고 시작한다.
//   memoryMiB = 노드 종류 → 표. 표에 없으면 null + 0.6 (지어내지 않음). 표 값은 AWS 문서의 노드 메모리(GiB)×1024 반올림 【추정: 문서 대조 필요】
const NODE_GIB: Record<string, number> = {
  "cache.t4g.micro": 0.5, "cache.t4g.small": 1.37, "cache.t4g.medium": 3.09,
  "cache.t3.micro": 0.5, "cache.t3.small": 1.37, "cache.t3.medium": 3.09,
  "cache.m6g.large": 6.38, "cache.m6g.xlarge": 12.93, "cache.m6g.2xlarge": 26.04,
  "cache.r6g.large": 13.07, "cache.r6g.xlarge": 26.32, "cache.r6g.2xlarge": 52.82,
};
export const memoryMiBOfNode = (t: string | null | undefined): number | null => {
  const g = t ? NODE_GIB[t] : undefined;
  return g === undefined ? null : Math.round(g * 1024);
};

export const elasticacheMapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.elasticache],
  kind: "cache",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const c = item as unknown as RawElastiCache;
    if (!c.ReplicationGroupId) return { skip: "ReplicationGroupId 없음 (깨진 원본)", grade: "C" };
    const engine = String(c.Engine ?? "").toLowerCase();
    if (engine !== "redis" && engine !== "valkey" && engine !== "memcached") return { skip: `엔진 ${String(c.Engine)} → cache 종류 아님`, grade: "C" };
    const id = c.ReplicationGroupId, src = (k: string) => `elasticache:${id}.${k}`;
    const mem = memoryMiBOfNode(c.CacheNodeType);
    const version = typeof c.EngineVersion === "string" && /^\d+(\.\d+)*/.test(c.EngineVersion) ? c.EngineVersion : undefined;
    const tls = typeof c.TransitEncryptionEnabled === "boolean" ? c.TransitEncryptionEnabled : null;
    const auth = typeof c.AuthTokenEnabled === "boolean" ? c.AuthTokenEnabled : null;
    const props: Record<string, unknown> = { engine, memoryMiB: mem, tls, auth };
    if (version) props.version = version;
    if (typeof c.ClusterEnabled === "boolean") props.clusterMode = c.ClusterEnabled;
    if (typeof c.NodeGroups === "number" && c.ClusterEnabled) props.shards = c.NodeGroups;
    if (typeof c.MultiAZ === "string") props.ha = c.MultiAZ === "enabled";
    const meta: Record<string, MetaTuple> = {
      engine: [src("Engine"), 1],
      memoryMiB: mem === null ? [src("CacheNodeType"), 0.6, `노드 종류 ${String(c.CacheNodeType)} 가 메모리 표에 없음 (지어내지 않음)`] : [src("CacheNodeType"), 0.9, "노드 종류 → 메모리 표"],
      tls: tls === null ? [src("TransitEncryptionEnabled"), 0.6, "전송 암호화 여부 못 읽음"] : [src("TransitEncryptionEnabled"), 1],
      auth: auth === null ? [src("AuthTokenEnabled"), 0.6, "인증 여부 못 읽음"] : [src("AuthTokenEnabled"), 1],
    };
    if (version) meta.version = [src("EngineVersion"), 1];
    if (typeof c.ClusterEnabled === "boolean") meta.clusterMode = [src("ClusterEnabled"), 1];
    if (typeof c.MultiAZ === "string") meta.ha = [src("MultiAZ"), 1];
    // 클러스터 모드면 ConfigurationEndpoint, 아니면 PrimaryEndpoint (둘 다 연결 추론 근거)
    const endpoint = (c.ClusterEnabled ? c.ConfigurationEndpoint : c.PrimaryEndpoint) ?? c.PrimaryEndpoint ?? c.ConfigurationEndpoint ?? null;
    const aliases = [c.PrimaryEndpoint, c.ConfigurationEndpoint].filter((x): x is string => typeof x === "string" && x.length > 0 && x !== endpoint);
    return { name: id, kind: "cache", native: { type: DATA_RAW_KINDS.elasticache, name: id, endpoint, ...(aliases.length ? { aliases } : {}), uid: c.ARN ?? null },
      props, meta, network: { ingress: "unknown", public: null } };
  },
};
