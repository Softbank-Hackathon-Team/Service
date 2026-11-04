// PF-A 1회차 (관점 3 네트워크 장애): 실검증 EKS 출발과 같은 입력(데모 3티어 + RDS + demo-day served-by)으로 discover → normalizeV2 → checkV2 를 끝까지.
//   PF-A1 플랫폼 네임스페이스(managed-by=platform)는 고객 앱 후보에서 뺀다 · PF-A2 kubectl 일시 오류는 재시도(SOURCE_TRANSIENT) · PF-A3 못 읽음 ≠ 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2 } from "@svc/contracts";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { CliError, classifyCliError } from "../src/common/cli.js";
import { pfExec, PF_NS } from "./pf-a-eks-demo-fixture.js";

type Fail = (l: string) => { code: number; err: string } | null;
const run = async (fail?: Fail, env: Record<string, string> = {}) => {
  const inv = await discoverAws({ exec: pfExec({ fail }).exec, env }, { iam: true });
  return normalizeV2(inv).result;
};
const reviews = (r: Awaited<ReturnType<typeof run>>) => Object.keys(r.fieldMeta).filter((k) => r.fieldMeta[k]!.needs_review).sort();
const NET = "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout";
const DENY_K = "Error from server (Forbidden): is forbidden: User cannot list resource";
const DENY_A = "An error occurred (AccessDeniedException) when calling the operation: User is not authorized";

test("PF-A1: served-by(app-demo, managed-by=platform)가 이름순 앞이어도 고객 앱 real-app 을 고른다 → 3티어 + RDS + 비밀 표 + 링크", async () => {
  const r = await run();
  assert.deepEqual(r.spec.components.map((c) => `${c.kind}:${c.id}`).sort(), ["postgres:platform-demo-db", "service:shop-api", "service:shop-web"]);
  assert.deepEqual(r.spec.links.map((l) => `${l.from}>${l.to}`).sort(), ["shop-api>platform-demo-db", "shop-web>shop-api"]);
  // FM-APP-08: 앱이 쓰는 비밀 둘이 IR 비밀 표에 키까지, DB 비밀번호는 짝(pairedWith) + 검토
  const sec = (r.spec.secrets ?? []).map((s) => `${s.name}:${s.keys.map((k) => k.key + (k.pairedWith ? `~${k.pairedWith.component}` : "")).join("+")}`).sort();
  assert.deepEqual(sec, ["api-secrets:API_TOKEN", "shop-db-app:password~platform-demo-db"]);
  assert.equal(r.fieldMeta["secrets.shop-db-app.keys.password.pairedWith"]?.needs_review, true);
  assert.equal(r.fieldMeta["check.pick.namespace"], undefined, "플랫폼 네임스페이스를 빼면 고를 게 하나뿐 → 고르기 검토 줄 없음");
  assert.deepEqual(checkV2(r.spec).errors, []);
  // N12: ConfigMap 값은 비밀이 아니라 그대로 옮긴다(configs.data). 비밀 값은 원래 안 읽음(Secret 목록을 부르지 않음)
  const api = r.spec.components.find((c) => c.id === "shop-api") as { props: { configs?: Array<{ data?: Record<string, string> }> } } | undefined;
  assert.equal(api?.props.configs?.[0]?.data?.LOG_LEVEL, "m-import-cfg-value-7");
});

test("PF-A1: 네임스페이스 목록을 못 읽으면(거부) 빼지 않고 예전처럼 고른 뒤 고르기 검토 줄 (조용히 엉뚱한 앱 아님)", async () => {
  const r = await run((l) => (/^kubectl get namespaces -l/.test(l) ? { code: 1, err: DENY_K } : null));
  assert.equal(r.fieldMeta["check.pick.namespace"]?.needs_review, true);
  const r2 = await run(undefined, { IMPORT_NAMESPACE: PF_NS });
  assert.deepEqual(r2.spec.components.map((c) => c.id).sort(), ["platform-demo-db", "shop-api", "shop-web"], "범위를 주면 목록을 안 봐도 됨");
});

test("PF-A2: kubectl 일시 오류(연결 끊김·시간 초과)는 핵심·비핵심 종류 모두 SOURCE_TRANSIENT (워커 재시도), 영구 실패·검토 줄로 안 바뀜", async () => {
  for (const re of [/^kubectl get services -n/, /^kubectl get horizontalpodautoscalers/, /^kubectl get namespace real-app/, /^kubectl get clusterrolebindings/, /^kubectl api-resources/, /^kubectl get namespaces -l/]) {
    await assert.rejects(run((l) => (re.test(l) ? { code: 1, err: NET } : null)), (e: Error & { code?: string }) => e.code === "SOURCE_TRANSIENT", re.source);
  }
  await assert.rejects(run((l) => (/^aws sns list-topics/.test(l) ? { code: 1, err: "Could not connect to the endpoint URL" } : null)), (e: Error & { code?: string }) => e.code === "SOURCE_TRANSIENT");
});

test("PF-A3: 거부·그 밖 실패는 조용히 '없음'이 아니라 못 읽음 검토 줄 (종류 목록·ClusterRoleBinding·Memcached·NAT·사설 DNS)", async () => {
  const cases: Array<[RegExp, string, string]> = [
    [/^kubectl api-resources/, DENY_K, "unread.APIResources"],
    [/^kubectl get clusterrolebindings/, DENY_K, "unread.ClusterRoleBinding"],
    [/^aws elasticache describe-cache-clusters/, DENY_A, "check.unread.elasticache.memcached"],
    [/^aws ec2 describe-nat-gateways/, DENY_A, "check.unread.net.egress"],
    [/^aws route53 list-hosted-zones-by-vpc/, DENY_A, "check.unread.dns.private"],
  ];
  const base = reviews(await run());
  for (const [re, err, key] of cases) {
    const r = await run((l) => (re.test(l) ? { code: 1, err } : null));
    assert.deepEqual(reviews(r).filter((k) => !base.includes(k)), [key], re.source);
    assert.deepEqual(r.spec.components.map((c) => c.id).sort(), ["platform-demo-db", "shop-api", "shop-web"], "나머지는 그대로");
  }
});

test("PF-A2: 오류 글에 찍힌 인자 --request-timeout=15s 만으로는 일시 오류가 아님", () => {
  const e = new CliError("kubectl", ["get", "pods"], 1, "error: the server doesn't have a resource type \"x\" (kubectl get pods --request-timeout=15s)");
  assert.equal(classifyCliError(e), "other");
  assert.equal(classifyCliError(new CliError("kubectl", ["get", "pods"], 1, NET)), "transient");
});

test("PF-A 2회차(시간·순서): 목록 순서가 뒤집혀도 같은 명세, 지우는 중·만드는 중 RDS 가 이름순 앞이어도 앱이 가리키는 DB 만", async () => {
  const go = async (o: Parameters<typeof pfExec>[0]) => normalizeV2(await discoverAws({ exec: pfExec(o).exec, env: {} }, { iam: true })).result;
  assert.equal(JSON.stringify(await go({ shuffle: 1 })), JSON.stringify(await go({})));
  const r = await go({ extraDbs: [
    { DBInstanceIdentifier: "aaa-old-demo-db", DBInstanceStatus: "deleting", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20, Endpoint: { Address: "aaa-old-demo-db.abcdefghij12.ap-northeast-2.rds.amazonaws.com", Port: 5432 } },
    { DBInstanceIdentifier: "bbb-new-db", DBInstanceStatus: "creating", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20 },
  ] });
  assert.deepEqual(r.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id), ["platform-demo-db"]);
  assert.deepEqual((r.outOfBoundary ?? []).map((o) => o.resource).sort(), ["rds.dbInstance:aaa-old-demo-db", "rds.dbInstance:bbb-new-db"]);
});

test("PF-A5 (4회차 운영자 실수): 앱 묶음(IMPORT_APP·partOf)을 줬는데 라벨 묶음이 없으면 조용히 다 담지 않고 check.pick.app 검토", async () => {
  const inv = await discoverAws({ exec: pfExec({}).exec, env: {} }, { iam: true });
  const r = normalizeV2(inv, { partOf: "shopp" }).result;
  assert.equal(r.fieldMeta["check.pick.app"]?.needs_review, true);
  assert.equal(normalizeV2(inv).result.fieldMeta["check.pick.app"], undefined, "안 주면 검토 줄 없음");
});

test("PF-A7 (7회차 대용량): 토픽 구독 60·버킷 알림 60·비밀 230개 앱도 명세 모양 검사 통과 (예전 상한 50·50·200 이라 가져오기 전체가 IMPORT_SPEC_INVALID)", async () => {
  const { ImportResultV2 } = await import("@svc/contracts");
  const { DATA_RAW_KINDS } = await import("../src/import/raw-data.js");
  const inv = await discoverAws({ exec: pfExec({}).exec, env: {} }, { iam: true });
  const arn = "arn:aws:sns:ap-northeast-2:111122223333:orders";
  type Dep = { kind: string; metadata: { name: string }; spec: { template: { spec: { containers: Array<{ env: unknown[] }> } } } };
  const api = (inv.items as unknown as Dep[]).find((i) => i.kind === "k8s.deployment" && i.metadata.name === "shop-api")!;
  const env = api.spec.template.spec.containers[0]!.env;
  env.push({ name: "TOPIC_ARN", value: arn }, { name: "UPLOAD_BUCKET", value: "shop-uploads" });
  for (let i = 0; i < 230; i++) env.push({ name: `S_${i}`, valueFrom: { secretKeyRef: { name: `sec-${i}`, key: "k" } } });
  const items = inv.items as unknown[];
  items.push({ kind: DATA_RAW_KINDS.sns, TopicArn: arn, Subscriptions: Array.from({ length: 60 }, (_, i) => ({ Protocol: "email", Endpoint: `u${i}@example.com` })) });
  items.push({ kind: DATA_RAW_KINDS.s3, Name: "shop-uploads", Versioning: null, Notification: { QueueConfigurations: Array.from({ length: 60 }, (_, i) => ({ QueueArn: `arn:aws:sqs:ap-northeast-2:111122223333:q${i}`, Events: ["s3:ObjectCreated:*"] })) } });
  const r = normalizeV2(inv).result;
  const p = ImportResultV2.safeParse(r);
  assert.ok(p.success, p.success ? "" : JSON.stringify(p.error.issues.slice(0, 3)));
  assert.equal(r.spec.secrets?.length, 232);
});
