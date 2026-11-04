// 온프레 DB 비밀번호: 온프레 도착에서는 앱이 CNPG 가 만든 <cluster>-app 비밀로 DB 에 붙는다 (출발 비밀 값과 CNPG 비밀번호가 달라 인증 실패하던 것)
//   입력 = 실검증 EKS 3티어 샘플과 같은 가져오기 입력(pf-a 고정본). 실클라우드·클러스터 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor, type Target } from "../src/index.js";
import { pfExec } from "./pf-a-eks-demo-fixture.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "onprem", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" } as Target;
type Env = { name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
type Vals = { workloads: Array<{ name: string; env?: Env[] }>; externalSecrets?: { secrets: Array<{ name: string }> }; warnings: string[] };
const render = (spec: AppSpecV2, p: "onprem" | "aws" = "onprem") => targetBuilderFor(p).toWorkloadValues(spec, {}, { ...T, provider: p } as Target) as unknown as Vals;
const envOf = (v: Vals, w: string, n: string) => v.workloads.find((x) => x.name === w)!.env!.find((e) => e.name === n)!;
const sample = async () => normalizeV2(await discoverAws({ exec: pfExec().exec, env: {} }, { iam: true })).result.spec;

test("정상: DB 비밀번호 줄은 CNPG <cluster>-app 의 password 를 보고, 그 비밀과 출발 DB 비밀은 저장소에서 안 가져온다", async () => {
  const v = render(await sample());
  assert.deepEqual(envOf(v, "shop-api", "DB_PASSWORD").valueFrom?.secretKeyRef, { name: "shop-api-platform-demo-db-app", key: "password" });
  const names = (v.externalSecrets?.secrets ?? []).map((s) => s.name);
  assert.ok(!names.includes("shop-db-app"), "출발 DB 비밀을 더는 저장소에서 가져오지 않음");
  assert.ok(!names.includes("shop-api-platform-demo-db-app"), "CNPG 가 만드는 비밀을 ExternalSecret 이 덮지 않음");
  // DB 와 무관한 비밀은 그대로
  assert.ok(names.includes("api-secrets"));
  assert.deepEqual(envOf(v, "shop-api", "API_TOKEN").valueFrom?.secretKeyRef, { name: "api-secrets", key: "API_TOKEN" });
});

test("거부: 연결 주소 통째 비밀은 바꾸지 않고 경고, 클라우드 도착은 예전 그대로(출발 비밀)", async () => {
  const s = await sample();
  const withUrl = AppSpecV2.parse({ ...s, components: s.components.map((c) => (c.id === "shop-api"
    ? { ...c, props: { ...c.props, env: [...(c.props as { env: unknown[] }).env, { name: "DATABASE_URL", fromSecret: { secret: "shop-db-url", key: "url" } }] } } : c)) });
  const v = render(withUrl);
  assert.deepEqual(envOf(v, "shop-api", "DATABASE_URL").valueFrom?.secretKeyRef, { name: "shop-db-url", key: "url" });
  assert.ok(v.warnings.some((w) => w.includes("DATABASE_URL") && w.includes("사람이 확인")), v.warnings.join("\n"));
  const aws = render(s, "aws");
  assert.deepEqual(envOf(aws, "shop-api", "DB_PASSWORD").valueFrom?.secretKeyRef, { name: "shop-db-app", key: "password" });
});
