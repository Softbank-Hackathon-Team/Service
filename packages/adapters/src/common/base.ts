import type { AppSpec, EnvironmentAdapter, ModuleRef, Provider } from "@svc/contracts";
import { DEMO_INVENTORY, DEMO_SPEC } from "./fixtures.js";
import { boundedName } from "./names.js";
import { mockSeed } from "./cli.js";
import { discoverSource } from "../discover/index.js";
import { normalizeInventory } from "./normalize.js";
import { MODULE_DIGEST } from "../module-digests.js";
import { digestOf, nameSeed, repoName, tenantOf, type Target } from "./target.js";

// 네 어댑터(aws·gcp·onprem·azure_mock)가 똑같이 쓰던 조각 (Z44). 모양·값은 예전 각 파일과 같다

// 가져오기 두 함수. normalize 는 공통 순수 함수.
// Z88: discover 는 진짜 읽기(discover/index.ts — aws·gcloud·kubectl 읽기 명령). 못 읽으면 가짜 값 없이 SOURCE_UNAVAILABLE.
//   데모 원본(DEMO_INVENTORY)은 MOCK_SEED=1(시험·e2e 전용)일 때만 돌려준다
export function sourceImport(p: Provider): Pick<EnvironmentAdapter, "discover" | "normalize"> {
  return {
    discover: async () => (mockSeed() ? DEMO_INVENTORY[p] : discoverSource(p)),
    normalize: (raw) => normalizeInventory(raw, DEMO_SPEC),
  };
}

// 도착 클러스터 안 앱 네임스페이스 (Terraform app 모듈·Helm 차트·Argo CD AppProject 가 같은 규칙)
export const appNamespace = (spec: AppSpec) => `app-${spec.app.name}`;

// 플랫폼 레지스트리 안 이미지 주소: <host>/platform/<tenant>/<repo>@sha256:… (태그 없음, digest 그대로)
export const platformImageRef = (host: string, t: Target, src: string) =>
  `${host}/platform/${tenantOf(t)}/${repoName(src)}@${digestOf(src)}`;

// infra 모듈 위치 + 판. 판은 Target.moduleSha(git sha), 없으면 모듈 내용 지문
export const moduleRefOf = (key: keyof typeof MODULE_DIGEST, t: Target): ModuleRef =>
  ({ path: `infra/modules/${key}`, gitSha: t.moduleSha ?? MODULE_DIGEST[key] });

// DB 인스턴스 이름: 이전(migration)마다 다른 해시 (Cloud SQL 은 삭제 뒤 1주 같은 이름 재사용 불가)
export const dbInstanceName = (spec: AppSpec, t: Target, max: number) =>
  boundedName({ app: spec.app.name, seed: [nameSeed(t), spec.app.name, t.migrationId ?? t.envId], max, sep: "-pg-" });
