// 검증 묶음 VPA9: image-build 추가 시험 (경계·거부·큐 키 충돌 기록)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, QUEUES } from "@svc/contracts";
import { jobKey, parseJobData } from "@svc/core";
import { buildImage, handleImageBuild, pendingBuilds, runImageBuilds } from "../src/jobs/image-build.js";

const ids = { tenantId: "11111111-1111-4111-8111-111111111111", requestId: "r1",
  migrationId: "4a8c0000-0000-4000-8000-000000000001", planId: "7f000000-0000-4000-8000-000000000001" };
const plan = (o: Record<string, unknown> = {}) => ({ repo: "github.com/acme/shop", commit: "abc123", path: ".", method: "buildpacks", evidence: ["package.json"], ...o });
const svc = (id: string, image: unknown, kind = "service") => kind === "service"
  ? { id, kind, props: { runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop", image, resources: {}, ports: [{ port: 3000 }],
      serviceAccount: "default", replicas: { min: 1, max: 1 }, env: [] } }
  : { id, kind, props: { image, resources: {}, env: [], serviceAccount: "default", schedule: "0 3 * * *" } };
const spec = (...components: unknown[]) => ({ schemaVersion: "2", app: { name: "shop" }, components, links: [], posture: { permissions: [], network: [] } });
const reg = { source: "registry", repository: "ghcr.io/demo/x", digest: "sha256:" + "a".repeat(64) };
const bld = (o = {}) => ({ source: "build", repository: "x", digest: null, build: plan(o) });
const on = { IMAGE_BUILD: "1" } as NodeJS.ProcessEnv;

test("서비스 여러 개 + registry 섞임: build 인 것만, 서비스 순서대로", async () => {
  const s = spec(svc("a", bld()), svc("b", reg), svc("c", bld({ commit: "def" })));
  const r = await runImageBuilds(ids, s, on);
  assert.deepEqual(r.map((x) => x.serviceId), ["a", "c"]);
  assert.notEqual(r[0]!.digest, r[1]!.digest);
});

test("job 컴포넌트의 build 이미지도 빌드한다", async () => {
  const s = spec(svc("web", reg), svc("nightly", bld(), "job"));
  assert.deepEqual(pendingBuilds(AppSpecV2.parse(s)).map((x) => x.serviceId), ["nightly"]);
  assert.equal((await runImageBuilds(ids, s, on)).length, 1);
});

test("거부: source=build 인데 build 계획이 없으면 조용히 건너뛰지 않고 던진다", async () => {
  const s = spec(svc("a", { source: "build", repository: "x", digest: null }));
  await assert.rejects(() => runImageBuilds(ids, s, on));
  // 깃발 off 면 건드리지 않음
  assert.deepEqual(await runImageBuilds(ids, s, {} as NodeJS.ProcessEnv), []);
});

test("거부: 모양이 틀린 명세 v2 는 던진다(깃발 on), 깃발 값 1 이외는 off", async () => {
  await assert.rejects(() => runImageBuilds(ids, { schemaVersion: "1" }, on));
  for (const v of ["0", "true", "", "on", " 1"]) assert.deepEqual(await runImageBuilds(ids, spec(svc("a", bld())), { IMAGE_BUILD: v } as NodeJS.ProcessEnv), [], v);
});

test("작업 계약: planId·serviceId 필수, 알 수 없는 키 거부, build 계획 안의 필드 검사", async () => {
  const ok = { ...ids, serviceId: "a", build: plan() };
  assert.ok((await handleImageBuild(ok)).digest.startsWith("sha256:"));
  const { planId: _p, ...noPlan } = ok; void _p;
  await assert.rejects(() => handleImageBuild(noPlan));
  await assert.rejects(() => handleImageBuild({ ...ok, extra: 1 }));
  await assert.rejects(() => handleImageBuild({ ...ok, build: plan({ port: 70000 }) }));
  await assert.rejects(() => handleImageBuild({ ...ok, build: plan({ evidence: new Array(51).fill("f") }) }));
  assert.throws(() => parseJobData(QUEUES.imageBuild, { ...ok, build: undefined }));
});

test("digest: 입력(repo·commit·path·method·builder)이 바뀌면 바뀌고, serviceId 만 다르면 같다", async () => {
  const base = { ...ids, serviceId: "a", build: plan() } as never;
  const d0 = (await buildImage(base)).digest;
  for (const o of [{ repo: "github.com/acme/other" }, { commit: "zzz" }, { path: "api" }, { method: "dockerfile" }, { builder: "paketo@sha256:1" }])
    assert.notEqual((await buildImage({ ...(base as object), build: plan(o) } as never)).digest, d0, JSON.stringify(o));
  assert.equal((await buildImage({ ...(base as object), serviceId: "b" } as never)).digest, d0);
});

test("기록(설계 확인 필요): 기본 작업 키는 image-build:<이전> 하나뿐 → 서비스별로 여러 작업을 advance(next)로 넣으면 키가 겹친다", () => {
  assert.equal(jobKey(QUEUES.imageBuild, { migrationId: ids.migrationId }), `image-build:${ids.migrationId}`);
  assert.equal(jobKey(QUEUES.imageBuild, { migrationId: ids.migrationId }), jobKey(QUEUES.imageBuild, { migrationId: ids.migrationId, envId: "x" }));
});
