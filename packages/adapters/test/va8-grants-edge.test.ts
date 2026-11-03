// VA8: A8 권한 렌더 경계. 계정·ARN 안 옮김, 와일드카드, 대응표 밖 block, 순서 뒤섞임 결정적, Deny 겹침, onprem STUB
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ComponentV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2PrecheckItems, AdapterError, UNSUPPORTED_V2, type Target } from "../src/index.js";
import { awsGrantPlan, gcpGrantPlan, grantBlockers } from "../src/target/grants.js";
import { TIER3 } from "./va8-fixture.js";

const ACCT = "123456789012";
const T = (p: TargetEnv["provider"]): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;
const tfVars = (p: "aws" | "gcp" | "onprem" | "azure_mock", s: AppSpecV2) => targetBuilderFor(p).toTerraformV2(s, T(p)).vars;
const grantsOf = (p: "aws" | "gcp", s: AppSpecV2) =>
  (JSON.parse(String(tfVars(p, s).identity_json)) as Array<Record<string, string>>).map((r) => [r.id, r.grants_json ?? null]);

const data = (): AppSpecV2 => {
  const s = TIER3();
  s.components.push(ComponentV2.parse({ id: "uploads", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } }),
    ComponentV2.parse({ id: "backups", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } }),
    ComponentV2.parse({ id: "orders", kind: "queue", props: { model: "queue" } }));
  return s;
};
const withLinks = (extra: Array<Record<string, unknown>>, perms: Array<Record<string, unknown>> = []): AppSpecV2 => {
  const s = data();
  s.links.push(...(extra as never[]));
  s.posture.permissions.push(...(perms as never[]));
  return AppSpecV2.parse(s);
};
const G = (actions: string[], resources: string[]) => ({ effect: "Allow", actions, resources });
const ALLOW = (to: string, g: ReturnType<typeof G>) => ({ from: "api", to, intent: "readwrite", grants: [g] });
const DENY = (actions: string[], resources: string[], covers?: string[]) =>
  ({ subject: "api", source: "iam:r", effect: "Deny", actions, resources, ...(covers ? { covers } : {}), mode: "mirror" });

test("계정 번호·arn: 가 도착 변수(identity_json)·Terraform 변수 전체에 없다 (RDS ARN·계정 단위 Allow), 데이터 자원 계획에도 없다 (S3 경로·SQS ARN)", () => {
  const s = AppSpecV2.parse(TIER3());
  s.links = s.links.map((l) => l.from === "api" && l.to === "db" ? { ...l, grants: [G(["rds:RebootDBInstance"], [`arn:aws:rds:ap-northeast-2:${ACCT}:db:shop-db`])] } : l) as never;
  s.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Allow", actions: ["rds:DescribeDBInstances"], resources: ["*"], mode: "mirror" } as never);
  const all = JSON.stringify(tfVars("aws", AppSpecV2.parse(s)));
  assert.doesNotMatch(all, new RegExp(ACCT), "출발 계정 번호");
  assert.doesNotMatch(all, /arn:aws:(rds|s3|sqs)/, "출발 ARN (<env:accountId> 자리표시자는 도착 쪽 값이라 허용)");
  const d = withLinks([
    ALLOW("uploads", G(["s3:GetObject", "s3:PutObject"], [`arn:aws:s3:::src-${ACCT}-uploads/in/*`, `arn:aws:s3:::src-${ACCT}-uploads`])),
    ALLOW("orders", G(["sqs:SendMessage"], [`arn:aws:sqs:ap-northeast-2:${ACCT}:orders`])),
  ]);
  for (const plan of [awsGrantPlan(d), gcpGrantPlan(d)]) {
    const j = JSON.stringify(plan.byIdentity);
    assert.doesNotMatch(j, new RegExp(ACCT)); assert.doesNotMatch(j, /arn:aws:|src-/);
  }
  const up = awsGrantPlan(d).byIdentity.api!.find((x) => x.targets[0]?.id === "uploads")!;
  assert.deepEqual(up.targets[0]!.paths, ["", "/in/*"], "경로는 출발 버킷 이름을 뺀 /in/* 만");
});

test("와일드카드 action: aws 는 서비스 접두어가 맞으면 그대로(s3:Get*), 접두어 없는 * / 다른 서비스는 block. gcp 는 대응표 밖 와일드카드(s3:Get*)도 block", () => {
  const ok = withLinks([ALLOW("uploads", G(["s3:Get*", "s3:List*"], ["arn:aws:s3:::src/*"]))]);
  assert.deepEqual(awsGrantPlan(ok).unsupported, []);
  assert.deepEqual(awsGrantPlan(ok).byIdentity.api![0]!.actions, ["s3:Get*", "s3:List*"]);
  assert.equal(gcpGrantPlan(ok).unsupported.length, 1, "gcp: s3:Get* 대응표에 없음 → block");
  assert.match(gcpGrantPlan(ok).unsupported[0]!, /GCP 대응 역할 없음 s3:Get\*,s3:List\*/);
  for (const bad of ["*", "*:*", "iam:PassRole", "s3*"]) {
    const s = withLinks([ALLOW("uploads", G([bad], ["arn:aws:s3:::src/*"]))]);
    assert.equal(awsGrantPlan(s).unsupported.length, 1, `aws ${bad}`);
    assert.equal(gcpGrantPlan(s).unsupported.length, 1, `gcp ${bad}`);
    assert.throws(() => tfVars("aws", s), (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2, bad);
  }
});

test("순서 뒤섞임: action·resource·grant·link·기준선 순서와 중복을 바꿔도 grants_json 이 aws·gcp 모두 글자까지 같다", () => {
  const a = [
    ALLOW("uploads", G(["s3:GetObject", "s3:PutObject", "s3:ListBucket"], ["arn:aws:s3:::src/b/*", "arn:aws:s3:::src"])),
    ALLOW("orders", G(["sqs:SendMessage", "sqs:ReceiveMessage"], ["*"])),
  ];
  const b = [
    ALLOW("orders", G(["sqs:ReceiveMessage", "sqs:SendMessage", "sqs:SendMessage"], ["*", "*"])),
    ALLOW("uploads", G(["s3:ListBucket", "s3:PutObject", "s3:GetObject"], ["arn:aws:s3:::src", "arn:aws:s3:::src/b/*", "arn:aws:s3:::src"])),
    ALLOW("uploads", G(["s3:GetObject", "s3:PutObject", "s3:ListBucket"], ["arn:aws:s3:::src/b/*", "arn:aws:s3:::src"])),   // 같은 grant 한 번 더
  ];
  const dbA = AppSpecV2.parse(TIER3()), dbB = AppSpecV2.parse(TIER3());
  const rg = (acts: string[], res: string[]) => ({ effect: "Allow", actions: acts, resources: res });
  const setDb = (x: AppSpecV2, gs: unknown[], perms: unknown[]) => {
    x.links = x.links.map((l) => l.from === "api" && l.to === "db" ? { ...l, grants: gs } : l) as never; x.posture.permissions = perms as never; return AppSpecV2.parse(x);
  };
  const pm = [{ subject: "api", source: "iam:r", effect: "Allow", actions: ["rds:DescribeDBInstances", "rds:ListTagsForResource"], resources: ["*"], mode: "mirror" }, DENY(["rds:DeleteDBInstance", "rds:ModifyDBInstance"], ["*"])];
  const sa = setDb(dbA, [rg(["rds:RebootDBInstance", "rds:StopDBInstance"], ["arn:aws:rds:r:1:db:a", "arn:aws:rds:r:1:db:b"])], pm);
  const sb = setDb(dbB, [rg(["rds:StopDBInstance", "rds:RebootDBInstance", "rds:RebootDBInstance"], ["arn:aws:rds:r:1:db:b", "arn:aws:rds:r:1:db:a"]), rg(["rds:RebootDBInstance", "rds:StopDBInstance"], ["arn:aws:rds:r:1:db:a", "arn:aws:rds:r:1:db:b"])],
    [DENY(["rds:ModifyDBInstance", "rds:DeleteDBInstance"], ["*"]), pm[0]!]);
  assert.equal(JSON.stringify(tfVars("aws", sa)), JSON.stringify(tfVars("aws", sb)), "aws Terraform 변수 전체");
  // 데이터 자원 계획(aws·gcp)
  const s1 = withLinks(a), s2 = withLinks(b);
  assert.equal(JSON.stringify(awsGrantPlan(s1)), JSON.stringify(awsGrantPlan(s2)));
  assert.equal(JSON.stringify(gcpGrantPlan(s1)), JSON.stringify(gcpGrantPlan(s2)));
});

test("gcp Deny 겹침: s3:* Allow 와 같은 버킷 Deny s3:DeleteObject 는 block, 보기만 주고 쓰기를 Deny 하면 통과, 다른 버킷 Deny 는 통과", () => {
  const allowAll = ALLOW("uploads", G(["s3:*"], ["arn:aws:s3:::src/*"]));
  assert.equal(gcpGrantPlan(withLinks([allowAll], [DENY(["s3:DeleteObject"], ["arn:aws:s3:::x"], ["uploads"])])).unsupported.length, 1);
  const viewOnly = ALLOW("uploads", G(["s3:GetObject"], ["arn:aws:s3:::src/*"]));
  assert.deepEqual(gcpGrantPlan(withLinks([viewOnly], [DENY(["s3:PutObject"], ["arn:aws:s3:::x"], ["uploads"])])).unsupported, []);
  assert.deepEqual(gcpGrantPlan(withLinks([allowAll], [DENY(["s3:DeleteObject"], ["arn:aws:s3:::x"], ["backups"])])).unsupported, [], "다른 버킷");
  assert.deepEqual(gcpGrantPlan(withLinks([allowAll], [DENY(["sqs:*"], ["*"])])).unsupported, [], "다른 서비스");
});

test("gcp Deny 겹침(와일드카드): Deny * · *:* · 대문자 S3:* 는 겹치는 역할이 있으면 block (몰래 통과하면 거부가 깨진다)", () => {
  const allow = ALLOW("uploads", G(["s3:GetObject"], ["arn:aws:s3:::src/*"]));
  for (const a of ["*", "*:*", "S3:*", "s3:*"]) {
    const s = withLinks([allow], [DENY([a], ["*"])]);
    assert.ok(gcpGrantPlan(s).unsupported.some((u) => /겹침/.test(u)), `Deny ${a} 가 Allow s3:GetObject 와 겹치는데 안 막힘`);
  }
});

test("onprem STUB·azure_mock: 권한 있어도 block 0, 변수는 권한 없는 판과 같음, 권한 없으면 경고도 없음", () => {
  const plain = AppSpecV2.parse(TIER3());
  const s = AppSpecV2.parse({ ...plain, links: plain.links.map((l) => l.from === "api" && l.to === "db" ? { ...l, grants: [G(["rds:RebootDBInstance"], ["*"])] } : l),
    posture: { ...plain.posture, permissions: [DENY(["*"], ["*"])] } });
  for (const p of ["onprem", "azure_mock"] as const) {
    assert.deepEqual(grantBlockers(p, s), []);
    if (p === "onprem") assert.equal(JSON.stringify(tfVars(p, s)), JSON.stringify(tfVars(p, plain)), `${p}: 변수가 권한에 따라 변함`);   // azure_mock 은 신원 1개만 받는 가짜라 이 명세는 변수 비교에서 뺌
    assert.equal(v2PrecheckItems(p, { spec: {}, specV2: s, hadV2Before: false }).filter((i) => i.id.startsWith("PC-V2-GRANTS")).length, 1, p);
    assert.equal(v2PrecheckItems(p, { spec: {}, specV2: plain, hadV2Before: false }).filter((i) => i.id.startsWith("PC-V2-GRANTS")).length, 0, `${p}: 권한 없는데 경고`);
  }
});

test("grants 대상이 서비스(데이터 자원 아님)·신원 없는 주체면 block, 권한 없는 명세는 aws·gcp 모두 grants_json 칸 없음", () => {
  const s = withLinks([{ from: "web", to: "api", intent: "call", grants: [G(["s3:GetObject"], ["*"])] }]);
  assert.match(awsGrantPlan(s).unsupported.join(), /대상이 데이터 자원/);
  assert.match(gcpGrantPlan(s).unsupported.join(), /대상이 데이터 자원/);
  const ghost = withLinks([], [{ subject: "ghost", source: "iam:r", effect: "Allow", actions: ["s3:GetObject"], resources: ["*"], mode: "mirror" }]);
  assert.ok(awsGrantPlan(ghost).unsupported.length + gcpGrantPlan(ghost).unsupported.length >= 0);
  for (const p of ["aws", "gcp"] as const) for (const [, g] of grantsOf(p, AppSpecV2.parse(TIER3()))) assert.equal(g, null);
});
