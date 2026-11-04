// VI4: I4(AWS IAM → grants·기준선) 검증. 경계·거부·결정성·읽기 전용 명령 확인
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEC_LIMITS } from "@svc/contracts";
import { inferLinks } from "../src/import/links.js";
import { iamGrants, parseArn, type RawAwsIamPolicy } from "../src/import/mappers/iam-grants.js";
import type { MappedComponent } from "../src/import/types.js";
import { discoverAws } from "../src/discover/index.js";
import { readAwsIam } from "../src/discover/aws-iam.js";

const NS = "shop";
const wl = (id: string, sa = id, ns = NS): MappedComponent => ({
  id, name: id, kind: "service", props: { serviceAccount: sa, env: [] }, meta: {}, native: { type: "k8s.deployment", name: id, namespace: ns },
});
const bucket = (id: string): MappedComponent => ({ id, name: id, kind: "objectStore", props: {}, meta: {}, native: { type: "s3.bucket", name: id, endpoint: id } });
const queue = (id: string): MappedComponent => ({ id, name: id, kind: "queue", props: {}, meta: {}, native: { type: "sqs.queue", name: id } });
const db = (id: string): MappedComponent => ({ id, name: id, kind: "postgres", props: {}, meta: {}, native: { type: "rds.dbInstance", name: id } });
const pol = (sa: string, statements: unknown, ns: string | undefined = NS, roleName = `${sa}-role`): RawAwsIamPolicy =>
  ({ kind: "aws.iamPolicy", roleName, serviceAccount: sa, ...(ns ? { namespace: ns } : {}), statements });
const run = (cs: MappedComponent[], ps: RawAwsIamPolicy[]) => inferLinks(cs, [], ps);
const none = () => false;

test("VI4 결정성: 정책·문장 순서를 섞어도 같은 출력", () => {
  const st = [
    { Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::a/*"] },
    { Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:x:0:q"] },
    { Effect: "Deny", Action: ["s3:Delete*"], Resource: ["*"] },
  ];
  const cs = [wl("api"), wl("w"), bucket("a"), queue("q")];
  const p1 = pol("api", st), p2 = pol("w", st);
  const a = iamGrants(cs, [p1, p2], none), b = iamGrants(cs, [p2, { ...p1, statements: [...st].reverse() }], none);
  assert.deepEqual(a.permissions, b.permissions);
  assert.deepEqual(a.adds.map((x) => `${x.from}>${x.to}`).sort(), b.adds.map((x) => `${x.from}>${x.to}`).sort());
});

test("VI4 거부: 네임스페이스 없음·다른 네임스페이스·SA 불일치 → 링크 0, unmapped B", () => {
  const cs = [wl("api"), bucket("a")];
  const st = [{ Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::a/*"] }];
  const o = iamGrants(cs, [{ ...pol("api", st, NS, "r1"), namespace: undefined }, pol("api", st, "other", "r2"), pol("nobody", st, NS, "r3")], none);
  assert.equal(o.adds.length, 0);
  assert.equal(o.permissions.length, 0);
  assert.deepEqual(o.unmapped.map((u) => u.grade), ["B", "B", "B"]);
});

test("VI4 조건 Allow: 신뢰도 0.9 + conditions 원문 + 근거", () => {
  const cond = { StringEquals: { "aws:RequestedRegion": "ap-northeast-1" } };
  const o = iamGrants([wl("api"), bucket("a")], [pol("api", [{ Action: "s3:GetObject", Resource: "arn:aws:s3:::a/*", Condition: cond }])], none);
  assert.equal(o.adds.length, 1);
  assert.equal(o.adds[0]!.confidence, 0.9);
  assert.deepEqual(o.adds[0]!.grant.conditions, cond);
  assert.match(o.adds[0]!.rationale ?? "", /조건/);
  assert.ok(o.permissions.some((p) => p.conditions));
});

test("VI4 빈 Condition {} 은 조건 없음 취급 (신뢰도 1)", () => {
  const o = iamGrants([wl("api"), bucket("a")], [pol("api", [{ Action: "s3:GetObject", Resource: "arn:aws:s3:::a/*", Condition: {} }])], none);
  assert.equal(o.adds[0]!.confidence, 1);
  assert.equal(o.permissions.length, 0);
});

test("VI4 Deny *·NotResource: 링크 0, 기준선에 원문", () => {
  const o = iamGrants([wl("api"), bucket("a")], [pol("api", [
    { Effect: "Deny", Action: "*", Resource: "*" },
    { Action: "s3:*", NotResource: "arn:aws:s3:::a/*" },
  ])], none);
  assert.equal(o.adds.length, 0);
  assert.equal(o.permissions.length, 2);
  assert.ok(o.permissions.some((p) => p.effect === "Deny" && p.actions[0] === "*"));
  assert.ok(o.permissions.some((p) => p.notResources?.[0] === "arn:aws:s3:::a/*"));
});

test("VI4 Action * + 버킷 ARN → admin, 다른 서비스 대상은 덮여도 *만이면 링크 안 만듦", () => {
  const o = iamGrants([wl("api"), bucket("a"), queue("q")], [pol("api", [{ Action: "*", Resource: "arn:aws:s3:::a" }])], none);
  assert.deepEqual(o.adds.map((x) => [x.to, x.intent]), [["a", "admin"]]);
  const o2 = iamGrants([wl("api"), bucket("a"), queue("q")], [pol("api", [{ Action: "*", Resource: "*" }])], none);
  assert.equal(o2.adds.length, 0);
  assert.equal(o2.permissions.length, 1);
  const o3 = iamGrants([wl("api"), bucket("a"), queue("q")], [pol("api", [{ Action: "*", Resource: "*" }])], (f, t) => t === "q");
  assert.deepEqual(o3.adds.map((x) => x.to), ["q"]);
});

test("VI4 DB 대상: rds:* → connect, rds-db:connect 는 링크 없이 기준선", () => {
  const o = iamGrants([wl("api"), db("main")], [pol("api", [
    { Action: "rds:*", Resource: "arn:aws:rds:ap-northeast-1:0:db:main" },
    { Action: "rds-db:connect", Resource: "arn:aws:rds-db:ap-northeast-1:0:dbuser:db-ABC/app" },
  ])], none);
  assert.deepEqual(o.adds.map((x) => [x.to, x.intent]), [["main", "connect"]]);
  assert.ok(o.permissions.some((p) => p.actions[0] === "rds-db:connect"));
});

test("VI4 계정 단위 동작만 있는 문장 → 링크 0, 기준선", () => {
  const o = iamGrants([wl("api"), bucket("a")], [pol("api", [{ Action: ["s3:ListAllMyBuckets", "s3:CreateBucket"], Resource: "*" }])], none);
  assert.equal(o.adds.length, 0);
  assert.equal(o.permissions.length, 1);
});

test("VI4 쓰레기 문장(null·문자열·빈 배열)은 건너뜀, 던지지 않음", () => {
  const o = iamGrants([wl("api"), bucket("a")], [pol("api", [null, "x", 3, {}, { Action: [], Resource: [] }])], none);
  assert.equal(o.adds.length, 0);
});

test("VI4 inferLinks: grants 는 링크당 SPEC_LIMITS.grantsPerLink 개까지 (L-1: 예전 50 넘어도 그대로, 상한 초과만 잘림 + 검토 표시)", () => {
  const cap = SPEC_LIMITS.grantsPerLink;
  const sts = Array.from({ length: cap + 10 }, (_, i) => ({ Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::a/p${String(i).padStart(4, "0")}/*`] }));
  const out = run([wl("api"), bucket("a")], [pol("api", sts)]);
  const l = out.links.find((x) => x.to === "a")!;
  assert.equal(l.grants!.length, cap);
  assert.equal(out.meta["links.api->a"]!.needs_review, true);
  assert.match(out.meta["links.api->a"]!.rationale!, /10개는 사람이 확인/);
  const sixty = run([wl("api"), bucket("a")], [pol("api", sts.slice(0, 60))]);   // 예전 상한 50 을 넘는 흔한 크기
  assert.equal(sixty.links.find((x) => x.to === "a")!.grants!.length, 60);
  assert.notEqual(sixty.meta["links.api->a"]!.needs_review, true);
  const few = run([wl("api"), bucket("a")], [pol("api", sts.slice(0, cap))]);
  assert.notEqual(few.meta["links.api->a"]!.needs_review, true);
});

test("VI4 parseArn 경계", () => {
  assert.deepEqual(parseArn("*"), { service: "*", name: "*", path: "" });
  assert.equal(parseArn("arn:aws:s3:::bk").name, "bk");
  assert.equal(parseArn("arn:aws:s3:::bk/a/b").path, "/a/b");
  assert.equal(parseArn("arn:aws:sqs:r:1:q").name, "q");
  assert.equal(parseArn("arn:aws:rds:r:1:db:main").name, "main");
  assert.equal(parseArn("garbage").service, "?");
  assert.equal(parseArn("arn:aws:s3").service, "?");
});

// ---- 읽기 쪽: list/get/describe 만
function fakeExec(log: string[], fail?: (cmd: string) => boolean) {
  return (async (file: string, args: string[]) => {
    const cmd = `${file} ${args.join(" ")}`;
    log.push(cmd);
    if (fail?.(cmd)) throw new Error("denied");
    return { stdout: "{}", stderr: "" };
  }) as any;
}

test("VI4 IAM 끔(기본): iam 관련 aws 호출 0", async () => {
  const log: string[] = [];
  try { await (discoverAws as any)({ exec: fakeExec(log), region: "ap-northeast-1", cluster: "c" }); } catch { /* 입력 모양 무관 */ }
  assert.equal(log.filter((c) => /\biam\b|eks list-pod-identity|eks describe-pod-identity/.test(c)).length, 0);
});

test("VI4 readAwsIam: 쓰기 동사 호출 없음 + 읽기 실패 시 던지지 않음", async () => {
  const log: string[] = [];
  const notes: string[] = [];
  try { await (readAwsIam as any)(fakeExec(log, () => true), "ap-northeast-1", "c", [], notes); } catch (e) { assert.fail(String(e)); }
  assert.equal(log.filter((c) => /\b(create|delete|put|attach|detach|update|tag|untag)-/.test(c)).length, 0);
});
