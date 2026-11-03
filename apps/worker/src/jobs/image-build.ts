import { createHash } from "node:crypto";
import { AppSpecV2, ImageBuildJob, ImageBuildResult, type BuildPlan } from "@svc/contracts";

// 이미지 빌드 (설계 23번 3.3). 이미지 없는 출발(VM·소스)의 서비스를 도착에서 빌드해 digest 를 얻는다.
// 상태 표(22개)는 안 바뀐다: 새 상태 없이 provisioning 안에서 apply 앞에 부른다. 큐 `image-build` 는 계약(jobs.ts)에 둔다.
// 이 파일 = 작업 처리기(큐로 들어온 작업) + 부르는 쪽 도우미(runImageBuilds, apply.ts 가 직접 부름). 둘 다 buildImage 하나를 쓴다.

/** 깃발. 기본 off = 지금 동작 그대로 (명세 v2 저장 전) */
export const imageBuildEnabled = (env: NodeJS.ProcessEnv = process.env) => env.IMAGE_BUILD === "1";

/** 빌드가 필요한 워크로드: image.source=build 인 service·job 컴포넌트. build 계획이 없으면 던진다(조용히 건너뛰면 digest 없이 배포됨; checkV2 가 먼저 막지만 여기서도 확인)
 *  STUB: 사이드카·initContainer 의 image.source=build 는 아직 안 봄(출발 VM·소스에는 보통 없음) */
export function pendingBuilds(spec: AppSpecV2): Array<{ serviceId: string; build: BuildPlan }> {
  const out: Array<{ serviceId: string; build: BuildPlan }> = [];
  for (const c of spec.components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    const img = c.props.image;
    if (img.source !== "build") continue;
    if (!img.build) throw new Error(`${c.id}: image.source=build 인데 build 계획 없음`);
    out.push({ serviceId: c.id, build: img.build });
  }
  return out;
}

// STUB: 실제 빌드(Dockerfile / Buildpacks, 격리된 빌드 환경, 출발 환경변수·비밀 없이 — 20번 5.7장) 대신 고정 digest.
//   같은 입력(repo·commit·path·method·builder)이면 같은 digest. 진짜 구현도 같은 계약(ImageBuildResult)을 돌려준다
// TODO(human): 빌드 실행 장소(샌드박스 vCluster vs 별도 빌더)·결과 이미지를 올릴 도착 레지스트리
export async function buildImage(job: ImageBuildJob): Promise<ImageBuildResult> {
  const b = job.build;
  const digest = "sha256:" + createHash("sha256")
    .update(JSON.stringify([b.repo, b.commit, b.path, b.method, b.builder ?? null])).digest("hex");
  return ImageBuildResult.parse({ serviceId: job.serviceId, digest,
    builtFrom: { repo: b.repo, commit: b.commit, method: b.method } });
}

/** 큐 처리기. 작업 내용을 parse (틀리면 던짐 → image-build 큐는 retryLimit 0 이라 재시도 없이 실패) */
export async function handleImageBuild(raw: unknown): Promise<ImageBuildResult> {
  return buildImage(ImageBuildJob.parse(raw));
}

/** apply 앞 호출 자리. 깃발 off 이거나 명세 v2 가 없으면 빈 목록. 하나라도 실패하면 던진다(→ apply 가 failed) */
export async function runImageBuilds(
  base: { tenantId: string; requestId: string; migrationId: string; planId: string },
  specV2: unknown | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ImageBuildResult[]> {
  if (!imageBuildEnabled(env) || !specV2) return [];
  const spec = AppSpecV2.parse(specV2);
  const results: ImageBuildResult[] = [];
  for (const p of pendingBuilds(spec)) results.push(await handleImageBuild({ tenantId: base.tenantId, requestId: base.requestId,
    migrationId: base.migrationId, planId: base.planId, ...p }));
  return results;
}
