import { DATA_RAW_KINDS, type RawMemorystore } from "../raw-data.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): Memorystore for Redis → cache (설계 20번 6.5장). 클러스터 모드(Memorystore Cluster)는 별도 API 라 이 매퍼 밖(unmapped C 로 남음)
export const memorystoreMapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.memorystore],
  kind: "cache",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const m = item as unknown as RawMemorystore;
    if (!m.name) return { skip: "인스턴스 이름 없음 (깨진 원본)", grade: "C" };
    const name = m.name.split("/").pop() ?? "";
    if (!name) return { skip: "인스턴스 이름을 못 뽑음", grade: "C" };
    const src = (k: string) => `memorystore:${name}.${k}`;
    // CV-1: REDIS_6_X 처럼 마이너가 X 인 판은 "6.x" (마이너 모름. 도착은 그 메이저의 가장 높은 판, 내리지 않음)
    const ver = /^REDIS_(\d+)_(\d+|X)$/i.exec(m.redisVersion ?? "");
    const mem = typeof m.memorySizeGb === "number" && m.memorySizeGb > 0 ? Math.round(m.memorySizeGb * 1024) : null;
    const tls = typeof m.transitEncryptionMode === "string" ? m.transitEncryptionMode !== "DISABLED" && m.transitEncryptionMode !== "TRANSIT_ENCRYPTION_MODE_UNSPECIFIED" : null;
    const auth = typeof m.authEnabled === "boolean" ? m.authEnabled : null;
    const props: Record<string, unknown> = { engine: "redis", memoryMiB: mem, tls, auth };
    if (ver) props.version = `${ver[1]}.${ver[2]!.toLowerCase()}`;
    if (typeof m.tier === "string") props.ha = m.tier === "STANDARD_HA";
    if (typeof m.port === "number") props.port = m.port;   // DM-7
    const meta: Record<string, MetaTuple> = {
      engine: [src("redisVersion"), 1],
      memoryMiB: mem === null ? [src("memorySizeGb"), 0.6, "메모리 크기 못 읽음"] : [src("memorySizeGb"), 1],
      tls: tls === null ? [src("transitEncryptionMode"), 0.6, "전송 암호화 여부 못 읽음"] : [src("transitEncryptionMode"), 1],
      auth: auth === null ? [src("authEnabled"), 0.6, "인증 여부 못 읽음"] : [src("authEnabled"), 1],
    };
    // DM-8: 버전을 못 읽으면 검토 표시
    meta.version = ver ? [src("redisVersion"), 1] : [src("redisVersion"), 0.6, `판 ${String(m.redisVersion ?? "없음")} 을 못 읽음 → 도착 기본 판. 사람이 확인`];
    if (typeof m.tier === "string") meta.ha = [src("tier"), 1];
    if (typeof m.port === "number") meta.port = [src("port"), 1];
    const aliases = typeof m.readEndpoint === "string" && m.readEndpoint && m.readEndpoint !== m.host ? [m.readEndpoint] : [];   // G3b-4: 읽기 주소
    return { name, kind: "cache", native: { type: DATA_RAW_KINDS.memorystore, name, endpoint: m.host ?? null, ...(aliases.length ? { aliases } : {}), uid: m.name }, props, meta, network: { ingress: "unknown", public: null } };
  },
};
