// Z103: Z94 반영 확인 코드(argo-watch.ts)를 진짜 Argo CD Application CR 에 대고 한 번 돌린다.
// 워커가 쓰는 것과 같은 argoWatcherFromEnv 를 부른다. 흉내 없음 (MOCK_ARGO 를 지운다).
// 사용 (Service 폴더에서):
//   node --import tsx tools/argo-probe.ts --tenant t-11111111 --app shop --commit <sha> --wait 120 --expect ok
//   --expect: ok | ARGO_TIMEOUT | ARGO_APP_MISSING | ARGO_DEGRADED | ARGO_SYNC_FAILED | ARGO_AUTH_FAILED | ARGO_UNREACHABLE
// 출력: JSON 한 줄 {case, expect, got, pass, ms, polls, last, ...}. pass=false 면 끝 코드 1
import { argoWatcherFromEnv } from "../apps/worker/src/gitops/argo-watch.js";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1] as string;
  if (def === undefined) { console.error(`--${name} 필요`); process.exit(2); }
  return def;
}

const tenant = arg("tenant", "t-11111111");
const app = arg("app", "shop");
const env = arg("env", "aws-eks");            // argocd-push 길이어야 실제로 기다린다 (온프레는 Agent 몫이라 바로 ok)
const commit = arg("commit");
const expect = arg("expect", "ok");
const label = arg("case", expect);

// 워커 환경을 통째로 쓰지 않는다: REST 설정(ARGOCD_URL)이 섞이면 auto 가 REST 로 간다
const wenv: NodeJS.ProcessEnv = {
  ARGO_SOURCE: "k8s",
  ARGO_KUBE_CONTEXT: arg("context", process.env.ARGO_KUBE_CONTEXT || "k3d-onprem"),
  ARGOCD_NAMESPACE: arg("namespace", "argocd"),
  ARGO_WAIT_SEC: arg("wait", "120"),
  ARGO_TICK_MS: arg("tick", "1000"),
  KUBECTL_BIN: process.env.KUBECTL_BIN,
};

const t0 = Date.now();
const r = await argoWatcherFromEnv(wenv).wait(
  { tenant, app, env } as Parameters<ReturnType<typeof argoWatcherFromEnv>["wait"]>[0],
  { commit, bundleSha256: "", resources: [], changed: true },
);
const got = r.ok ? "ok" : (/^(ARGO_[A-Z_]+)/.exec(r.reason ?? "")?.[1] ?? "unknown");
const pass = got === expect;
console.log(JSON.stringify({
  case: label, expect, got, pass, wallMs: Date.now() - t0,
  app: `${tenant}-${app}-${env}`, commit: commit.slice(0, 12),
  ...(r.observed ?? {}), ...(r.reason ? { reason: r.reason.slice(0, 200) } : {}),
}));
process.exit(pass ? 0 : 1);
