// fc1: 버킷 수명 규칙의 빠진 부분 검토 표시(DM-8), 관리형·VM 도착이 안 쓰는 준비 확인 경로 알림·GCP 비밀 이름 규칙(TF4-3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, type RawInventory } from "@svc/contracts";
import { DEMO_INVENTORY, normalizeV2 } from "../src/index.js";
import { managedWarnings } from "../src/target/managed.js";

type Raw = Record<string, any>;
const s3 = (Lifecycle: Raw[]): Raw => ({ kind: "s3.bucket", Name: "b1", Versioning: "Enabled", PublicAccessBlock: null, PolicyStatusIsPublic: false, AclPublic: false,
  SizeBytes: 0, Lifecycle, Cors: [], Arn: "arn:aws:s3:::b1" });
const norm = (items: Raw[]) => normalizeV2({ provider: "aws", coverage: {}, items } as RawInventory).result;
const life = (r: ReturnType<typeof norm>) => (r.spec.components.find((c) => c.id === "b1") as unknown as { props: Raw }).props.lifecycle;

test("DM-8: 수명 규칙에 옛 버전 만료·멀티파트 정리가 같이 있으면 담을 수 있는 부분은 담고 빠진 부분을 검토 표시", () => {
  const r = norm([s3([{ Status: "Enabled", Filter: { Prefix: "logs/" }, Expiration: { Days: 30 }, NoncurrentVersionExpiration: { NoncurrentDays: 7 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }])]);
  assert.deepEqual(life(r), [{ prefix: "logs/", expireDays: 30 }]);
  const m = r.fieldMeta["components.b1.lifecycle"];
  assert.equal(m?.needs_review, true);
  assert.match(m?.rationale ?? "", /옛 버전 만료/);
});

test("DM-8 거부: 일수 만료만 있는 규칙은 검토 표시 없음", () => {
  const r = norm([s3([{ Status: "Enabled", Filter: { Prefix: "tmp/" }, Expiration: { Days: 7 } }])]);
  assert.deepEqual(life(r), [{ prefix: "tmp/", expireDays: 7 }]);
  assert.equal(r.fieldMeta["components.b1.lifecycle"]?.needs_review, false);
});

test("TF4-3: ECS 도착은 준비 확인 경로를 안 씀 → 알림, Cloud Run(GCP)은 씀 → 그 알림 없음", () => {
  const spec = AppSpecV2.parse(normalizeV2(DEMO_INVENTORY.aws!).result.spec);
  const withPath = spec.components.filter((c) => c.kind === "service" && c.props.runtime === "managedContainer" && c.props.probes?.readiness?.type === "http");
  assert.ok(withPath.length > 0, "데모 ECS 서비스에 http 준비 확인이 있어야 함");
  const aws = managedWarnings("aws", spec);
  for (const w of withPath) assert.ok(aws.some((x) => x.startsWith(`${w.id}: 준비 확인 `))   /* 통합: TF4-3 문구는 c-rest 쪽(준비 확인 http …) */, aws.join("\n"));
  assert.ok(!managedWarnings("gcp", spec).some((x) => /준비 확인 (경로|http)/.test(x)));
});

test("TF4-3: GCP 비밀 이름은 k8s 이름의 . 도 - 로 (모듈 = Builder 같은 규칙), _ 만 바꾸던 옛 규칙은 없음", () => {
  const mod = readFileSync(new URL("../../../infra/modules/gcp/kinds/identity/main.tf", import.meta.url), "utf8");
  assert.doesNotMatch(mod, /replace\(n, "_", "-"\)/);
  assert.match(mod, /lower\(replace\(n, "\/\[\^A-Za-z0-9-\]\/", "-"\)\)/);
  const gcp = readFileSync(new URL("../src/target/gcp.ts", import.meta.url), "utf8");
  assert.match(gcp, /replace\(\/\[\^a-z0-9-\]\/g, "-"\)/);
});
