// G3-1: CronJob 일정 줄임말(@hourly 등) → cron 5필드. 모르는 모양은 그 잡만 unmapped B (가져오기 전체는 통과)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { cronOf } from "../src/import/mappers/k8s-cronjob.js";

const D = "sha256:" + "ab".repeat(32);
const cj = (name: string, schedule: string) => ({ kind: "k8s.cronjob", imageDigest: D, metadata: { name, namespace: "shop" },
  spec: { schedule, jobTemplate: { spec: { template: { spec: { containers: [{ image: "ghcr.io/demo/batch:2" }] } } } } } });
const inv = (items: unknown[]): RawInventory => ({ provider: "onprem", coverage: {}, items: items as RawInventory["items"] });

test("정상: @hourly·@daily·@midnight·@annually 는 cron 5필드로 바뀌고 근거 메모가 남는다", () => {
  assert.deepEqual(cronOf("@hourly"), { cron: "0 * * * *", macro: "@hourly" });
  assert.equal(cronOf("@annually")?.cron, "0 0 1 1 *");
  assert.equal(cronOf(" 0 3 * * * ")?.cron, "0 3 * * *");
  const { result } = normalizeV2(inv([cj("hourly", "@hourly"), cj("daily", "@daily"), cj("mid", "@midnight")]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  const s = Object.fromEntries(result.spec.components.map((c) => [c.id, (c.props as { schedule: string }).schedule]));
  assert.deepEqual(s, { hourly: "0 * * * *", daily: "0 0 * * *", mid: "0 0 * * *" });
  assert.match(String(result.fieldMeta["components.hourly.schedule"]?.rationale), /@hourly/);
});

test("거부: @every·TZ= 앞붙이·필드 수 틀림은 그 잡만 unmapped B, 나머지는 그대로 가져온다", () => {
  for (const bad of ["@every 1h", "TZ=UTC 0 3 * * *", "0 3 * *", "@reboot"]) assert.equal(cronOf(bad), null, bad);
  const { result } = normalizeV2(inv([cj("ok", "@weekly"), cj("bad", "@every 1h")]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(result.spec.components.map((c) => c.id), ["ok"]);
  const u = result.unmapped.find((x) => x.resource.includes("bad"));
  assert.equal(u?.grade, "B");
  assert.match(u!.reason, /cron 5필드/);
});
