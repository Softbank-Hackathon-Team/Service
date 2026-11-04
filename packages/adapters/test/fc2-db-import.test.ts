// fc2: DB·캐시 가져오기 구멍 (DM-3 CNPG 버전 태그, DM-4 Cloud SQL·CNPG 다른 접속 주소)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpecV2, RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { cnpgMapper, imageTagOf, majorOfTag } from "../src/import/mappers/cnpg.js";
import { cloudSqlMapper } from "../src/import/mappers/cloudsql.js";
import type { MappedComponent } from "../src/import/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));

const D = "sha256:" + "ab".repeat(32);
const NS = "shop";
type Raw = Record<string, any>;
const inv = (provider: "onprem" | "gcp", items: Raw[]): RawInventory => ({ provider, coverage: {}, items });
const dep = (name: string, env: Raw[] = [], extra: Raw = {}): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }],
    resources: { requests: { cpu: "300m", memory: "768Mi" } }, env }], ...extra } } },
});
const cnpg = (spec: Raw, status?: Raw): Raw & { kind: string } => ({ kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: NS }, spec: { storage: { size: "5Gi" }, instances: 1, ...spec }, ...(status ? { status } : {}) });
const mapped = (r: ReturnType<typeof cnpgMapper.map>) => { assert.ok(!("skip" in r)); return r as MappedComponent; };
const comp = (spec: AppSpecV2, kind: string) => spec.components.find((c) => c.kind === kind) as unknown as { id: string; props: Raw } | undefined;

// ── DM-3 ─────────────────────────────────────────────
test("DM-3: 이미지 태그 자리만 본다 (digest·레지스트리 포트·태그 없음)", () => {
  assert.equal(imageTagOf(`ghcr.io/cloudnative-pg/postgresql:16.4@${D}`), "16.4");
  assert.equal(imageTagOf("registry.local:5000/postgresql"), null);
  assert.equal(imageTagOf(`ghcr.io/cloudnative-pg/postgresql@sha256:40${"e1".repeat(31)}`), null);
  assert.equal(majorOfTag("16.4-bookworm"), "16");
  assert.equal(majorOfTag("17"), "17");
  assert.equal(majorOfTag("latest"), null);
  assert.equal(majorOfTag("150"), null);   // 3자리 숫자는 메이저가 아님
});

test("DM-3: digest 고정 이미지는 태그 버전(16), 태그 없는 레지스트리 포트 이미지는 null + 0.6", () => {
  const a = mapped(cnpgMapper.map(cnpg({ imageName: `ghcr.io/cloudnative-pg/postgresql:16.4@sha256:40${"e1".repeat(31)}` })));
  assert.equal(a.props.majorVersion, "16");
  assert.equal(a.meta.majorVersion?.[1], 1);
  const b = mapped(cnpgMapper.map(cnpg({ imageName: "registry.local:5000/postgresql" })));
  assert.equal(b.props.majorVersion, null, "포트 번호 50 을 버전으로 읽지 않음");
  assert.equal(b.meta.majorVersion?.[1], 0.6);
  const c = mapped(cnpgMapper.map(cnpg({ imageName: `ghcr.io/cloudnative-pg/postgresql@sha256:40${"e1".repeat(31)}` })));
  assert.equal(c.props.majorVersion, null, "digest 글자 40 을 버전으로 읽지 않음");
});

test("DM-3: spec.postgresVersion 이 먼저, 없으면 status.image 태그", () => {
  assert.equal(mapped(cnpgMapper.map(cnpg({ postgresVersion: 15, imageName: "x/postgresql:17" }))).props.majorVersion, "15");
  const s = mapped(cnpgMapper.map(cnpg({}, { image: "ghcr.io/cloudnative-pg/postgresql:17.2" })));
  assert.equal(s.props.majorVersion, "17");
  assert.match(s.meta.majorVersion![0], /status\.image/);
});

// ── DM-4 ─────────────────────────────────────────────
test("DM-4: CNPG 읽기 전용(-ro) 주소로 붙는 앱도 DB 와 이어지고 env 가 도착 주소로 바뀜", () => {
  const { result } = normalizeV2(inv("onprem", [
    dep("shop-api", [{ name: "DB_HOST", value: "shop-db-rw.shop.svc" }]),
    dep("shop-report", [{ name: "DB_RO", value: "postgres://shop-db-ro.shop.svc.cluster.local:5432/app" }]),
    cnpg({ imageName: "ghcr.io/cloudnative-pg/postgresql:16" }),
  ]));
  const L = result.spec.links.map((l) => `${l.from}->${String(l.to)}`).sort();
  assert.deepEqual(L, ["shop-api->shop-db", "shop-report->shop-db"]);
  assert.equal(result.fieldMeta["links.shop-report->shop-db"]?.confidence, 1);
  const rep = result.spec.components.find((c) => c.id === "shop-report") as unknown as { props: { env: Raw[] } };
  // CNPG-RO: 읽기 전용 주소는 주 서버(host)가 아니라 reader 로
  assert.ok(rep.props.env[0]!.template?.includes("${shop-db.reader}"), JSON.stringify(rep.props.env));
});

test("DM-4: Cloud SQL 연결 이름(Auth Proxy 사이드카 인자)으로 붙는 앱 → 의존성은 생기지만 0.6 검토, 인자는 안 바꿈", () => {
  const sql = { kind: "cloudsql.instance", name: "shop-sql", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "20" },
    ipAddresses: [{ type: "PRIVATE", ipAddress: "10.20.0.5" }, { type: "PRIMARY", ipAddress: "34.1.2.3" }], connectionName: "proj:asia-northeast3:shop-sql" };
  const proxy = { name: "cloud-sql-proxy", image: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.11.0", args: ["--port=5432", "proj:asia-northeast3:shop-sql"], restartPolicy: "Always" };
  const { result } = normalizeV2(inv("gcp", [
    dep("shop-api", [{ name: "DB_HOST", value: "127.0.0.1" }], { initContainers: [proxy] }),
    dep("shop-batch", [{ name: "DATABASE_URL", value: "postgresql://batch@34.1.2.3:5432/shop" }]),
    sql,
  ]));
  const L = Object.fromEntries(result.spec.links.map((l) => [`${l.from}->${String(l.to)}`, result.fieldMeta[`links.${l.from}->${String(l.to)}`]?.confidence]));
  assert.equal(L["shop-api->shop-sql"], 0.6, JSON.stringify(result.spec.links));
  assert.match(result.fieldMeta["links.shop-api->shop-sql"]!.rationale!, /Auth Proxy/);
  assert.equal(L["shop-batch->shop-sql"], 1, "공인 IP 로 붙는 앱도 근거 있는 연결");
  assert.ok(!JSON.stringify(result.spec).includes("34.1.2.3"), "공인 IP 는 도착 주소 자리표시로 바뀜");
});

test("DM-4 거부: 연결 이름이 아닌 비슷한 글자는 근거가 아님", () => {
  const m = cloudSqlMapper.map({ kind: "cloudsql.instance", name: "shop-sql", databaseVersion: "POSTGRES_16", ipAddresses: [], connectionName: "proj:r:shop-sql" }) as MappedComponent;
  assert.deepEqual(m.native.proxyAliases, ["proj:r:shop-sql", "/cloudsql/proj:r:shop-sql"]);
  const { result } = normalizeV2(inv("gcp", [dep("other-api", [{ name: "X", value: "proj:r:shop-sqlx" }]),
    { kind: "cloudsql.instance", name: "shop-sql", databaseVersion: "POSTGRES_16", ipAddresses: [], connectionName: "proj:r:shop-sql" }]));
  assert.ok(!result.spec.links.some((l) => l.from === "other-api" && l.to === "shop-sql" && result.fieldMeta[`links.other-api->shop-sql`]?.source !== "heuristic:name"));
  void comp;
});

// ── DM-7 ─────────────────────────────────────────────
import { rdsMapper } from "../src/import/mappers/rds.js";
import { AppSpecV2 as Spec, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor } from "../src/index.js";
import { v2PrecheckItems } from "../src/target/plan-v2.js";

const rds = (port?: number): Raw & { kind: string } => ({ kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 20,
  Endpoint: "shop-db.abc.ap-northeast-2.rds.amazonaws.com", ...(port ? { Port: port } : {}) });
const awsInv = (items: Raw[]): RawInventory => ({ provider: "aws", coverage: {}, items });
const TT = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;

test("DM-7: RDS 포트 5433 → IR port, 주소 안 포트·따로 적힌 DB_PORT 가 링크 port 로, AWS 도착은 같은 포트", () => {
  assert.equal((rdsMapper.map(rds(5433)) as MappedComponent).props.port, 5433);
  const { result } = normalizeV2(awsInv([
    dep("shop-api", [{ name: "DATABASE_URL", value: "postgres://shop-db.abc.ap-northeast-2.rds.amazonaws.com:5433/shop" },
      { name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }, { name: "DB_PORT", value: "5433" }]),
    rds(5433)]));
  const env = (result.spec.components.find((c) => c.id === "shop-api") as unknown as { props: { env: Raw[] } }).props.env;
  assert.deepEqual(env.find((e) => e.name === "DATABASE_URL"), { name: "DATABASE_URL", template: "postgres://${shop-db.host}:${shop-db.port}/shop" });
  assert.deepEqual(env.find((e) => e.name === "DB_PORT"), { name: "DB_PORT", fromLink: { to: "shop-db", output: "port" } });
  assert.equal(result.fieldMeta["components.shop-api.env.DB_PORT"]?.needs_review, true);
  const spec = Spec.parse(result.spec);
  const pg = JSON.parse(String(targetBuilderFor("aws").toTerraformV2(spec, TT("aws")).vars.postgres_json))[0];
  assert.equal(pg.port, 5433);
  // Cloud SQL 도착은 5432 고정 → 경고
  assert.ok(v2PrecheckItems("gcp", { specV2: spec }).some((i) => i.level === "warn" && /포트 5433/.test(i.message)));
});

test("DM-7 거부: 기본 포트(5432)면 주소 글자 그대로, PORT env 도 안 바꿈", () => {
  const { result } = normalizeV2(awsInv([
    dep("shop-api", [{ name: "DATABASE_URL", value: "postgres://shop-db.abc.ap-northeast-2.rds.amazonaws.com:5432/shop" }, { name: "DB_PORT", value: "5432" }]),
    rds(5432)]));
  const env = (result.spec.components.find((c) => c.id === "shop-api") as unknown as { props: { env: Raw[] } }).props.env;
  assert.equal(env.find((e) => e.name === "DATABASE_URL")!.template, "postgres://${shop-db.host}:5432/shop");
  assert.deepEqual(env.find((e) => e.name === "DB_PORT"), { name: "DB_PORT", value: "5432" });
});

// ── DBN-1·E10-2 ──────────────────────────────────────
import { dbIdentityOf } from "../src/import/db-identity.js";
import { stubTfOutputsV2 } from "../src/target/plan-v2.js";

test("DBN-1: 연결 글자에서 계정·DB (URL·jdbc ?user=·키워드 DSN), 비밀번호는 안 읽음", () => {
  assert.deepEqual(dbIdentityOf("postgres://orders_user@h:5432/orders"), { user: "orders_user", db: "orders" });
  assert.deepEqual(dbIdentityOf("jdbc:postgresql://h:5432/orders?user=svc&sslmode=require"), { user: "svc", db: "orders" });
  assert.deepEqual(dbIdentityOf("host=h port=5432 dbname=orders user=svc"), { user: "svc", db: "orders" });
  assert.deepEqual(dbIdentityOf("h.example.com"), { user: null, db: null });
});

test("DBN-1·E10-2: 앱 주소의 DB·계정이 IR 에 담기고, 세 도착(RDS·Cloud SQL·CNPG)이 같은 이름으로 만든다", () => {
  const { result } = normalizeV2(awsInv([
    dep("shop-api", [{ name: "DATABASE_URL", value: "postgres://orders_user@shop-db.abc.ap-northeast-2.rds.amazonaws.com:5432/orders" }]),
    { ...rds(), DBName: "postgres", MasterUsername: "root" }]));
  const pg = result.spec.components.find((c) => c.kind === "postgres") as unknown as { props: Raw };
  assert.equal(pg.props.appUser, "orders_user");
  assert.equal(pg.props.appDatabase, "orders");
  assert.equal(result.fieldMeta["components.shop-db.appUser"]?.confidence, 1);
  assert.match(result.fieldMeta["components.shop-db.appUser"]!.rationale!, /root/);   // 출발 설정 값과 달랐음을 남김
  const spec = Spec.parse(result.spec);
  for (const p of ["aws", "gcp"] as const) {
    const v = JSON.parse(String(targetBuilderFor(p).toTerraformV2(spec, TT(p)).vars.postgres_json))[0];
    assert.equal(v.db_name, "orders", p); assert.equal(v.app_user, "orders_user", p);
  }
  const on = targetBuilderFor("onprem").toWorkloadValues(spec, {}, TT("onprem")) as Record<string, any>;
  assert.equal(on.postgres[0].database, "orders"); assert.equal(on.postgres[0].owner, "orders_user");
  const stub = stubTfOutputsV2(spec);
  assert.equal(stub["link.shop-db.user"], "orders_user");
  assert.match(String(stub["link.shop-db.url"]), /^postgresql:\/\/orders_user@.*\/orders$/);
  // 모듈: 사용자·DB 이름이 cfg 에서 옴 ("app" 고정 없음), 루트가 db_username 을 냄
  for (const p of ["aws", "gcp"]) {
    const tf = readFileSync(`${root}infra/modules/${p}/kinds/postgres/main.tf`, "utf8");
    assert.ok(!/(username|name)\s+= "app"/.test(tf) && !/user = "app"/.test(tf), p);
    assert.match(readFileSync(`${root}infra/modules/${p}/root/main.tf`, "utf8"), /output "db_username"/);
  }
});

test("DBN-1 거부: 앱마다 계정이 다르면 고르지 않고 0.6 검토, 도착이 쓰는 이름(Cloud SQL postgres)은 사람 확인", () => {
  const { result } = normalizeV2(awsInv([
    dep("shop-api", [{ name: "DATABASE_URL", value: "postgres://a_user@shop-db.abc.ap-northeast-2.rds.amazonaws.com:5432/shop" }]),
    dep("shop-job", [{ name: "DATABASE_URL", value: "postgres://b_user@shop-db.abc.ap-northeast-2.rds.amazonaws.com:5432/shop" }]),
    { ...rds(), MasterUsername: "postgres" }]));
  const pg = result.spec.components.find((c) => c.kind === "postgres") as unknown as { props: Raw };
  assert.equal(pg.props.appUser, "postgres");   // 매퍼 값 유지 (어느 앱 것도 고르지 않음)
  assert.equal(result.fieldMeta["components.shop-db.appUser"]?.confidence, 0.6);
  assert.equal(pg.props.appDatabase, "shop");
  const spec = Spec.parse(result.spec);
  assert.ok(v2PrecheckItems("gcp", { specV2: spec }).some((i) => i.level === "block" && /앱 계정 postgres/.test(i.message)));
  assert.ok(!v2PrecheckItems("aws", { specV2: spec }).some((i) => i.level === "block" && /앱 계정/.test(i.message)), "RDS 는 postgres 마스터 계정을 받음");
});

test("DBN-1: 이름을 못 읽으면 기본(app·<앱>_)으로 만들고 사전 점검 경고", () => {
  const spec = Spec.parse(normalizeV2(awsInv([dep("shop-api", [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]), rds()])).result.spec);
  const items = v2PrecheckItems("aws", { specV2: spec });
  assert.ok(items.some((i) => i.level === "warn" && /앱 계정 이름을 못 읽음 → 도착은 app/.test(i.message)), JSON.stringify(items.map((i) => i.message)));
  assert.ok(items.some((i) => i.level === "warn" && /DB 이름을 못 읽음/.test(i.message)));
});

// ── BK-1 ─────────────────────────────────────────────
test("BK-1: 출발 백업 보관·PITR·유지보수 창을 IR 에 담고 RDS·Cloud SQL 도착에 그대로", () => {
  const r = rdsMapper.map({ ...rds(), BackupRetentionPeriod: 14, PreferredMaintenanceWindow: "Sun:05:00-Sun:06:00" }) as MappedComponent;
  assert.deepEqual(r.props.backup, { retentionDays: 14, pitr: true });
  assert.equal(r.props.maintenanceWindow, "sun:05:00-sun:06:00");
  const s = cloudSqlMapper.map({ kind: "cloudsql.instance", name: "shop-sql", databaseVersion: "POSTGRES_16", ipAddresses: [],
    settings: { backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true, backupRetentionSettings: { retainedBackups: 30, retentionUnit: "COUNT" } }, maintenanceWindow: { day: 7, hour: 23 } } }) as MappedComponent;
  assert.deepEqual(s.props.backup, { retentionDays: 30, pitr: true });
  assert.equal(s.props.maintenanceWindow, "sun:23:00-mon:00:00");
  const c = mapped(cnpgMapper.map(cnpg({ backup: null })));
  assert.deepEqual(c.props.backup, { retentionDays: 0, pitr: false });   // 백업 설정 없음 = 0 (못 읽음과 다름)
  const spec = Spec.parse(normalizeV2(awsInv([dep("shop-api", [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]),
    { ...rds(), BackupRetentionPeriod: 14, PreferredMaintenanceWindow: "sun:05:00-sun:06:00" }])).result.spec);
  for (const p of ["aws", "gcp"] as const) {
    const v = JSON.parse(String(targetBuilderFor(p).toTerraformV2(spec, TT(p)).vars.postgres_json))[0];
    assert.equal(v.backup_retention_days, 14, p); assert.equal(v.pitr, true, p); assert.equal(v.maintenance_window, "sun:05:00-sun:06:00", p);
  }
  // 온프레 도착은 백업 저장소가 없음 → 경고 (조용히 버리지 않음)
  assert.ok(v2PrecheckItems("onprem", { specV2: spec }).some((i) => i.level === "warn" && /백업 없이 만듦/.test(i.message)));
  const tf = readFileSync(`${root}infra/modules/aws/kinds/postgres/main.tf`, "utf8");
  assert.ok(!/backup_retention_period\s+= 1\b/.test(tf), "1일 고정 없음");
});

test("BK-1 거부: RDS 최대 35일을 넘는 Cloud SQL 백업 보관은 줄이지 않고 막힘", () => {
  const spec = Spec.parse(normalizeV2(inv("gcp", [dep("shop-api", [{ name: "DB_HOST", value: "10.20.0.5" }]),
    { kind: "cloudsql.instance", name: "shop-sql", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "20",
      backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true, backupRetentionSettings: { retainedBackups: 90, retentionUnit: "COUNT" } } },
      ipAddresses: [{ type: "PRIVATE", ipAddress: "10.20.0.5" }] }])).result.spec);
  assert.throws(() => targetBuilderFor("aws").toTerraformV2(spec, TT("aws")), /35일/);
  assert.ok(v2PrecheckItems("aws", { specV2: spec }).some((i) => i.level === "block" && /백업 보관 90일/.test(i.message)));
  assert.doesNotThrow(() => targetBuilderFor("gcp").toTerraformV2(spec, TT("gcp")));
});

test("BK-1: 출발이 백업 끔(0일)이면 도착 보안 사실의 PITR 도 끔 (모듈이 그대로 옮기므로)", async () => {
  const { targetFactsV2 } = await import("../src/index.js");
  const off = Spec.parse(normalizeV2(awsInv([dep("shop-api", [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]), { ...rds(), BackupRetentionPeriod: 0 }])).result.spec);
  assert.equal(targetFactsV2({ envId: "t", provider: "aws", region: "ap-northeast-2" }, off).dbs[0]!.db.pitr.value, false);
  const on = Spec.parse(normalizeV2(awsInv([dep("shop-api", [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]), { ...rds(), BackupRetentionPeriod: 7 }])).result.spec);
  assert.equal(targetFactsV2({ envId: "t", provider: "aws", region: "ap-northeast-2" }, on).dbs[0]!.db.pitr.value, true);
});

// ── DM-8 (DB 부분: CNPG WAL 볼륨) ─────────────────────
test("DM-8: CNPG walStorage 를 IR 에 담고, 온프레 값으로 넘기고, 클라우드 도착은 경고", () => {
  const m = mapped(cnpgMapper.map(cnpg({ imageName: "x/postgresql:16", walStorage: { size: "2Gi" } })));
  assert.equal(m.props.walStorageGb, 2);
  const spec = Spec.parse(normalizeV2(inv("onprem", [dep("shop-api", [{ name: "DB_HOST", value: "shop-db-rw.shop.svc" }]), cnpg({ imageName: "x/postgresql:16", walStorage: { size: "2Gi" } })])).result.spec);
  assert.equal((targetBuilderFor("onprem").toWorkloadValues(spec, {}, TT("onprem")) as Record<string, any>).postgres[0].walStorageGb, 2);
  assert.ok(v2PrecheckItems("aws", { specV2: spec }).some((i) => i.level === "warn" && /WAL 전용 볼륨 2GB/.test(i.message)));
});

test("DM-8 거부: WAL 볼륨 크기를 못 읽으면 칸 없이 0.6 검토", () => {
  const m = mapped(cnpgMapper.map(cnpg({ imageName: "x/postgresql:16", walStorage: { size: "lots" } })));
  assert.equal(m.props.walStorageGb, undefined);
  assert.equal(m.meta.walStorageGb?.[1], 0.6);
});
