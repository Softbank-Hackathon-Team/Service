import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImageBuildJob, ImageBuildResult, JOB_SCHEMAS, QUEUES } from "@svc/contracts";
import { POLICY } from "@svc/core";
import { buildImage, handleImageBuild, pendingBuilds, runImageBuilds } from "../src/jobs/image-build.js";
import { HANDLERS } from "../src/jobs/index.js";

const ids = { tenantId: "11111111-1111-4111-8111-111111111111", requestId: "r1",
  migrationId: "4a8c0000-0000-4000-8000-000000000001", planId: "7f000000-0000-4000-8000-000000000001" };
const build = { repo: "github.com/acme/shop", commit: "abc123", path: ".", method: "buildpacks" as const, evidence: ["package.json"] };
const job = { ...ids, serviceId: "shop-web", build };

function specWith(source: "build" | "registry") {
  return {
    schemaVersion: "2", app: { name: "shop" },
    components: [{ id: "shop-web", kind: "service", props: {
      runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
      image: source === "build" ? { source, repository: "shop-web", digest: null, build }
        : { source, repository: "ghcr.io/demo/shop-web", digest: "sha256:" + "b".repeat(64) },
      resources: {}, ports: [{ port: 3000 }], serviceAccount: "default",
      replicas: { min: 1, max: 1 }, env: [],
    } }],
    links: [],
    posture: { permissions: [], network: [] },
  };
}

test("정상: 빌드 작업 → digest 반환(계약 통과), 같은 입력이면 같은 digest", async () => {
  const a = await handleImageBuild(job);
  assert.equal(ImageBuildResult.safeParse(a).success, true);
  assert.match(a.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.serviceId, "shop-web");
  assert.equal((await buildImage(ImageBuildJob.parse(job))).digest, a.digest);
  const b = await handleImageBuild({ ...job, build: { ...build, commit: "def456" } });
  assert.notEqual(a.digest, b.digest);
});

test("큐 계약: image-build 큐·작업 스키마·재시도 없음·처리기 등록", () => {
  assert.equal(QUEUES.imageBuild, "image-build");
  assert.ok("image-build" in JOB_SCHEMAS);
  assert.equal(POLICY[QUEUES.imageBuild]?.retryLimit, 0);
  assert.equal(typeof HANDLERS[QUEUES.imageBuild], "function");
});

test("거부: BuildPlan 모양이 틀리면 parse 실패(던짐)", async () => {
  await assert.rejects(() => handleImageBuild({ ...job, build: { ...build, method: "make" } }));
  await assert.rejects(() => handleImageBuild({ ...job, build: { repo: "x" } }));
  await assert.rejects(() => handleImageBuild({ ...job, build: { ...build, extra: 1 } }));   // strict
  await assert.rejects(() => handleImageBuild({ ...job, serviceId: "" }));
});

test("apply 앞 호출 자리: 깃발 off·명세 없음이면 빈 목록, 깃발 on 이면 build 서비스만", async () => {
  const on = { IMAGE_BUILD: "1" } as NodeJS.ProcessEnv;
  assert.deepEqual(await runImageBuilds(ids, specWith("build"), {} as NodeJS.ProcessEnv), []);   // 깃발 off
  assert.deepEqual(await runImageBuilds(ids, null, on), []);                                      // v2 저장 전
  assert.deepEqual(await runImageBuilds(ids, specWith("registry"), on), []);                      // registry 는 빌드 안 함
  const r = await runImageBuilds(ids, specWith("build"), on);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.serviceId, "shop-web");
  assert.equal(pendingBuilds(AppSpecV2.parse(specWith("build"))).length, 1);
});
