// PF-E35 APP-22 (가) DECISION(team, 11/4 01:57Z): Terraform 이 앱을 띄우는 도착(ECS·Cloud Run·VM)은 db_writer_json 으로 앱 DB 주소를 출발/도착 사이에서 바꾼다. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { DEMO_INVENTORY, dbLinkSecretName, dbWriterVar, normalizeV2, targetBuilderFor } from "../src/index.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "t-11111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const ECS = (): AppSpecV2 => AppSpecV2.parse(normalizeV2(DEMO_INVENTORY.aws!).result.spec);
const LINK = { host: "src-db.example", port: 5432, user: "svc_link_22222222", dbName: "shop" };

test("PF-E35 정상: 출발 쪽이면 postgres 출력 자리를 출발 경로로, 짝 비밀번호 줄을 출발 전용 그릇으로", () => {
  const spec = ECS();
  const pg = spec.components.find((c) => c.kind === "postgres")!.id;
  const t = { ...T, provider: "aws" } as never;
  const v = JSON.parse(dbWriterVar("aws", spec, t, "source", { [pg]: LINK }));
  assert.equal(v.active, "source");
  assert.deepEqual(v.link[pg], { host: LINK.host, port: "5432", user: LINK.user, url: `postgresql://${LINK.user}@${LINK.host}:5432/shop`, reader: LINK.host });
  assert.deepEqual(v.external, [dbLinkSecretName("aws", spec, t)]);
  assert.equal(dbLinkSecretName("aws", spec, t), `platform/${T.tenantId}/${spec.app.name}/db-link`);
  // 서비스가 실제로 쓰는 비밀 줄(그릇#키)이 바꿀 목록에 있다 → 루트가 그 줄만 출발 그릇으로 돌린다
  const svc = JSON.parse(targetBuilderFor("aws").toTerraformV2(spec, t).vars.service_json as string) as Array<{ secrets_json: string }>;
  const used = svc.flatMap((s) => (JSON.parse(s.secrets_json) as Array<{ secret: string; key: string }>).map((x) => `${x.secret}#${x.key}`));
  const paired = Object.keys(v.secrets);
  assert.ok(paired.length > 0 && paired.every((k) => used.includes(k)), JSON.stringify({ paired, used }));
  assert.ok(Object.values(v.secrets).every((x) => (x as { secret: string }).secret === v.external[0]));
  // 비밀번호 값은 안 들어간다
  assert.equal(JSON.stringify(v).includes("password\":\""), false);
  // gcp 그릇 이름 = 값 하나 (Cloud Run 은 키를 못 고름)
  assert.equal(dbLinkSecretName("gcp", spec, { ...T, provider: "gcp" } as never), `app-${spec.app.name}-db-link`);
});

test("PF-E35 거부: 명세에 없는 postgres id·도착 쪽이면 아무것도 안 바꾼다", () => {
  const spec = ECS();
  const t = { ...T, provider: "gcp" } as never;
  const none = JSON.parse(dbWriterVar("gcp", spec, t, "source", { "no-such-db": LINK }));
  assert.deepEqual(none, { active: "source", link: {}, secrets: {}, external: [] });
  const pg = spec.components.find((c) => c.kind === "postgres")!.id;
  assert.equal(JSON.parse(dbWriterVar("gcp", spec, t, "target", { [pg]: LINK })).active, "target");
});
