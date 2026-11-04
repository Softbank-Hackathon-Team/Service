// fc2: DB·캐시 크기·캐시 버전이 도착 표에 맞는지 (DM-5 반올림, SZ-1 표 밖 자르기, CV-1 버전 모양, DM-8 버전 못 읽음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppSpecV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, rdsClassFor, cloudSqlTierFor } from "../src/index.js";
import { v2PrecheckItems } from "../src/target/plan-v2.js";
import { AWS_CACHE_NODES, awsCacheNodeFor, cacheVersionFor, dataFit } from "../src/target/data-fit.js";
import { elasticacheMapper, memoryMiBOfNode } from "../src/import/mappers/elasticache.js";
import { memorystoreMapper } from "../src/import/mappers/memorystore.js";
import type { MappedComponent } from "../src/import/types.js";

type Raw = Record<string, any>;
const BASE: Raw = {"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"posture":{"permissions":[],"network":[]}};
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
const spec = (mut: (s: Raw) => void): AppSpecV2 => { const s = structuredClone(BASE); mut(s); return AppSpecV2.parse(s); };
const withCache = (props: Raw) => spec((s) => { s.components.push({ id: "c", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: true, auth: false, ...props } }); s.links.push({ from: "shop", to: "c", intent: "connect" }); });
const cacheJson = (p: "aws" | "gcp", sp: AppSpecV2) => JSON.parse(String(targetBuilderFor(p).toTerraformV2(sp, T(p)).vars.cache_json))[0] as Raw;
const root = fileURLToPath(new URL("../../../", import.meta.url));

// ── DM-5 ─────────────────────────────────────────────
test("DM-5: 출발 노드 메모리는 내림 → 도착 표에서 같은 급 (AWS→AWS small 이 medium 이 되지 않음)", () => {
  assert.equal(memoryMiBOfNode("cache.t4g.small"), 1402);
  for (const n of ["cache.t4g.micro", "cache.t4g.small", "cache.t4g.medium", "cache.t3.micro", "cache.t3.small", "cache.t3.medium"])
    assert.equal(awsCacheNodeFor(memoryMiBOfNode(n)), n.replace("t3.", "t4g."), n);
  // 표의 모든 출발 급: 도착 급 메모리 ≥ 출발 메모리 (줄이지 않음)
  for (const n of ["cache.m6g.large", "cache.m6g.xlarge", "cache.m6g.2xlarge", "cache.r6g.large", "cache.r6g.xlarge", "cache.r6g.2xlarge"]) {
    const mib = memoryMiBOfNode(n)!, to = awsCacheNodeFor(mib)!;
    assert.ok(AWS_CACHE_NODES.find(([x]) => x === to)![1] >= mib, `${n} ${mib} → ${to}`);
  }
});

test("DM-5·SZ-1: 모듈(aws/kinds/cache) 노드 급 식 = TS 표 AWS_CACHE_NODES (같은 경계·같은 이름)", () => {
  const tf = readFileSync(`${root}infra/modules/aws/kinds/cache/main.tf`, "utf8");
  const rows = [...tf.matchAll(/local\.mib <= (\d+) \? "([^"]+)"/g)].map((m) => [m[2]!, Number(m[1])] as const);
  const last = /: "([^"]+)"\)/.exec(tf.slice(tf.indexOf("node_type")))![1];
  const max = Number(/memory_mib, 0\) <= (\d+)/.exec(tf)![1]);
  assert.deepEqual([...rows, [last, max]], AWS_CACHE_NODES.map(([n, m]) => [n, m]));
});

// ── SZ-1 ─────────────────────────────────────────────
test("SZ-1: 표 밖 캐시·DB 는 줄이지 않고 막힘 (Builder 오류 + 사전 점검 FAIL)", () => {
  const big = withCache({ memoryMiB: 500_000 });
  assert.throws(() => targetBuilderFor("aws").toTerraformV2(big, T("aws")), /최대/);
  assert.throws(() => targetBuilderFor("gcp").toTerraformV2(withCache({ memoryMiB: 400 * 1024 }), T("gcp")), /최대/);
  const items = v2PrecheckItems("aws", { specV2: big });
  assert.ok(items.some((i) => i.level === "block" && /캐시 메모리 500000MiB/.test(i.message)), JSON.stringify(items));
  assert.throws(() => rdsClassFor({ cpuMilli: 128_000, memMiB: 1_048_576 }), /RDS 도착 급 최대/);
  assert.throws(() => cloudSqlTierFor({ cpuMilli: 1000, memMiB: 1_000_000 }), /Cloud SQL 도착 최대/);
  const pg = spec((s) => { s.components[1].props.compute = { cpuMilli: 128_000, memMiB: 1_048_576 }; });
  assert.ok(dataFit("aws", pg, { postgres: (c) => rdsClassFor(c.props.compute) }).unsupported.some((m) => /db .*RDS/.test(m)));
});

test("SZ-1 정상: 예전 표 끝(4xlarge)보다 큰 DB 는 더 큰 급, 26GiB 넘는 캐시는 r7g", () => {
  assert.equal(rdsClassFor({ cpuMilli: 32_000, memMiB: 131_072 }), "db.m6g.8xlarge");
  assert.equal(rdsClassFor({ cpuMilli: 8000, memMiB: 262_144 }), "db.m6g.16xlarge");
  assert.equal(cacheJson("aws", withCache({ memoryMiB: memoryMiBOfNode("cache.r6g.2xlarge") })).memory_mib, 54087);
  assert.equal(awsCacheNodeFor(54087), "cache.r7g.2xlarge");
});

// ── CV-1 ─────────────────────────────────────────────
test("CV-1: 버전은 도착이 받는 같은 메이저 이상 판으로 (바뀌면 경고)", () => {
  assert.deepEqual(cacheVersionFor("gcp", "redis", "7.1"), { engine: "redis", version: "7.2", warn: "버전 redis 7.1 → redis 7.2" });
  assert.equal(cacheVersionFor("gcp", "redis", "6.2").version, "6.x");
  assert.equal(cacheVersionFor("gcp", "redis", "5.0.6").version, "5.0");
  assert.equal(cacheVersionFor("aws", "redis", "6.x").version, "6.2");   // 마이너 모름 → 그 메이저 가장 높은 판 (내리지 않음)
  assert.equal(cacheVersionFor("aws", "redis", "7.1").warn, undefined);   // 같은 클라우드 같은 판 = 경고 없음
  const vk = cacheVersionFor("gcp", "valkey", "7.2");
  assert.equal(vk.version, "7.2"); assert.equal(vk.engine, "redis"); assert.match(vk.warn!, /엔진 valkey → redis/);
  const tf = cacheJson("gcp", withCache({ version: "7.1" }));
  assert.equal(tf.version, "7.2");
  const items = v2PrecheckItems("gcp", { specV2: withCache({ version: "7.1" }) });
  assert.ok(items.some((i) => i.level === "warn" && /7\.1 → redis 7\.2/.test(i.message)));
});

test("CV-1 거부: 같은 메이저에 출발 이상 판이 없으면 막힘 (Memorystore 7.2 → ElastiCache redis, valkey 8 → GCP)", () => {
  assert.match(cacheVersionFor("aws", "redis", "7.2").block!, /같은 메이저\(7\)/);
  assert.ok(cacheVersionFor("gcp", "valkey", "8.0").block);
  assert.throws(() => targetBuilderFor("aws").toTerraformV2(withCache({ version: "7.2" }), T("aws")), /7\.2/);
  assert.ok(v2PrecheckItems("gcp", { specV2: withCache({ engine: "valkey", version: "8.0" }) }).some((i) => i.level === "block"));
});

test("CV-1·DM-8: 매퍼 — REDIS_6_X 는 6.x, 버전을 못 읽으면 칸은 비우고 0.6 검토", () => {
  const m = memorystoreMapper.map({ kind: "gcp.memorystore", name: "projects/p/locations/r/instances/c1", redisVersion: "REDIS_6_X", memorySizeGb: 1 }) as MappedComponent;
  assert.equal(m.props.version, "6.x");
  const n = memorystoreMapper.map({ kind: "gcp.memorystore", name: "projects/p/locations/r/instances/c2", memorySizeGb: 1 }) as MappedComponent;
  assert.equal(n.props.version, undefined); assert.equal(n.meta.version?.[1], 0.6);
  const e = elasticacheMapper.map({ kind: "aws.elasticache", ReplicationGroupId: "rg", Engine: "redis", CacheNodeType: "cache.t4g.small" }) as MappedComponent;
  assert.equal(e.props.version, undefined); assert.equal(e.meta.version?.[1], 0.6);
  assert.equal(e.props.memoryMiB, 1402);
  // 못 읽은 판은 사전 점검 경고로도 보임
  assert.ok(v2PrecheckItems("aws", { specV2: withCache({}) }).some((i) => i.level === "warn" && /버전을 못 읽음/.test(i.message)));
});
