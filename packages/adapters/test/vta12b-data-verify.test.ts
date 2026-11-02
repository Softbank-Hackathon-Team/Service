// 검증 묶음 VTA12b: TA12b 추가 검증 — 실행 권한 정책(와일드카드 0·app-* 범위)을 실제 이름이 지나가는지,
// 이름 한도(63자 등), 가짜 tf 출력의 모양, 정책 파일 전체의 쓰기 범위. 코드가 만드는 이름을 정책 글롭으로 직접 맞춰 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { upconvertV1, AppSpec, AppSpecV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor } from "../src/index.js";
import { stubTfOutputsV2 } from "../src/target/plan-v2.js";
import { cacheVars, objectStoreVars, queueVars } from "../src/target/data.js";

const dir = new URL("../../../infra/permissions/", import.meta.url);
type Stmt = { Sid?: string; Action: string | string[]; Resource: string | string[] };
const arr = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
const stmts = (f: string) => (JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { Statement: Stmt[] }).Statement;
const ROLE = "aws-operate-role-policy.json";
const SESSIONS = ["plan", "apply", "destroy"].map((p) => `aws-session-policy-${p}.json`);
const glob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

const V1 = AppSpec.parse({ schemaVersion: "1", app: { name: "shop" },
  service: { image: `r/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz", replicas: 1, cpu: "500m", memory: "1Gi", env: [], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 }, ingress: { hostname: "s.example.com", entry: "cloudflare-lb" } });
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
// id 는 ID_RE(소문자 시작, 소문자·숫자·-, 40자 이하) 안에서 까다로운 것들
const IDS = ["a", "shop-cache", "x".repeat(40), "a" + "-".repeat(39), "google", "goog-assets", "sthree", "n1234567890123456789012345678901234567890".slice(0, 40), "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t".slice(0, 40)];
function spec(ids: string[], appName = "shop"): AppSpecV2 {
  const s: any = structuredClone(upconvertV1(V1).spec);
  s.app.name = appName;
  for (const id of ids) s.components.push(
    { id: `${id}`.slice(0, 40), kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } },
  );
  return s;
}
function mixed(ids: string[]): AppSpecV2 {
  const s: any = structuredClone(upconvertV1(V1).spec);
  ids.forEach((id, i) => {
    const suffix = ["c", "o", "q"][i % 3]!;
    const n = `${id.slice(0, 38)}-${suffix}`.slice(0, 40);   // 세 종류가 같은 id 를 쓰지 못하므로 접미어
    const kind = ["cache", "objectStore", "queue"][i % 3]!;
    s.components.push(kind === "cache" ? { id: n, kind, props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } }
      : kind === "objectStore" ? { id: n, kind, props: { versioning: false, public: false, sizeGb: 1 } }
      : { id: n, kind, props: { model: "queue" } });
  });
  return AppSpecV2.parse(s);
}
const jsonOf = (r: string) => JSON.parse(r) as Array<Record<string, any>>;
const names = (p: "aws" | "gcp", sp: AppSpecV2) => {
  const t = T(p);
  return { cache: jsonOf(cacheVars(sp, t)).map((x) => x.name as string), bucket: jsonOf(objectStoreVars(sp, t)).map((x) => x.name as string),
    queue: jsonOf(queueVars(sp, t)).map((x) => x.name as string) };
};

test("실제 이름이 정책 글롭을 지난다: 복제그룹·구독그룹·버킷·SQS·SNS ARN 이 DataScoped 의 app-* 패턴에 전부 맞음 (까다로운 id 포함)", () => {
  const scoped = stmts(ROLE).find((s) => s.Sid === "DataScoped")!;
  const pats = arr(scoped.Resource).map(glob);
  const hit = (arn: string) => pats.some((r) => r.test(arn));
  const n = names("aws", mixed(IDS));
  assert.ok(n.cache.length && n.bucket.length && n.queue.length, "세 종류가 다 있어야 함");
  for (const c of n.cache) { assert.ok(hit(`arn:aws:elasticache:ap-northeast-2:123456789012:replicationgroup:${c}`), c); assert.ok(hit(`arn:aws:elasticache:ap-northeast-2:123456789012:subnetgroup:${c}`), c); }
  for (const b of n.bucket) { assert.ok(hit(`arn:aws:s3:::${b}`), b); assert.ok(hit(`arn:aws:s3:::${b}/obj`), b); }
  for (const q of n.queue) { assert.ok(hit(`arn:aws:sqs:ap-northeast-2:123456789012:${q}`), q); assert.ok(hit(`arn:aws:sqs:ap-northeast-2:123456789012:${q}.fifo`), q); assert.ok(hit(`arn:aws:sns:ap-northeast-2:123456789012:${q}`), q); }
});

test("거부: 접두어 없는 남의 자원(이름이 app- 가 아님)은 정책 글롭에 안 맞음 — 범위가 이름 접두어로 실제로 제한됨", () => {
  const scoped = stmts(ROLE).find((s) => s.Sid === "DataScoped")!;
  const pats = arr(scoped.Resource).filter((r) => !r.includes("parametergroup")).map(glob);
  const hit = (arn: string) => pats.some((r) => r.test(arn));
  for (const bad of ["arn:aws:s3:::customer-prod-data", "arn:aws:s3:::application-x", "arn:aws:sqs:ap-northeast-2:1:orders",
    "arn:aws:sns:ap-northeast-2:1:alerts", "arn:aws:elasticache:ap-northeast-2:1:replicationgroup:prod-cache", "arn:aws:s3:::xapp-data"]) assert.ok(!hit(bad), bad);
});

test("이름 한도: 캐시 ≤40(+'-sg' 파생이름 ≤255), 버킷 3~63·소문자 숫자 하이픈·양끝 영숫자, 큐·토픽 ≤60(.fifo 붙여도 ≤80), 전부 app- 로 시작, 호출마다 같은 이름", () => {
  for (const p of ["aws", "gcp"] as const) {
    const sp = mixed(IDS), n = names(p, sp);
    for (const c of n.cache) { assert.ok(c.length <= 40 && c.startsWith("app-"), c); assert.match(c, /^[a-z][a-z0-9-]*$/); assert.ok(`${c}-sg`.length <= 255); }
    for (const b of n.bucket) { assert.ok(b.length >= 3 && b.length <= 63 && b.startsWith("app-"), b); assert.match(b, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      assert.ok(!/google|^goog|^sthree-|\.\.|^xn--|-s3alias$/.test(b), `금지어: ${b}`); }
    for (const q of n.queue) { assert.ok(q.length <= 60 && q.startsWith("app-"), q); assert.ok(`${q}.fifo`.length <= 80); assert.match(q, /^[a-zA-Z0-9_-]+$/); }
    assert.deepEqual(n, names(p, mixed(IDS)), `${p} 이름이 호출마다 같아야 함`);
  }
});

test("이름 겹침 0: 같은 앞부분·같은 길이로 잘리는 긴 id 둘, 다른 이전·다른 환경이어도 이름이 서로 다름", () => {
  const a = "x".repeat(39) + "1", b = "x".repeat(39) + "2";
  const s = (() => { const o: any = structuredClone(upconvertV1(V1).spec);
    for (const id of [a, b]) o.components.push({ id, kind: "objectStore", props: { versioning: false, public: false, sizeGb: 1 } },
      { id: id.replace(/x$/, "y").slice(0, 40), kind: "queue", props: { model: "queue" } }); return AppSpecV2.parse(o); })();
  const n = names("aws", s);
  assert.equal(new Set(n.bucket).size, n.bucket.length, "버킷 이름 겹침");
  assert.equal(new Set(n.queue).size, n.queue.length, "큐 이름 겹침");
  const other = { ...T("aws"), migrationId: "55555555-5555-4555-8555-555555555555" };
  const b2 = jsonOf(objectStoreVars(s, other)).map((x) => x.name as string);
  assert.ok(b2.every((x) => !n.bucket.includes(x)), "이전이 다르면 버킷 이름도 달라야 함(전역 이름 충돌 방지)");
});

test("정책 파일 전체: 4개 AWS 정책에 와일드카드 action 0, 역할 정책의 데이터 쓰기 동작(생성·삭제·Put·Set·Tag·Modify)은 Resource \"*\" 문장에 없음", () => {
  const WRITE = /^(elasticache|s3|sqs|sns):(Create|Delete|Put|Set|Tag|Add|Modify)/;
  for (const f of [ROLE, ...SESSIONS]) for (const s of stmts(f)) for (const a of arr(s.Action)) assert.ok(!a.includes("*"), `${f} ${a}`);
  // 세션 정책은 Resource "*" 여도 실제 권한 = 역할 ∩ 세션 이라 범위는 역할 정책이 정한다 (부분집합은 아래 시험)
  for (const s of stmts(ROLE)) if (arr(s.Resource).includes("*"))
    for (const a of arr(s.Action)) assert.ok(!WRITE.test(a), `${ROLE}: ${a} 는 Resource * 에 있으면 안 됨`);
});

test("읽기 동작 보강: ElastiCache 복제그룹 plan 에 멤버 클러스터 조회(DescribeCacheClusters)가 있고, 세션 정책 3개는 역할 정책의 부분집합·2,048자 이내", () => {
  const acts = (f: string) => new Set(stmts(f).flatMap((s) => arr(s.Action)));
  assert.ok(acts(ROLE).has("elasticache:DescribeCacheClusters"));
  for (const f of SESSIONS) {
    assert.ok(acts(f).has("elasticache:DescribeCacheClusters"), f);   // plan·apply·destroy 모두 상태를 읽음
    assert.deepEqual([...acts(f)].filter((a) => !acts(ROLE).has(a)), [], f);
    assert.ok(JSON.stringify(JSON.parse(readFileSync(new URL(f, dir), "utf8"))).length <= 2048, `${f} 길이`);
  }
  assert.ok([...acts("aws-session-policy-plan.json")].every((a) => /:(Describe|Get|List)/.test(a)));
});

test("가짜 tf 출력: 긴 id 에서도 호스트 DNS 라벨 ≤63자, 자리표시 키 모양(link.<id>.<출력>) 유지, 같은 명세는 같은 출력", () => {
  const sp = mixed(IDS), out = stubTfOutputsV2(sp);
  for (const [k, v] of Object.entries(out)) assert.ok(typeof v === "string" && v.length > 0, k);
  for (const [k, v] of Object.entries(out).filter(([k]) => k.endsWith(".host")))
    for (const label of v.split(".")) assert.ok(label.length <= 63, `${k} 라벨 ${label.length}자: ${label}`);
  assert.deepEqual(out, stubTfOutputsV2(mixed(IDS)));
});

test("가짜 tf 출력 → 앱 env: 긴 id 에서도 template·fromLink 가 같은 값으로 풀림 (aws·gcp)", () => {
  for (const p of ["aws", "gcp"] as const) {
    const s: any = structuredClone(mixed(IDS));
    const svc = s.components.find((c: any) => c.kind === "service");
    const cache = s.components.find((c: any) => c.kind === "cache");
    svc.props.env.push({ name: "LONG_REDIS", template: `\${${cache.id}.url}` }, { name: "LONG_HOST", fromLink: { to: cache.id, output: "host" } });
    s.links.push({ from: svc.id, to: cache.id, intent: "connect" });
    const sp = AppSpecV2.parse(s), out = stubTfOutputsV2(sp);
    const v: any = targetBuilderFor(p).toWorkloadValues(sp, out, T(p));
    const env = v.workloads.find((w: any) => w.id === svc.id).env as Array<{ name: string; value?: string }>;
    assert.equal(env.find((e) => e.name === "LONG_REDIS")?.value, out[`link.${cache.id}.url`]);
    assert.equal(env.find((e) => e.name === "LONG_HOST")?.value, out[`link.${cache.id}.host`]);
    assert.ok(!JSON.stringify(v).includes(`<tf-output:link.${cache.id}`), p);
  }
});
