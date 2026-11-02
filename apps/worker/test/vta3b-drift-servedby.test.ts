// VTA3b: PLAN_IR=v2 배포 drift·SERVED_BY 경계 (DB 없음). 가짜 GitOps 레포·watcher 로 deployToGitops 를 끝까지 돌린다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, ComponentV2, upconvertV1, type HelmValues } from "@svc/contracts";
import {
  adapterFor, AdapterError, DEMO_INVENTORY, resolveSpecV2, STUB_TF_OUTPUTS, specV2OrThrow, stubTfOutputsV2, v2PrecheckItems,
} from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { bundleRefOf, deployToGitops, GitopsError, servedByName, type DeployInput, type GitopsRepo, type SyncWatcher } from "../src/gitops/index.js";

const ENV_ID = "33333333-3333-4333-8333-333333333333";
const MID = "4a8c0000-0000-4000-8000-0000000000f3";
const TENANT = "11111111-1111-4111-8111-111111111111";
const spec = AppSpec.parse(adapterFor("aws").normalize(DEMO_INVENTORY.aws).spec);
const v2 = upconvertV1(spec).spec;
const pgId = v2.components.find((c) => c.kind === "postgres")!.id;
const now = new Date("2026-11-07T00:00:00Z");
const base = { planId: "7f000000-0000-4000-8000-0000000000f3", migrationId: MID, spec, precheck: stubPrecheck(), now };
const target = { envId: ENV_ID, provider: "gcp" as const, region: "default", accountId: "demo-project" };
const planV2 = (s: AppSpecV2 = v2) => buildPlanDoc({ ...base, target: { envId: ENV_ID, provider: "gcp", region: "default" }, specV2: { spec: s, source: "spec_v2" } }, {});
const planV1 = () => buildPlanDoc({ ...base, target: { envId: ENV_ID, provider: "gcp", region: "default" } }, {});

// 가짜 레포: 커밋한 값만 모은다
function fakeRepo() {
  const commits: HelmValues[] = [];
  const repo = {
    chartVersion: async () => "0.1.0",
    commitBundle: async (_k: string, _b: unknown, values: HelmValues) => {
      commits.push(structuredClone(values));
      return { commit: `c${commits.length}`, bundleSha256: "sha", resources: ["Deployment/x"], changed: true };
    },
  } as unknown as GitopsRepo;
  return { repo, commits };
}
const okWatcher: SyncWatcher = { wait: async () => ({ ok: true }) };
const input = (over: Partial<DeployInput> = {}): DeployInput =>
  ({ tenantId: TENANT, spec, plan: planV2(), target, tfOutputs: { ...STUB_TF_OUTPUTS, ...stubTfOutputsV2(v2) }, specV2: v2, ...over });
type W = { id: string; kind: string; env?: Array<{ name: string; value?: string }> };

test("SERVED_BY(v2): 커밋 값의 서비스 워크로드마다 한 번, 값 = servedByName, 최상위 env 없음", async () => {
  const f = fakeRepo();
  const i = input();
  await deployToGitops(f.repo, i, okWatcher);
  const v = f.commits[0]!;
  const want = servedByName(bundleRefOf(i));
  assert.equal("env" in v, false);
  for (const w of v.workloads as W[]) {
    const sb = (w.env ?? []).filter((e) => e.name === "SERVED_BY");
    assert.deepEqual(sb, w.kind === "service" ? [{ name: "SERVED_BY", value: want }] : [], w.id);
  }
  assert.match(want, /^gcp-/);
});

test("결정적: 같은 입력으로 두 번 배포하면 커밋 값이 같다 (v1·v2 각각)", async () => {
  for (const mk of [() => input(), () => input({ plan: planV1(), specV2: null, tfOutputs: { ...STUB_TF_OUTPUTS } })]) {
    const f = fakeRepo();
    await deployToGitops(f.repo, mk(), okWatcher);
    await deployToGitops(f.repo, mk(), okWatcher);
    assert.equal(f.commits.length, 2);
    assert.deepEqual(f.commits[0], f.commits[1]);
  }
});

test("SERVED_BY(v1): v1 계획서면 예전처럼 최상위 env 한 줄 (workloads 없음)", async () => {
  const f = fakeRepo();
  const i = input({ plan: planV1(), specV2: null, tfOutputs: { ...STUB_TF_OUTPUTS } });
  await deployToGitops(f.repo, i, okWatcher);
  const v = f.commits[0]!;
  assert.equal(Array.isArray(v.workloads), false);
  assert.deepEqual((v.env as Array<{ name: string }>).filter((e) => e.name === "SERVED_BY").length, 1);
});

test("거부: v2 계획서인데 v2 명세가 사라짐(null) → GITOPS_VALUES_DRIFT, 커밋 0", async () => {
  const f = fakeRepo();
  await assert.rejects(deployToGitops(f.repo, input({ specV2: null }), okWatcher),
    (e: unknown) => e instanceof GitopsError && e.code === "GITOPS_VALUES_DRIFT");
  assert.equal(f.commits.length, 0);
});

test("거부: 승인 뒤 v2 명세 내용이 바뀜(서비스 env 한 줄) → GITOPS_VALUES_DRIFT, 커밋 0", async () => {
  const f = fakeRepo();
  const changed = AppSpecV2.parse({ ...v2, components: v2.components.map((c) => c.kind === "service"
    ? { ...c, props: { ...c.props, env: [...(c.props.env ?? []), { name: "NEW_FLAG", value: "1" }] } } : c) });
  await assert.rejects(deployToGitops(f.repo, input({ specV2: changed }), okWatcher),
    (e: unknown) => e instanceof GitopsError && e.code === "GITOPS_VALUES_DRIFT");
  assert.equal(f.commits.length, 0);
});

test("자리표시: v2 link 출력이 없으면 GITOPS_PLACEHOLDER_MISSING(link.<postgres>), 맵 출력(link_outputs)만 줘도 펼쳐서 채운다", async () => {
  const f = fakeRepo();
  let missing: unknown;
  try { await deployToGitops(f.repo, input({ tfOutputs: { ...STUB_TF_OUTPUTS } }), okWatcher); } catch (e) { missing = e; }
  {
    assert.ok(missing instanceof GitopsError && missing.code === "GITOPS_PLACEHOLDER_MISSING", String(missing));
    assert.match((missing as Error).message, new RegExp(`link\\.${pgId}\\.`));
    // 같은 값을 맵 하나로 주면(진짜 terraform 모양) 통과
    const s = stubTfOutputsV2(v2);
    const map: Record<string, Record<string, string>> = {};
    const flat: Record<string, string> = {};
    for (const [k, val] of Object.entries(s)) {
      const m = /^link\.([^.]+)\.(.+)$/.exec(k);
      if (m) (map[m[1]!] ??= {})[m[2]!] = val as string; else flat[k] = val as string;
    }
    await deployToGitops(f.repo, input({ tfOutputs: { ...STUB_TF_OUTPUTS, ...flat, link_outputs: JSON.stringify(map) } }), okWatcher);
    assert.equal(f.commits.length, 1);
  }
});

test("v1/v2 섞인 판: 사람 편집(spec_v2 없음) 뒤 다시 가져와 spec_v2 가 생긴 판은 spec_v2 로, 지문 결정적", () => {
  const r = resolveSpecV2({ spec, specV2: v2, hadV2Before: true });
  assert.equal(r.ok && r.source, "spec_v2");
  const s = specV2OrThrow({ spec, specV2: v2, hadV2Before: true });
  const a = buildPlanDoc({ ...base, target: { envId: ENV_ID, provider: "gcp", region: "default" }, specV2: s }, {});
  const b = buildPlanDoc({ ...base, target: { envId: ENV_ID, provider: "gcp", region: "default" }, specV2: specV2OrThrow({ spec, specV2: v2, hadV2Before: true }) }, {});
  assert.equal(a.planHash, b.planHash);
  // upconvert 판과 spec_v2 판은 출처가 달라 지문도 다르다 (같은 명세 내용이어도 specSource 가 지문에 들어감)
  const c = buildPlanDoc({ ...base, target: { envId: ENV_ID, provider: "gcp", region: "default" }, specV2: { spec: v2, source: "upconvert" } }, {});
  assert.notEqual(a.planHash, c.planHash);
});

// ── VTA3 설계 어긋남: 지금 동작만 고정 (고치면 이 시험을 바꿀 것) ──
test("고정(VTA3 어긋남 1): 흉내 출력은 postgres·identity·데이터 자원(TA12b: cache link 출력 있음), memcached 는 capability 에서 먼저 막힘", () => {
  const withCache = AppSpecV2.parse({ ...v2, components: [...v2.components,
    ComponentV2.parse({ id: "sessions", kind: "cache", props: { engine: "memcached", memoryMiB: 512, tls: true, auth: true } })] });   // TA12: redis·valkey 는 이제 aws·gcp 가 그림 → 모듈이 못 만드는 memcached 로 거부 경로 유지
  assert.equal(Object.keys(stubTfOutputsV2(withCache)).some((k) => k.startsWith("link.sessions.")), true);   // TA12b: 데이터 자원 가짜 출력 추가
  assert.throws(() => planV2(withCache), (e: unknown) => e instanceof AdapterError && e.code === "UNSUPPORTED_V2");
});

test("고정(VTA3 어긋남 2): 앞 판엔 spec_v2 가 있었는데 없으면 사전 점검 block 과 계획 NEEDS_HUMAN 둘 다", () => {
  const row = { spec, specV2: null, hadV2Before: true };
  assert.deepEqual(v2PrecheckItems("gcp", row).map((i) => [i.id, i.level]), [["PC-V2-HUMAN", "block"]]);
  assert.throws(() => specV2OrThrow(row), (e: unknown) => e instanceof AdapterError && e.code === "NEEDS_HUMAN");
});
