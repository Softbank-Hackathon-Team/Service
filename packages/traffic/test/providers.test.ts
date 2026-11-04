import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloudflareLb, cloudflarePatchBody, cloudflarePreflight, gcpGclb, awsAlb, mockAlbApi, mockLb,
  setAndVerify, SwitchFailed, InvalidWeights, ProviderError, switcherFromEnv, prometheusMetrics, promQueries,
  type FetchLike,
} from "../src/index.js";
import { cloudflareWeightsOf, runShift, stubMetrics } from "../src/index.js";

const C = { sourcePoolId: "pool-src", targetPoolId: "pool-tgt" };
const noSleep = async () => {};
// z75-35: runShift 는 100% 뒤 "시계로 30초" 를 채워야 끝난다. sleep 만 비우고 시계를 안 주면 진짜 30초 동안 빈 반복을 돈다(CPU 100%).
//         다른 시험(state·traffic)처럼 sleep 할 때마다 가짜 시계를 그만큼 민다
let clockMs = Date.parse("2026-11-07T01:00:00Z");
const fastShift = { sleep: async (ms: number) => { clockMs += ms; }, now: () => new Date(clockMs) };

// 가짜 Cloudflare: 받은 요청을 기록하고 LB 상태를 메모리에 둔다
function fakeCloudflare(lb: Record<string, unknown>) {
  const reqs: Array<{ method: string; url: string; auth: string; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    reqs.push({ method: init.method, url, auth: init.headers.authorization!, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "PATCH") Object.assign(lb, JSON.parse(init.body!));
    return { status: 200, json: async () => ({ success: true, errors: [], result: lb }) };
  };
  return { f, reqs };
}

test("Cloudflare: PATCH 본문은 random 정책 + 두 pool 가중치, 경로는 zone 아래, 토큰은 Bearer", async () => {
  assert.deepEqual(cloudflarePatchBody(C, { source: 0.9, target: 0.1 }), {
    steering_policy: "random", random_steering: { default_weight: 0, pool_weights: { "pool-src": 0.9, "pool-tgt": 0.1 } },
  });
  const lb = { id: "lb1", proxied: true, session_affinity: "none", fallback_pool: "pool-src", default_pools: ["pool-src", "pool-tgt"] };
  const { f, reqs } = fakeCloudflare(lb);
  const sw = cloudflareLb({ zoneId: "z1", ...C, token: async () => "tok-test", fetch: f });
  await setAndVerify(sw, "lb1", { source: 0.5, target: 0.5 }, { sleep: noSleep });
  assert.deepEqual(await sw.get("lb1"), { source: 0.5, target: 0.5 });
  assert.equal(reqs[0]!.method, "PATCH");
  assert.equal(reqs[0]!.url, "https://api.cloudflare.com/client/v4/zones/z1/load_balancers/lb1");
  assert.equal(reqs[0]!.auth, "Bearer tok-test");
  assert.deepEqual(cloudflarePreflight(C, lb), []);
});

test("Cloudflare: 설계 조건 위반(쿠키 고정, fallback 이 도착, DNS-only)을 전환 전에 잡는다", () => {
  const bad = { id: "lb1", proxied: false, session_affinity: "cookie", fallback_pool: "pool-tgt", default_pools: ["pool-src"] };
  assert.deepEqual(cloudflarePreflight(C, bad).sort(),
    ["CF_FALLBACK_NOT_SOURCE", "CF_NOT_PROXIED", "CF_POOLS_MISSING", "CF_SESSION_AFFINITY"]);
});

test("Cloudflare: success=false 는 ProviderError, 0.1 단위가 아니면 요청 전에 거부", async () => {
  const f: FetchLike = async () => ({ status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }) });
  const sw = cloudflareLb({ zoneId: "z1", ...C, token: async () => "x", fetch: f });
  await assert.rejects(sw.set("lb1", { source: 1, target: 0 }), (e) => e instanceof ProviderError && e.status === 403);
  await assert.rejects(sw.set("lb1", { source: 0.75, target: 0.25 }), InvalidWeights);
});

test("GCLB: fingerprint 를 실어 PATCH 하고 작업이 DONE 될 때까지 기다린다", async () => {
  const map = { name: "um", fingerprint: "fp1", defaultService: "be-src", defaultRouteAction: undefined as unknown };
  const seen: string[] = [];
  let polls = 0;
  const f: FetchLike = async (url, init) => {
    seen.push(`${init.method} ${url.replace("https://compute.googleapis.com/compute/v1", "")}`);
    if (url.includes("/operations/")) { polls++; return { status: 200, json: async () => ({ status: polls >= 2 ? "DONE" : "RUNNING" }) }; }
    if (init.method === "PATCH") {
      const b = JSON.parse(init.body!);
      assert.equal(b.fingerprint, "fp1");
      map.defaultRouteAction = b.defaultRouteAction; map.fingerprint = "fp2";
      return { status: 200, json: async () => ({ name: "op-1" }) };
    }
    return { status: 200, json: async () => map };
  };
  const sw = gcpGclb({ project: "p1", urlMap: "um", sourceBackend: "be-src", targetBackend: "be-tgt", token: async () => "t", fetch: f, sleep: noSleep });
  assert.deepEqual(await sw.get(""), { source: 1, target: 0 });
  await sw.set("", { source: 0.9, target: 0.1 });
  assert.deepEqual(await sw.get(""), { source: 0.9, target: 0.1 });
  assert.equal(polls, 2);
  assert.ok(seen.includes("PATCH /projects/p1/global/urlMaps/um"));
});

test("ALB: ModifyListener 입력이 SDK 모양 그대로, 고정 세션 끔", async () => {
  const L = "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:listener/app/x/1/2";
  const api = mockAlbApi({ [L]: [{ Type: "forward", ForwardConfig: { TargetGroups: [{ TargetGroupArn: "tg-src", Weight: 100 }] } }] });
  const sw = awsAlb({ sourceTargetGroupArn: "tg-src", targetTargetGroupArn: "tg-tgt", api });
  assert.deepEqual(await sw.get(L), { source: 1, target: 0 });
  await setAndVerify(sw, L, { source: 0.5, target: 0.5 }, { sleep: noSleep });
  const mod = api.calls.find((c) => c.op === "ModifyListener")!.input as { DefaultActions: Array<{ ForwardConfig: { TargetGroups: unknown; TargetGroupStickinessConfig: unknown } }> };
  assert.deepEqual(mod.DefaultActions[0]!.ForwardConfig.TargetGroups, [{ TargetGroupArn: "tg-src", Weight: 50 }, { TargetGroupArn: "tg-tgt", Weight: 50 }]);
  assert.deepEqual(mod.DefaultActions[0]!.ForwardConfig.TargetGroupStickinessConfig, { Enabled: false });
  await assert.rejects(sw.get("arn:none"), ProviderError);
});

test("setAndVerify: 한 번 실패·옛 값 읽기는 다시 시도해서 통과, 계속 실패하면 SwitchFailed", async () => {
  const flaky = mockLb(undefined, { failSets: 1, staleGets: 1 });
  const r = await setAndVerify(flaky, "lb", { source: 0.9, target: 0.1 }, { sleep: noSleep });
  assert.equal(r.attempts, 3);   // 1: set 실패, 2: set 성공 but get 옛 값, 3: 성공
  const dead = mockLb(undefined, { failAllSets: true });
  await assert.rejects(setAndVerify(dead, "lb", { source: 0.9, target: 0.1 }, { sleep: noSleep }),
    (e) => e instanceof SwitchFailed && e.attempts === 3);
});

test("switcherFromEnv: 기본 mock, cloudflare 는 ID 와 토큰 공급자가 없으면 시작 거부", () => {
  assert.equal(switcherFromEnv({}).provider, "mock");
  assert.throws(() => switcherFromEnv({ TRAFFIC_PROVIDER: "cloudflare" }), /CF_ZONE_ID/);
  const cf = { TRAFFIC_PROVIDER: "cloudflare", CF_ZONE_ID: "z", CF_SOURCE_POOL_ID: "a", CF_TARGET_POOL_ID: "b", TRAFFIC_LB_ID: "lb" };
  assert.throws(() => switcherFromEnv(cf), /토큰 공급자/);
  assert.equal(switcherFromEnv(cf, { tokens: () => async () => "t" }).provider, "cloudflare");
});

test("Prometheus: 질의 3줄 × 2쪽, p95 는 초→ms, 이전 번호가 UUID 가 아니면 거부(주입 방지)", async () => {
  const M = "44444444-4444-4444-8444-444444444444", TEN = "11111111-1111-4111-8111-111111111111";
  assert.throws(() => promQueries(TEN, 'x"} or vector(1) #', "target"), /PromQL/);
  assert.throws(() => promQueries('x"} or vector(1) #', M, "target"), /PromQL/);
  assert.match(promQueries(TEN, M, "target").total, new RegExp(`tenant="${TEN}"`), "다른 회사 지표가 판정에 안 섞이게");
  const f: FetchLike = async (url) => {
    const q = decodeURIComponent(url.split("query=")[1]!);
    const v = q.startsWith("histogram_quantile") ? "0.12" : q.includes('code=~"5.."') ? "3" : q.includes('env="target"') ? "150" : "1350";
    return { status: 200, json: async () => ({ status: "success", data: { result: [{ value: [0, v] }] } }) };
  };
  const w = await prometheusMetrics({ baseUrl: "http://prom:9090", tenantId: TEN, fetch: f, baselineP95Ms: 130 }).window(M, 10);
  assert.deepEqual(w.target, { n: 150, err5xx: 3, latenciesMs: [], p95Ms: 120 });
  assert.equal(w.source.n, 1350);
});

// ---- Z14: 공식 API 문서 대조 뒤 고친 것 ----
const M14 = "44444444-4444-4444-8444-444444444444";
const okLb = () => ({ id: "lb1", enabled: true, proxied: true, session_affinity: "none", fallback_pool: "pool-src",
  default_pools: ["pool-src", "pool-tgt"], steering_policy: "random",
  random_steering: { default_weight: 0, pool_weights: { "pool-src": 1, "pool-tgt": 0 } } });

test("Z14-02: steering_policy 가 \"\" 나 off 면 random 이 아니라 default_pools 첫 번째로 본다", () => {
  const base = { id: "lb1", random_steering: { pool_weights: { "pool-src": 0.5, "pool-tgt": 0.5 } } };
  assert.deepEqual(cloudflareWeightsOf(C, { ...base, steering_policy: "", default_pools: ["pool-tgt", "pool-src"] }), { source: 0, target: 1 });
  assert.deepEqual(cloudflareWeightsOf(C, { ...base, steering_policy: "off", default_pools: ["pool-src", "pool-tgt"] }), { source: 1, target: 0 });
  assert.deepEqual(cloudflareWeightsOf(C, { ...base, steering_policy: "random" }), { source: 0.5, target: 0.5 });
});

test("Z14-01: 429·403 은 재시도하지 않고 1번에 멈춘다, 503 은 3번까지", async () => {
  const calls = { n: 0 };
  const status = (code: number): FetchLike => async () => { calls.n++;
    return { status: code, json: async () => ({ success: false, errors: [{ code: 10000 + code, message: "x" }], result: null }) }; };
  for (const [code, attempts] of [[429, 1], [403, 1], [503, 3]] as const) {
    calls.n = 0;
    const sw = cloudflareLb({ zoneId: "z1", ...C, token: async () => "x", fetch: status(code) });
    await assert.rejects(setAndVerify(sw, "lb1", { source: 0.9, target: 0.1 }, { sleep: noSleep }),
      (e) => e instanceof SwitchFailed && e.attempts === attempts);
    assert.equal(calls.n, attempts, `HTTP ${code} 호출 수`);
  }
  const e429 = await cloudflareLb({ zoneId: "z1", ...C, token: async () => "x", fetch: status(429) }).get("lb1").catch((e) => e);
  assert.ok(e429 instanceof ProviderError && !e429.retryable && /속도 제한/.test(e429.message));
});

test("Z14-03: 응답이 없으면 시간 제한으로 끊고 재시도 가능한 ProviderError(status 0)", async () => {
  const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  const sw = cloudflareLb({ zoneId: "z1", ...C, token: async () => "x", fetch: hang, timeoutMs: 30 });
  const t0 = Date.now();
  const e = await sw.get("lb1").catch((x) => x);
  assert.ok(e instanceof ProviderError && e.status === 0 && e.retryable, String(e));
  assert.ok(Date.now() - t0 < 1000);
});

test("Z14-05: zone 이름으로 한 번만 조회하고 기억한다, 오류 메시지에 32자리 ID 를 그대로 안 남긴다", async () => {
  const Z = "0123456789abcdef0123456789abcdef";
  const urls: string[] = [];
  const f: FetchLike = async (url, init) => {
    urls.push(`${init.method} ${url.replace("https://api.cloudflare.com/client/v4", "")}`);
    if (url.includes("/zones?name=")) return { status: 200, json: async () => ({ success: true, result: [{ id: Z, name: "example.com", account: { id: "acc" } }] }) };
    return { status: 404, json: async () => ({ success: false, errors: [{ code: 1002, message: "not found" }], result: null }) };
  };
  const sw = cloudflareLb({ zoneName: "example.com", ...C, token: async () => "x", fetch: f });
  const e1 = await sw.get("lb1").catch((x) => x);
  await sw.get("lb1").catch(() => {});
  assert.equal(urls.filter((u) => u.startsWith("GET /zones?name=")).length, 1);
  assert.equal(urls[1], `GET /zones/${Z}/load_balancers/lb1`);
  assert.ok(e1 instanceof ProviderError && e1.status === 404 && !e1.retryable);
  assert.ok(!e1.message.includes(Z), e1.message);
  assert.throws(() => switcherFromEnv({ TRAFFIC_PROVIDER: "cloudflare", CLOUDFLARE_ZONE_NAME: "example.com", CF_SOURCE_POOL_ID: "a", CF_TARGET_POOL_ID: "b" },
    { tokens: () => async () => "t" }), /TRAFFIC_LB_ID/);
  assert.equal(switcherFromEnv({ TRAFFIC_PROVIDER: "cloudflare", CLOUDFLARE_ZONE_NAME: "example.com", CF_SOURCE_POOL_ID: "a", CF_TARGET_POOL_ID: "b", TRAFFIC_LB_ID: "lb" },
    { tokens: () => async () => "t" }).provider, "cloudflare");
});

test("Z14-06: LB 설정이 조건에 안 맞으면 가중치를 안 건드리고 paused (TRAFFIC_LB_MISCONFIGURED)", async () => {
  const lb = { ...okLb(), session_affinity: "cookie", default_pools: ["pool-src", "pool-tgt", "pool-old"] };
  const { f, reqs } = fakeCloudflare(lb);
  const sw = cloudflareLb({ zoneId: "z1", ...C, token: async () => "x", fetch: f });
  const r = await runShift({ migrationId: M14, lbId: "lb1", switcher: sw, metrics: stubMetrics("clean"), ...fastShift });
  assert.equal(r.outcome, "paused");
  assert.equal(r.failureCode, "TRAFFIC_LB_MISCONFIGURED");
  assert.match(r.rollbackReason ?? "", /CF_SESSION_AFFINITY/);
  assert.doesNotMatch(r.rollbackReason ?? "", /CF_EXTRA_POOLS/);   // 경고는 막지 않는다
  assert.equal(reqs.filter((x) => x.method === "PATCH").length, 0);
});

test("Z14-06: 조건이 맞으면 Cloudflare 가짜로 10→50→100 끝까지 간다 (PATCH 3번)", async () => {
  const { f, reqs } = fakeCloudflare(okLb());
  const sw = cloudflareLb({ zoneId: "z1", ...C, token: async () => "x", fetch: f });
  const r = await runShift({ migrationId: M14, lbId: "lb1", switcher: sw, metrics: stubMetrics("clean"), ...fastShift });
  assert.equal(r.outcome, "reached_100");
  assert.deepEqual(r.finalWeights, { source: 0, target: 1 });
  assert.equal(reqs.filter((x) => x.method === "PATCH").length, 3);
});
