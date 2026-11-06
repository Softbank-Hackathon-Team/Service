import type { AppSpecV2, ApprovalRowV2, ComponentV2, Provider } from "@svc/contracts";
import { CLOUD_PRODUCT } from "./cloud-substitutes.js";

// DRAFT(ai): 클라우드 → 온프레 대체 상품표. 앱이 쓰는 API 가 같은 오픈소스만 넣는다 (앱 코드 그대로).
//   표에 없는 종류(버킷·큐, memcached)는 capability 도 없어 계획 전에 "도착 렌더 미지원"으로 막힌다.
//   AUTH 는 이 표에 없다: 도착 Valkey 에 비밀번호를 넣을 길이 정해질 때까지 v2Blockers 가 사람에게 묻는다 (kind.cache.auth 없음)
type Postgres = Extract<ComponentV2, { kind: "postgres" }>;
type Cache = Extract<ComponentV2, { kind: "cache" }>;
interface Loss<C> { what: string; when?: (c: C) => boolean }

// DRAFT(ai): docker.io 공식 이미지, 여러 아키텍처 묶음 다이제스트 (레지스트리에서 읽은 값)
export const VALKEY_IMAGES = {
  "7.2": "docker.io/valkey/valkey:7.2-alpine@sha256:f8c1a646f4b31ae4dc3980ff06723a20b533ea1123b9796d450d78ed53ad6d3e",
  "8.1": "docker.io/valkey/valkey:8.1-alpine@sha256:2602ace2be6569bc2bbb06f873776516ab9089821525be34f4305c67eb9db02a",
} as const;
type ValkeyLine = keyof typeof VALKEY_IMAGES;
const versionOf = (c: Cache) => Number.parseFloat(c.props.version ?? "") || 0;
// Valkey 7.2 는 Redis 7.2.4 에서 갈라졌다. Valkey 출발은 8 이상이면 8.1, 그 밖은 7.2
export const valkeyLine = (c: Cache): ValkeyLine => (c.props.engine === "valkey" && versionOf(c) >= 8 ? "8.1" : "7.2");

// 문구는 영어 (cloud-substitutes.ts 와 같음: 일본어 화면에 한글이 섞이지 않게)
const POSTGRES_LOST: Loss<Postgres>[] = [
  { what: "Port (the CloudNativePG service is fixed at 5432)", when: (c) => c.props.port !== undefined && c.props.port !== 5432 },
  { what: "Automated backups and point-in-time recovery (CloudNativePG backups are configured separately)", when: (c) => !!c.props.backup && (!!c.props.backup.retentionDays || c.props.backup.pitr === true) },
  { what: "Maintenance window (the target cluster decides)", when: (c) => !!c.props.maintenanceWindow },
  { what: "Storage autoscaling (fixed at the initial size)", when: (c) => c.props.storageMaxGb !== undefined },
];
const CACHE_LOST: Loss<Cache>[] = [
  { what: "Newer source version features (rendered on an older Valkey line)", when: (c) => versionOf(c) > Number(valkeyLine(c)) },
  { what: "Cluster mode and shards (rendered as a single server, cluster-only clients need a config change)", when: (c) => c.props.clusterMode === true || (c.props.shards ?? 0) > 1 },
  { what: "Replicas and automatic failover (rendered as a single server)", when: (c) => c.props.ha === true },
  { what: "In-transit encryption (plain redis:// inside the cluster, apps that force TLS need a config change)", when: (c) => c.props.tls !== false },
  { what: "Cached data (starts empty)" },
];

const lostOf = <C>(table: Loss<C>[], c: C) => table.filter((l) => !l.when || l.when(c)).map((l) => l.what);

/** 온프레 도착의 substitutionsV2. 출발이 클라우드일 때만, 표에 있는 자원마다 한 줄 (id 순) */
export function onpremSubstitutes(spec: AppSpecV2, source: Provider): ApprovalRowV2[] {
  if (source !== "aws" && source !== "gcp") return [];
  const rows = spec.components.flatMap((c): ApprovalRowV2[] => {
    if (c.kind === "postgres")
      return [{ kind: "substitute", subject: c.id, from: CLOUD_PRODUCT[source].postgres(c), to: "CloudNativePG", lost: lostOf(POSTGRES_LOST, c), appChange: false }];
    if (c.kind === "cache" && c.props.engine !== "memcached")
      return [{ kind: "substitute", subject: c.id, from: CLOUD_PRODUCT[source].cache(c), to: `Valkey ${valkeyLine(c)}`, lost: lostOf(CACHE_LOST, c), appChange: false }];
    return [];
  });
  return rows.sort((a, b) => a.subject.localeCompare(b.subject));
}
