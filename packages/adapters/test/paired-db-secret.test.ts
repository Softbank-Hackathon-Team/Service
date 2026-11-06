// 2026-11-07 온프레 → AWS: 출발 DB 비밀번호 비밀(pairedWith)은 사람이 채우는 그릇이 아니라 도착 DB 비밀번호 그릇에서 온다 (APP-20 정지 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChartValues } from "@svc/contracts";
import { DEMO_SPEC, targetBuilderFor, type Target } from "../src/index.js";

const T = (provider: "aws" | "gcp"): Target => ({ envId: "33333333-3333-4333-8333-333333333333", provider, region: "ap-northeast-2",
  tenantId: "11111111-1111-4111-8111-111111111111", projectId: "demo-target", accountId: "123456789012", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;

function specWith(keys: Array<{ key: string; paired: boolean }>) {
  const s = structuredClone(DEMO_SPEC) as any;
  const pg = s.components.find((c: any) => c.kind === "postgres");
  const svc = s.components.find((c: any) => c.kind === "service");
  assert.ok(pg && svc, "데모 명세에 postgres·service 가 있어야");
  for (const k of keys) svc.props.env.push({ name: `X_${k.key.toUpperCase()}`, fromSecret: { secret: "demo-db-app", key: k.key } });
  // 데모 명세의 원래 DB 비밀(shop-db, 이미 짝)은 빼고 이 시험의 비밀 하나만 둔다
  s.secrets = [...(s.secrets ?? []).filter((x: any) => !x.keys.some((k: any) => k.pairedWith)),
    { name: "demo-db-app", keys: keys.map((k) => ({ key: k.key, ...(k.paired ? { pairedWith: { component: pg.id, output: "password" } } : {}) })) }];
  return { spec: s, pgId: pg.id as string };
}

test("정상: 키 password 하나가 도착 DB 와 짝이면 사용자 비밀 목록에서 빠지고, 차트 DB 비밀이 출발 이름으로 생긴다", () => {
  const { spec, pgId } = specWith([{ key: "password", paired: true }]);
  const v = ChartValues.parse(targetBuilderFor("aws").toWorkloadValues(spec, {}, T("aws")));
  assert.ok(!v.externalSecrets.secrets.some((s) => s.name === "demo-db-app"), "사람이 채울 그릇으로 남지 않음");
  const pg = v.postgres!.find((p) => p.id === pgId)! as any;
  assert.equal(pg.secretName, "demo-db-app");
  assert.equal((pg as any).passwordProperty, "password");
});

test("거부: 짝이 아닌 키가 섞이면 바꿔 끼우지 않고 경고를 남긴다", () => {
  const { spec, pgId } = specWith([{ key: "password", paired: true }, { key: "username", paired: false }]);
  const v = ChartValues.parse(targetBuilderFor("aws").toWorkloadValues(spec, {}, T("aws")));
  assert.ok(v.externalSecrets.secrets.some((s) => s.name === "demo-db-app"));
  assert.notEqual((v.postgres!.find((p) => p.id === pgId) as any).secretName, "demo-db-app");
  assert.ok(v.warnings!.some((w) => w.includes("demo-db-app")), "경고");
});

test("데모 명세 그대로: 짝인 DB 비밀(shop-db)은 도착 DB 비밀번호 그릇에서 온다 (사람이 채울 그릇 아님)", () => {
  const v = ChartValues.parse(targetBuilderFor("aws").toWorkloadValues(DEMO_SPEC, {}, T("aws")));
  assert.ok(!v.externalSecrets.secrets.some((s) => s.name === "shop-db"));
  assert.equal((v.postgres!.find((p) => p.id === "shop-db") as any).secretName, "shop-db");
});
