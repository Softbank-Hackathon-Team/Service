import type { AppSpecV2, ComponentV2 } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { UNSUPPORTED_V2 } from "./shared.js";

// fc2 DRAFT(ai): DB·캐시 크기와 캐시 버전이 도착 상품에 맞는지 (SZ-1·DM-5·CV-1). 순수 함수, 네트워크 없음.
//   원칙(그대로 이식): 도착 표에 맞는 급·버전이 없으면 조용히 줄이거나 내리지 않고 계획 전에 막는다(unsupported).
//   맞는 급·버전이 있지만 글자가 바뀌면(5.0.6 → 5.0, valkey → Redis) 사전 점검 경고로 사람에게 보인다.
//   표는 infra/modules/{aws,gcp}/kinds/cache 의 식과 같아야 한다 (시험 fc2-data-fit 이 main.tf 를 읽어 대조).

type Cache = Extract<ComponentV2, { kind: "cache" }>;
type Cloud = "aws" | "gcp";

// DRAFT(ai): AWS 도착 캐시 노드 급과 메모리(MiB = GiB×1024 내림). 【추정: AWS 문서의 노드 메모리. 문서 대조 필요】
//   작은 급은 출발 가져오기 표(mappers/elasticache.ts)와 같은 값이라 AWS→AWS 는 같은 급이 나온다 (DM-5)
export const AWS_CACHE_NODES: ReadonlyArray<readonly [string, number]> = [
  ["cache.t4g.micro", 512], ["cache.t4g.small", 1402], ["cache.t4g.medium", 3164],
  ["cache.m7g.large", 6533], ["cache.m7g.xlarge", 13240], ["cache.m7g.2xlarge", 26664],
  ["cache.r7g.2xlarge", 54087], ["cache.r7g.4xlarge", 108349], ["cache.r7g.8xlarge", 214579],
  ["cache.r7g.12xlarge", 325396], ["cache.r7g.16xlarge", 429148],
];
/** 메모리가 들어가는 가장 작은 급. 표 밖(더 큼)이면 null */
export const awsCacheNodeFor = (mib: number | null): string | null =>
  (AWS_CACHE_NODES.find(([, m]) => (mib ?? 0) <= m) ?? [null])[0];
// DRAFT(ai): Memorystore for Redis 한 인스턴스 최대 300GB 【추정: 상품 한도】
export const GCP_CACHE_MAX_GB = 300;

// DRAFT(ai): 도착이 받는 캐시 버전 (CV-1). 【추정: 상품 문서 기억. 문서 대조 필요】
//   AWS ElastiCache: redis 4.0.10·5.0.6·6.0·6.2·7.0·7.1, valkey 7.2·8.0·8.1
//   GCP Memorystore Redis: REDIS_4_0·5_0·6_X·7_0·7_2 (valkey 는 Memorystore for Valkey 라는 다른 상품 → TODO(human), 지금은 Redis 로 옮기고 경고)
export const CACHE_VERSIONS: Record<Cloud, Record<"redis" | "valkey", string[]>> = {
  aws: { redis: ["4.0.10", "5.0.6", "6.0", "6.2", "7.0", "7.1"], valkey: ["7.2", "8.0", "8.1"] },
  gcp: { redis: ["4.0", "5.0", "6.x", "7.0", "7.2"], valkey: [] },
};
// 모듈 기본값 (버전을 못 읽었을 때). 경고 글에만 쓴다
const DEFAULT_VERSION: Record<Cloud, Record<"redis" | "valkey", string>> = { aws: { redis: "7.1", valkey: "8.0" }, gcp: { redis: "7.0", valkey: "7.2" } };

const parts = (v: string) => v.split(".").map((x) => (x === "x" ? null : Number(x)));
export interface CacheVersionFit { engine: "redis" | "valkey"; version: string | null; warn?: string; block?: string }

/** 출발 캐시 버전 → 도착 버전. 같은 메이저 안에서 출발 이상인 가장 낮은 버전(마이너까지 비교). 없으면 block */
export function cacheVersionFor(cloud: Cloud, engine: "redis" | "valkey", version: string | null | undefined): CacheVersionFit {
  // GCP 는 valkey 를 Redis 로 옮긴다 (같은 프로토콜). 메이저가 맞는 Redis 가 있을 때만
  const toEngine = cloud === "gcp" ? "redis" : engine;
  const engineNote = toEngine !== engine ? `엔진 ${engine} → ${toEngine} (도착에 ${engine} 상품 없음, 명령어·동작 차이 확인)` : "";
  if (!version) return { engine: toEngine, version: null,
    warn: `버전을 못 읽음 → 도착 기본 ${toEngine} ${DEFAULT_VERSION[cloud][toEngine]}${engineNote ? `, ${engineNote}` : ""}` };
  const src = parts(version);
  const cands = CACHE_VERSIONS[cloud][toEngine].filter((c) => parts(c)[0] === src[0]);
  let hit: string | undefined;
  if (src[1] == null) hit = cands[cands.length - 1];   // "6.x" = 마이너 모름 → 그 메이저의 가장 높은 판 (내리지 않음)
  else hit = cands.find((c) => { const p = parts(c); return p[1] == null || p[1]! >= src[1]!; });
  if (!hit) return { engine: toEngine, version: null,
    block: `cache 버전 ${engine} ${version} — 도착 ${toEngine} 에 같은 메이저(${src[0]}) 의 ${version} 이상 판이 없음 (받는 판: ${CACHE_VERSIONS[cloud][toEngine].join(",") || "없음"}). 명세 검토에서 엔진·버전을 바꾸고 승인` };
  const changed = hit !== version || engineNote;
  return { engine: toEngine, version: hit, ...(changed ? { warn: `버전 ${engine} ${version} → ${toEngine} ${hit}${engineNote ? ` · ${engineNote}` : ""}` } : {}) };
}

type Postgres = Extract<ComponentV2, { kind: "postgres" }>;

/** DBN-1·E10-2: 도착 DB 이름·앱 계정. IR appDatabase → databases[0] → <앱 이름 - → _>, IR appUser → "app" (DRAFT(ai) 기본, 경고) */
export function dbIdentityFor(spec: AppSpecV2, c: Postgres): { db: string; user: string; dbDefault: boolean; userDefault: boolean } {
  const db = c.props.appDatabase ?? c.props.databases?.[0];
  return { db: db ?? spec.app.name.replace(/-/g, "_"), user: c.props.appUser ?? "app", dbDefault: db === undefined, userDefault: c.props.appUser === undefined };
}
// DRAFT(ai): 도착 상품이 만들 수 없는 이름 【추정: 상품 문서 기억】. Cloud SQL 은 postgres 계정·DB 가 이미 있고, CNPG 는 postgres 가 슈퍼유저
const RESERVED_USER: Record<string, string[]> = {
  aws: ["rdsadmin", "rds_superuser", "rdsrepladmin", "rds_replication"],
  gcp: ["postgres", "cloudsqladmin", "cloudsqlsuperuser", "cloudsqlreplica", "cloudsqliamuser"],
  onprem: ["postgres", "streaming_replica"],
};
const RESERVED_DB: Record<string, string[]> = { aws: ["template0", "template1", "rdsadmin"], gcp: ["postgres", "template0", "template1", "cloudsqladmin"], onprem: ["postgres", "template0", "template1"] };

/** 계획 전에 볼 것: 표 밖(막기)·사람 확인·바뀜(경고) */
export function dataFit(provider: string, spec: AppSpecV2, sizeOf: { postgres?: (c: Postgres) => unknown } = {}): { unsupported: string[]; needsHuman: string[]; warnings: string[] } {
  const unsupported: string[] = [], warnings: string[] = [], needsHuman: string[] = [];
  // DBN-1·E10-2: 도착 DB 이름·앱 계정
  if (provider === "aws" || provider === "gcp" || provider === "onprem") for (const c of spec.components) {
    if (c.kind !== "postgres") continue;
    const id = dbIdentityFor(spec, c);
    if (id.dbDefault) warnings.push(`${c.id}: 앱이 붙는 DB 이름을 못 읽음 → 도착은 ${id.db} 로 만듦. 앱 주소의 DB 이름과 다르면 명세 검토에서 고침`);
    if (id.userDefault) warnings.push(`${c.id}: 앱 계정 이름을 못 읽음 → 도착은 ${id.user} 로 만듦. 앱 주소의 계정과 다르면 명세 검토에서 고침`);
    if (RESERVED_USER[provider]!.includes(id.user.toLowerCase()))
      needsHuman.push(`${c.id}: 앱 계정 ${id.user} 는 도착(${provider})이 따로 쓰는 이름이라 그대로 못 만듦 → 다른 계정으로 바꿀지 사람이 정함`);
    if (RESERVED_DB[provider]!.includes(id.db.toLowerCase()))
      needsHuman.push(`${c.id}: DB 이름 ${id.db} 는 도착(${provider})이 이미 가진 이름이라 새로 못 만듦 → 다른 이름·기존 DB 를 쓸지 사람이 정함`);
    // DM-8: 클라우드 DB 는 WAL 전용 볼륨이 없음 → 데이터 볼륨 하나에 같이 (조용히 빼지 않고 경고)
    if (c.props.walStorageGb && provider !== "onprem")
      warnings.push(`${c.id}: 출발 WAL 전용 볼륨 ${c.props.walStorageGb}GB → ${provider === "aws" ? "RDS" : "Cloud SQL"} 는 볼륨 하나라 데이터 ${c.props.storageGb ?? "?"}GB 안에 WAL 도 들어감. 용량을 늘릴지 사람이 확인`);
    // BK-1: 백업 보관·유지보수 창을 도착이 그대로 받나
    const days = c.props.backup?.retentionDays;
    if (c.props.backup && days === null) warnings.push(`${c.id}: 출발 백업 보관 기간을 못 읽음 → 도착 상품 기본`);
    if (provider === "aws" && days != null && days > 35)
      unsupported.push(`도착 렌더 미지원: ${c.id} 백업 보관 ${days}일 — RDS 자동 백업은 최대 35일 (줄이지 않음). 스냅숏 보관 등 다른 방법을 사람이 정함`);
    if (provider === "aws" && days === 0 && (c.props.readReplicas ?? 0) > 0)
      unsupported.push(`도착 렌더 미지원: ${c.id} 백업 꺼짐(0일)인데 읽기 복제본 ${c.props.readReplicas}개 — RDS 는 복제본에 자동 백업이 필요`);
    if (provider === "gcp" && days != null && days > 365)
      unsupported.push(`도착 렌더 미지원: ${c.id} 백업 보관 ${days}일 — Cloud SQL 은 최대 365개 (줄이지 않음)`);
    if (provider === "gcp" && c.props.backup?.pitr === true && days === 0)
      unsupported.push(`도착 렌더 미지원: ${c.id} 백업 꺼짐인데 시점 복구(PITR) 켬 — Cloud SQL 은 백업 없이 PITR 못 함`);
    if (provider === "onprem" && ((days ?? 0) > 0 || c.props.backup?.pitr))
      warnings.push(`${c.id}: 출발은 자동 백업(${days ?? "?"}일${c.props.backup?.pitr ? "·PITR" : ""}) → 온프레 도착(CNPG)엔 백업 저장소가 없어 백업 없이 만듦. 사람이 확인 (TODO(human): 백업 저장소)`);
    if (c.props.maintenanceWindow && provider === "gcp" && !/:00-/.test(c.props.maintenanceWindow))
      warnings.push(`${c.id}: 유지보수 창 ${c.props.maintenanceWindow} → Cloud SQL 은 시작 요일·시(1시간 단위)만 받음`);
    if (c.props.maintenanceWindow && provider === "onprem")
      warnings.push(`${c.id}: 유지보수 창 ${c.props.maintenanceWindow} → 온프레 도착(CNPG)엔 같은 설정 없음`);
    if (provider === "aws" && (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(id.db) || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(id.user)))
      needsHuman.push(`${c.id}: RDS 는 DB 이름·마스터 계정에 영문·숫자·_ 만 받음 (${id.db}·${id.user}) → 이름을 바꿀지 사람이 정함`);
  }
  // DM-7: 도착이 포트를 못 고르는 상품 (Cloud SQL·CNPG 5432, Memorystore 상품이 정함). 주소 안 포트는 링크 port 로 바뀌지만 따로 적힌 포트 글자는 사람이 확인
  for (const c of spec.components) {
    if (c.kind === "postgres" && c.props.port != null && c.props.port !== 5432 && (provider === "gcp" || provider === "onprem"))
      warnings.push(`${c.id}: 출발 DB 포트 ${c.props.port} → 도착(${provider === "gcp" ? "Cloud SQL" : "CNPG"})은 5432 고정. 주소 안 포트는 도착 포트로 바뀜, 따로 적힌 포트 설정은 사람이 확인`);
    if (c.kind === "cache" && c.props.port != null && c.props.port !== 6379 && provider === "gcp")
      warnings.push(`${c.id}: 출발 캐시 포트 ${c.props.port} → 도착(Memorystore)은 상품이 정한 포트. 주소 안 포트는 도착 포트로 바뀜, 따로 적힌 포트 설정은 사람이 확인`);
  }
  if (provider !== "aws" && provider !== "gcp") return { unsupported, needsHuman: [...new Set(needsHuman)].sort(), warnings: [...new Set(warnings)].sort() };
  for (const c of spec.components) {
    if (c.kind === "cache") {
      const k = c as Cache;
      if (k.props.engine === "memcached") continue;   // capability 가 막음
      const v = cacheVersionFor(provider, k.props.engine, k.props.version);
      if (v.block) unsupported.push(`도착 렌더 미지원: ${c.id} ${v.block}`);
      if (v.warn) warnings.push(`${c.id}: ${v.warn}`);
      const mib = k.props.memoryMiB;
      if (provider === "aws" && mib != null && awsCacheNodeFor(mib) === null)
        unsupported.push(`도착 렌더 미지원: ${c.id} 캐시 메모리 ${mib}MiB 가 AWS 도착 급 최대(${AWS_CACHE_NODES[AWS_CACHE_NODES.length - 1]![0]} ${AWS_CACHE_NODES[AWS_CACHE_NODES.length - 1]![1]}MiB)보다 큼 → 줄이지 않음. 샤드로 나눌지 사람이 정함`);
      if (provider === "gcp" && mib != null && Math.ceil(mib / 1024) > GCP_CACHE_MAX_GB)
        unsupported.push(`도착 렌더 미지원: ${c.id} 캐시 메모리 ${mib}MiB 가 Memorystore 최대 ${GCP_CACHE_MAX_GB}GB 보다 큼 → 줄이지 않음`);
      if (mib == null) warnings.push(`${c.id}: 캐시 메모리를 못 읽음 → 도착 가장 작은 급`);
    }
    if (c.kind === "postgres" && sizeOf.postgres) {
      try { sizeOf.postgres(c); }
      catch (e) { if (e instanceof AdapterError) unsupported.push(`도착 렌더 미지원: ${c.id} ${e.message}`); else throw e; }
    }
  }
  return { unsupported: [...new Set(unsupported)].sort(), needsHuman: [...new Set(needsHuman)].sort(), warnings: [...new Set(warnings)].sort() };
}

/** Builder 가 계획 값을 만들기 전에 부른다. 막을 것이 있으면 UNSUPPORTED_V2 */
export function assertDataFit(provider: string, spec: AppSpecV2, sizeOf: Parameters<typeof dataFit>[2] = {}): void {
  const { unsupported } = dataFit(provider, spec, sizeOf);
  if (unsupported.length) throw new AdapterError(UNSUPPORTED_V2, unsupported.join(" / "));
}
