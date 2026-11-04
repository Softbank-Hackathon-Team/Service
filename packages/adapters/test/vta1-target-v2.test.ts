import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, rdsClassFor, cloudSqlTierFor, AdapterError, UNSUPPORTED_V2, type Target } from "../src/index.js";

// VTA1: TA1(도착 Builder v2) 검증 — 경계값·거부·입력 불변·이름 길이·멱등. DB 없음

const T = (p: TargetEnv["provider"]): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;
const D = (c: string) => `sha256:${c.repeat(64)}`;
const parseJson = (v: unknown) => JSON.parse(String(v));
const PROVIDERS = ["aws", "gcp", "onprem"] as const;

const ENTRY = { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], tls: { mode: "terminate" },
  routes: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "api", port: 80, weight: 1 }] }] }] };
function mk(o: { app?: string; dbId?: string; storageGb?: number; storageMaxGb?: number; sa?: string; api?: Record<string, unknown> } = {}): AppSpecV2 {
  const dbId = o.dbId ?? "db";
  return AppSpecV2.parse({
    schemaVersion: "2", app: { name: o.app ?? "shop" },
    components: [
      { id: "api", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
        image: { source: "registry", repository: "ghcr.io/demo/api", digest: D("a") }, resources: {}, env: [{ name: "H", fromLink: { to: dbId, output: "host" } }],
        serviceAccount: o.sa ?? "api", replicas: { min: 1, max: 1 }, ports: [{ port: 8080, protocol: "TCP" }], endpoints: [], ...(o.api ?? {}) } },
      { id: dbId, kind: "postgres", props: { majorVersion: "16", storageGb: o.storageGb ?? 20, ...(o.storageMaxGb ? { storageMaxGb: o.storageMaxGb } : {}) } },
    ],
    links: [{ from: "api", to: dbId, intent: "connect" }],
    entry: ENTRY, posture: { permissions: [], network: [] },
  });
}
const deepFreeze = <X>(x: X): X => { if (x && typeof x === "object") { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };

test("멱등·불변: 입력 명세를 고치지 않고(동결해도 통과), 두 번 부르면 같은 결과", () => {
  for (const p of PROVIDERS) {
    const s = deepFreeze(mk()), b = targetBuilderFor(p);
    const a = b.toTerraformV2(s, T(p)), c = b.toTerraformV2(s, T(p));
    assert.deepEqual(a, c, p);
    assert.deepEqual(b.toWorkloadValues(s, {}, T(p)), b.toWorkloadValues(s, {}, T(p)), p);
  }
});

test("경계: DB 저장 공간은 상품 최소(aws 20, gcp 10)로만 올리고, 최소 이상이면 IR 값 그대로", () => {
  const sg = (p: "aws" | "gcp", gb: number) => parseJson(targetBuilderFor(p).toTerraformV2(mk({ storageGb: gb }), T(p)).vars.postgres_json)[0].storage_gb;
  assert.deepEqual([sg("aws", 1), sg("aws", 20), sg("aws", 21), sg("aws", 500)], [20, 20, 21, 500]);
  assert.deepEqual([sg("gcp", 1), sg("gcp", 10), sg("gcp", 11), sg("gcp", 500)], [10, 10, 11, 500]);
});

test("경계: 최소로 올린 저장 공간보다 자동 확장 상한이 작으면 안 된다 (apply 가 실패)", () => {
  for (const [p, min] of [["aws", 20], ["gcp", 10]] as const) {
    const pg = parseJson(targetBuilderFor(p).toTerraformV2(mk({ storageGb: 2, storageMaxGb: 5 }), T(p)).vars.postgres_json)[0];
    assert.ok(pg.storage_max_gb === null || pg.storage_max_gb >= pg.storage_gb, `${p} max ${pg.storage_max_gb} < storage ${pg.storage_gb} (최소 ${min})`);
  }
});

test("경계: Cloud SQL 맞춤 등급은 요청 메모리를 낮추지 않는다 (vCPU 당 메모리 상한 6.5GiB 때문에 vCPU 를 올림)", () => {
  const mem = (t: string | null) => Number(t!.split("-")[3]);
  for (const [cpuMilli, memMiB] of [[1000, 16384], [2000, 65536], [1000, 6656], [4000, 8192]] as const) {
    const t = cloudSqlTierFor({ cpuMilli, memMiB });
    assert.ok(mem(t) >= memMiB, `${cpuMilli}m/${memMiB}Mi → ${t}`);
    assert.ok(Number(t!.split("-")[2]) >= Math.ceil(cpuMilli / 1000), `vCPU 도 낮추지 않음 ${t}`);
  }
  assert.equal(cloudSqlTierFor({ cpuMilli: 1000, memMiB: 16384 }), "db-custom-4-16384");
});

// SZ-1 (fc2): 가장 큰 등급보다 큰 요청은 낮춰 고르지 않고 UNSUPPORTED_V2 (사전 점검은 같은 목록을 block 으로). 표에 m6g·r6g 큰 급을 더함
test("RDS: 가장 큰 등급보다 큰 요청은 낮춰서 고르지 말고 알려야 한다", () => {
  assert.equal(rdsClassFor({ cpuMilli: 64_000, memMiB: 262_144 }), "db.m6g.16xlarge");
  assert.throws(() => rdsClassFor({ cpuMilli: 128_000, memMiB: 1_048_576 }), /UNSUPPORTED|최대/);
});

test("이름 길이: 앱 이름 + 40자 DB id 로 만든 온프레 CNPG 이름·접속 주소가 쿠버네티스 이름 한도(63자) 안", () => {
  const dbId = "d" + "b".repeat(39);
  const v = targetBuilderFor("onprem").toWorkloadValues(mk({ app: "a".repeat(30), dbId }), {}, T("onprem")) as Record<string, any>;
  const pg = v.postgres[0];
  assert.ok(pg.name.length <= 50, `CNPG 클러스터 이름 ${pg.name.length}자 (Pod 이름 접미어 때문에 50자 이내가 안전)`);
  assert.ok(pg.host.length <= 63, `접속 서비스 이름 ${pg.host.length}자`);
  assert.ok(pg.passwordSecret.length <= 63, `비밀 이름 ${pg.passwordSecret.length}자`);
});

test("신원: 서비스 계정이 같은 두 서비스는 도착 신원 하나, 다르면 둘 (이름 겹침 없음)", () => {
  const s = mk();
  s.components.push(JSON.parse(JSON.stringify({ ...s.components[0], id: "api2" })));
  s.links.push({ from: "api2", to: "db", intent: "connect" });
  for (const p of ["aws", "gcp"] as const) {
    assert.equal(parseJson(targetBuilderFor(p).toTerraformV2(s, T(p)).vars.identity_json).length, 1, `${p} 같은 SA`);
    const s2 = AppSpecV2.parse(JSON.parse(JSON.stringify(s)));
    (s2.components.find((c) => c.id === "api2")!.props as { serviceAccount: string }).serviceAccount = "other";
    const ids = parseJson(targetBuilderFor(p).toTerraformV2(s2, T(p)).vars.identity_json) as Array<{ name: string }>;
    assert.equal(ids.length, 2, `${p} 다른 SA`);
    assert.equal(new Set(ids.map((i) => i.name)).size, 2);
  }
});

test("azure_mock: TA10 뒤 두 렌더가 mock 결과를 내고 capability 에 mock 포함", () => {
  const b = targetBuilderFor("azure_mock");
  assert.ok(b.capabilities().includes("mock"));
  for (const f of [() => b.toTerraformV2(mk(), T("azure_mock")), () => b.toWorkloadValues(mk(), {}, T("azure_mock"))])
    assert.doesNotThrow(f);
});

test("비밀: 값(env value)이 아닌 비밀 참조만 나가고, Terraform 변수에 비밀 값이 없다", () => {
  const s = mk({ api: { env: [{ name: "PW", fromSecret: { secret: "shop-db", key: "password" } }] } });
  for (const p of PROVIDERS) {
    const v = targetBuilderFor(p).toWorkloadValues(s, {}, T(p)) as Record<string, any>;
    const pw = v.workloads[0].env.find((e: { name: string }) => e.name === "PW");
    assert.deepEqual(pw, { name: "PW", valueFrom: { secretKeyRef: { name: "shop-db", key: "password" } } });
    assert.equal("value" in pw, false);
  }
});
