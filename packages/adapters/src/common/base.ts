import type { EnvironmentAdapter, ModuleRef, Provider } from "@svc/contracts";
import { DEMO_INVENTORY } from "./fixtures.js";
import { boundedName } from "./names.js";
import { mockSeed } from "./cli.js";
import { discoverSource } from "../discover/index.js";
import { envFor } from "../verify/aws.js";
import { MODULE_DIGEST } from "../module-digests.js";
import { digestOf, nameSeed, repoName, tenantOf, type Target } from "./target.js";

// 네 어댑터(aws·gcp·onprem·azure_mock)가 똑같이 쓰던 조각 (Z44). 모양·값은 예전 각 파일과 같다

/** 이름 규칙이 보는 것은 앱 이름뿐 */
export type AppName = { app: { name: string } };
// DRAFT(ai): 권한표가 보는 "기본 앱 모양" (예전 v1 명세의 서비스 1개 + 비밀 + DB). 실행 역할 천장·세션 정책 파일(export-permissions)이 이 모양으로 뽑힌다.
//   명세별 실제 권한은 도착 Builder 의 operateActionsV2 가 센다
export interface PermNeeds { secrets: boolean; database: boolean }

// 가져오기 읽기.
// Z88: discover 는 진짜 읽기(discover/index.ts — aws·gcloud·kubectl 읽기 명령). 못 읽으면 가짜 값 없이 SOURCE_UNAVAILABLE.
//   데모 원본(DEMO_INVENTORY)은 MOCK_SEED=1(시험·e2e 전용)일 때만 돌려준다
export function sourceImport(p: Provider): Pick<EnvironmentAdapter, "discover"> {
  return {
    // L5: 세션에 빌린 자격(cliEnv)이 있으면 그 env 로만 읽는다 (워커 프로필·키 지움). 없으면 지금처럼 프로세스 자격
    discover: async (sess) => (mockSeed() ? DEMO_INVENTORY[p] : discoverSource(p, sess?.cliEnv ? { env: envFor(sess.cliEnv) } : {})),
  };
}

// 도착 클러스터 안 앱 네임스페이스 (Terraform app 모듈·Helm 차트·Argo CD AppProject 가 같은 규칙)
// DECISION(team): 도착 네임스페이스는 이 규칙(app-<앱>) 유지, M-1(출발 이름)은 안 붙임 (FM-IR-03, Jeong 2026-11-04 01:39Z. target/shared.ts targetNamespace 주석)
export const appNamespace = (spec: AppName) => `app-${spec.app.name}`;

// 플랫폼 레지스트리 안 이미지 주소: <host>/platform/<tenant>/<repo>@sha256:… (태그 없음, digest 그대로)
// FM-APP-01 (지휘 결정 11/4 00:51Z, "그대로 이식"): 도착에서 받을 수 있는 공개 레지스트리 이미지는 출발 주소@digest 그대로 쓴다.
//   예전엔 늘 도착 플랫폼 저장소(<host>/platform/<회사>/<이름>)로 바꿨는데, 그 저장소로 복사하는 단계가 없어 파드가 ImagePullBackOff 였다.
//   사설 레지스트리(ECR·Artifact Registry·ACR·모르는 호스트)는 플랫폼 저장소 주소 그대로 → AWS·GCP 도착은 deploy 의 이미지 복사(worker jobs/image-copy.ts)가
//   GitOps 커밋 직전에 이 주소를 다이제스트 그대로 채운다 (ECR·AR 원본만. 모르는 호스트는 IMAGE_COPY_FAILED 로 멈춤). 온프레·Azure 도착은 아직 채우는 단계가 없다.
// DRAFT(ai): 공개로 보는 호스트 목록. 이 호스트에도 비공개 저장소가 있을 수 있다(Docker Hub 비공개 등) → 그때는 pull 실패가 Argo Degraded 로 보이고 deploy 가 paused
export const PUBLIC_REGISTRIES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io", "ghcr.io", "quay.io", "registry.k8s.io", "public.ecr.aws", "mcr.microsoft.com"]);
/** 이미지 주소의 레지스트리 호스트. 첫 칸이 점·콜론이 있는 이름이나 localhost 가 아니면 Docker Hub (docker 규칙) */
export function registryOf(src: string): string {
  const name = src.split("@")[0]!;
  const first = name.split("/")[0]!;
  const hasHost = name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return hasHost ? first.toLowerCase() : "docker.io";
}
export const isPublicImage = (src: string) => PUBLIC_REGISTRIES.has(registryOf(src));
export const platformImageRef = (host: string, t: Target, src: string) =>
  isPublicImage(src) ? `${src.split("@")[0]!}@${digestOf(src)}`
    : `${host}/platform/${tenantOf(t)}/${repoName(src)}@${digestOf(src)}`;

// infra 모듈 위치 + 판. 판은 Target.moduleSha(git sha), 없으면 모듈 내용 지문
export const moduleRefOf = (key: keyof typeof MODULE_DIGEST, t: Target): ModuleRef =>
  ({ path: `infra/modules/${key}`, gitSha: t.moduleSha ?? MODULE_DIGEST[key] });

// DB 인스턴스 이름: 이전(migration)마다 다른 해시 (Cloud SQL 은 삭제 뒤 1주 같은 이름 재사용 불가)
export const dbInstanceName = (spec: AppName, t: Target, max: number) =>
  boundedName({ app: spec.app.name, seed: [nameSeed(t), spec.app.name, t.migrationId ?? t.envId], max, sep: "-pg-" });
