// gitops 레포(Softbank-Hackathon-Team/gitops) 경로 규칙의 고정 거울 (#373 D4, 시험 전용).
//   Service CI 는 비공개 gitops 레포를 읽을 토큰이 없다 → 검사기의 경로 규칙을 여기 베껴 두고, worker 가 실제로 쓴 경로를 대조한다
//   (gitops-path-contract.test.ts). gitops 레포 체크아웃을 GITOPS_FIXTURE_DIR 로 주면 같은 시험이 진짜 검사기로도 돈다.
//
// 기준: gitops 레포 main be845bb (2026-11-07, PR #13 "고객 EKS 접속 정보를 회사 폴더에 둘 수 있게 함" 머지 뒤)
//
// ★ 아래 gitops 레포 파일을 바꾸면 같은 변경 묶음에서 이 파일도 고친다 (반대 방향도 같다):
//   - tools/validate.mjs   CLUSTER_SECRET_FILES + 울타리 폴더(tenants/<회사>/argocd/) 파일 검사 고리  → ARGOCD_FILES
//   - tools/lib.mjs        ENVS · ONPREM_SITE_DIR (묶음 폴더 이름 → 환경)                          → BUNDLE_ENV_DIRS · ONPREM_SITE_DIR
//   - tools/path-guard.mjs BOT_ONLY (봇 = worker 가 쓸 수 있는 경로)                                → PATH_GUARD_BOT_ONLY
// ★ worker 가 새 경로를 쓰게 되면 순서가 있다: gitops 레포 검사기(위 파일)를 먼저 고쳐 머지 → 그다음 이 거울을 고친다.
//   거꾸로 하면 실이전이 GITOPS_VALIDATE_FAILED 로 멈춘다 (2026-11-07 온프레→AWS, cluster-aws-eks.yaml, 11분 20초 멈춤)

/** tools/validate.mjs: 울타리 폴더(허브 argocd 구역에 바로 들어감)에 둘 수 있는 파일. 밖이면 "이 폴더에 둘 수 없는 파일이다" */
export const ARGOCD_FILES: readonly string[] = ["appproject.yaml", "cluster-gcp-gke.yaml", "cluster-aws-eks.yaml"];
/** PR #13 전 validate.mjs (거부 시험용: 이 거울이 그때 있었으면 #302 의 cluster-aws-eks.yaml 을 CI 에서 잡았는지) */
export const ARGOCD_FILES_BEFORE_PR13: readonly string[] = ["appproject.yaml", "cluster-gcp-gke.yaml"];

/** tools/lib.mjs ENVS: 묶음 폴더 이름(온프레 환경별 폴더는 ONPREM_SITE_DIR)이 이 중 하나여야 한다. 밖이면 "모르는 환경 이름" */
export const BUNDLE_ENV_DIRS: readonly string[] = ["aws-eks", "gcp-gke", "onprem-k3s", "azure-mock"];
export const ONPREM_SITE_DIR = /^onprem-k3s-[0-9a-f]{8}$/;
/** tools/validate.mjs: 묶음 폴더마다 있어야 하는 파일 (manifests/ 는 render.mjs 가 채운다) */
export const BUNDLE_REQUIRED = ["values.yaml", "plan.json", "bundle.sha256"] as const;

/** tools/path-guard.mjs BOT_ONLY 를 글자 그대로 (be845bb). PR #13 이 validate.mjs 만 고치고 여기는 안 고쳤다 → PATH_GUARD_KNOWN_GAPS */
export const PATH_GUARD_BOT_ONLY = /^tenants\/t-[0-9a-f]{8}\/(argocd\/(appproject|cluster-gcp-gke)\.yaml|apps\/[a-z0-9]([-a-z0-9]*[a-z0-9])?\/(aws-eks|gcp-gke|onprem-k3s(-[0-9a-f]{8})?|azure-mock)\/(values\.yaml|plan\.json|bundle\.sha256|manifests\/[a-z0-9.-]+\.yaml))$/;
/** worker 가 쓰는데 path-guard 가 아직 모르는 파일 (경로 꼬리). path-guard 는 지금 gitops 레포 어느 CI 에도 안 걸려 있어 실이전은 안 막는다.
 *  gitops 레포 tools/path-guard.mjs BOT_ONLY 에 cluster-aws-eks 가 들어가면 위 정규식을 새로 베끼고 이 목록을 비운다
 *  (시험이 "목록 = 실제로 걸린 것" 을 정확히 보므로, 고친 뒤 안 비우면 진짜 검사기 길에서 빨간불)
 *  DRAFT(ai): 빈틈을 빨간불이 아니라 "알려진 빈틈" 으로 둔다. 실이전을 막는 건 validate.mjs 이고, path-guard 는 이 레포에서 고칠 수 없다 */
export const PATH_GUARD_KNOWN_GAPS: readonly string[] = ["/argocd/cluster-aws-eks.yaml"];

export interface PathRules { argocdFiles: readonly string[]; envDirs: readonly string[] }
export const PINNED: PathRules = { argocdFiles: ARGOCD_FILES, envDirs: BUNDLE_ENV_DIRS };

const envOfDir = (dir: string) => (ONPREM_SITE_DIR.test(dir) ? "onprem-k3s" : dir);

/** validate.mjs 가 이 경로를 막는 이유 (막지 않으면 null). worker 가 쓰는 tenants/ 아래만 본다.
 *  validate.mjs 는 tenants/<회사>/argocd/ 의 파일과 tenants/<회사>/apps/<앱>/<폴더>/ 의 폴더 이름을 본다. 그 밖(tenants/ 밖 포함)은 worker 가 쓰면 안 되는 자리 */
export function validateRejects(path: string, rules: PathRules = PINNED): string | null {
  const p = path.split("/");
  if (p[0] !== "tenants" || !p[1]) return "tenants/<회사>/ 밖은 worker 가 쓰지 않는다 (WORKER-CONTRACT 1절)";
  if (p[2] === "argocd") {
    return p.length === 4 && rules.argocdFiles.includes(p[3]!) ? null : "이 폴더에 둘 수 없는 파일이다 (validate.mjs 울타리 폴더 검사)";
  }
  if (p[2] === "apps" && p.length >= 6) {
    return rules.envDirs.includes(envOfDir(p[4]!)) ? null : `모르는 환경 이름: ${p[4]} (validate.mjs · lib.mjs ENVS)`;
  }
  return "회사 폴더 안에서 argocd/ 와 apps/<앱>/<환경>/ 밖은 검사기가 모르는 자리다";
}
