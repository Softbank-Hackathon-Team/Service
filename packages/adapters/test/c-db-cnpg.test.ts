// CNPG-V2: 온프레 CNPG 값이 v2 차트(cnpg.yaml postgres 목록)로 (initdb·walStorage·resources)
// PG-PORT: 클라우드 postgres 값 포트 = IR 출발 포트 (Cloud SQL 은 5432 고정)
// CNPG-RO: 출발 CNPG 읽기 전용(-ro·-r) 주소 env → 링크 출력 reader (주 서버 host 로 안 바뀜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppSpecV2, checkV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor, stubTfOutputsV2 } from "../src/index.js";
const root = fileURLToPath(new URL("../../../", import.meta.url));

type Raw = Record<string, any>;
const D = "sha256:" + "ab".repeat(32);
const NS = "shop";
const inv = (provider: "onprem" | "gcp", items: Raw[]): RawInventory => ({ provider, coverage: {}, items } as unknown as RawInventory);
const dep = (name: string, env: Raw[]): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], resources: { requests: { cpu: "300m", memory: "768Mi" } }, env }] } } },
});
const cnpg = (spec: Raw = {}): Raw => ({ kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: NS },
  spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "5Gi" }, instances: 2, ...spec } });
const TT = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
const envOf = (spec: AppSpecV2, id: string, name: string) => ((spec.components.find((c) => c.id === id)!.props as { env: Raw[] }).env).find((e) => e.name === name)!;
const findEnv = (v: unknown, name: string): Raw | undefined => {
  if (Array.isArray(v)) { for (const x of v) { const r = findEnv(x, name); if (r) return r; } return undefined; }
  if (v && typeof v === "object") { const o = v as Raw; if (o.name === name && ("value" in o || "valueFrom" in o)) return o; for (const x of Object.values(o)) { const r = findEnv(x, name); if (r) return r; } }
  return undefined;
};

test("CNPG-RO: -ro 주소 env 는 reader, -rw 는 host → 온프레는 <cluster>-ro, 클라우드는 모듈 link.reader", () => {
  const { result } = normalizeV2(inv("onprem", [cnpg(), dep("api", [
    { name: "DB_READ_HOST", value: "shop-db-ro.shop.svc" }, { name: "DB_HOST", value: "shop-db-rw.shop.svc" },
    { name: "DB_READ_URL", value: "postgresql://app@shop-db-r.shop.svc.cluster.local:5432/app" }])]));
  assert.deepEqual(checkV2(result.spec).errors, []);
  const dbId = result.spec.components.find((c) => c.kind === "postgres")!.id;
  assert.deepEqual(envOf(result.spec, "api", "DB_READ_HOST"), { name: "DB_READ_HOST", fromLink: { to: dbId, output: "reader" } });
  assert.deepEqual(envOf(result.spec, "api", "DB_HOST"), { name: "DB_HOST", fromLink: { to: dbId, output: "host" } });
  assert.match(String((envOf(result.spec, "api", "DB_READ_URL") as Raw).template), new RegExp(`\\$\\{${dbId}\\.reader\\}`));
  const on = targetBuilderFor("onprem").toWorkloadValues(result.spec, {}, TT("onprem"));
  assert.match(String(findEnv(on, "DB_READ_HOST")?.value), /-ro$/);
  assert.match(String(findEnv(on, "DB_HOST")?.value), /-rw$/);
  const gcp = targetBuilderFor("gcp").toWorkloadValues(result.spec, {}, TT("gcp"));
  assert.equal(findEnv(gcp, "DB_READ_HOST")?.value, `<tf-output:link.${dbId}.reader>`);
  assert.ok(stubTfOutputsV2(result.spec)[`link.${dbId}.reader`], "흉내 출력에도 reader");
  for (const p of ["aws", "gcp"]) assert.match(readFileSync(`${root}infra/modules/${p}/kinds/postgres/main.tf`, "utf8"), /reader = length\(/, p);
});

test("CNPG-V2·PG-PORT: 온프레 값에 initdb·walStorage·resources, 차트는 postgres 목록을 읽음 / 클라우드 포트는 IR 포트(Cloud SQL 5432)", () => {
  const { result } = normalizeV2(inv("onprem", [cnpg({ walStorage: { size: "2Gi" }, bootstrap: { initdb: { database: "orders", owner: "orders_user" } },
    resources: { requests: { cpu: "1", memory: "2Gi" } } }), dep("api", [{ name: "DB_HOST", value: "shop-db-rw.shop.svc" }])]));
  const spec = AppSpecV2.parse(result.spec);
  const pg = (targetBuilderFor("onprem").toWorkloadValues(spec, {}, TT("onprem")) as Raw).postgres[0];
  assert.equal(pg.database, "orders"); assert.equal(pg.owner, "orders_user"); assert.equal(pg.walStorageGb, 2);
  const c = spec.components.find((x) => x.kind === "postgres")!.props as Raw;
  if (c.compute) assert.ok(pg.resources?.requests, "IR compute → CNPG resources");
  const chart = readFileSync(`${root}gitops/charts/app/templates/cnpg.yaml`, "utf8");
  assert.match(chart, /range \$pg := \(\.Values\.postgres/);
  assert.match(chart, /walStorage: \{ size:/);
  assert.match(chart, /initdb: \{ database: \{\{ required "postgres\[\]\.database" \$pg\.database/);
  // 포트: aws 는 IR 포트, gcp 는 5432
  const p6432 = AppSpecV2.parse({ ...spec, components: spec.components.map((x) => x.kind === "postgres" ? { ...x, props: { ...x.props, port: 6432 } } : x) });
  const port = (p: "aws" | "gcp", s: AppSpecV2) => ((targetBuilderFor(p).toWorkloadValues(s, {}, TT(p)) as Raw).postgres[0].port);
  assert.equal(port("aws", p6432), 6432);
  assert.equal(port("aws", spec), 5432, "포트 없음 = 5432");
  assert.equal(port("gcp", p6432), 5432, "Cloud SQL 은 포트를 못 바꿈");
});

test("거부: reader 출력은 postgres 에만 (queue 에 reader → checkV2 오류)", () => {
  const { result } = normalizeV2(inv("onprem", [cnpg(), dep("api", [{ name: "DB_HOST", value: "shop-db-rw.shop.svc" }])]));
  const s = structuredClone(result.spec) as unknown as Raw;
  s.components.push({ id: "q", kind: "queue", props: { model: "queue" } });
  s.links.push({ from: "api", to: "q" });
  const api = s.components.find((c: Raw) => c.id === "api");
  api.props.env.push({ name: "Q", fromLink: { to: "q", output: "reader" } });
  assert.ok(checkV2(s as never).errors.some((x) => /출력 reader 가 queue 에 없음/.test(x)));
});
