// 로컬 kind 에서 리허설 한 번을 끝까지 (시험 전용). 운영 클러스터에 쓰지 않는다.
// agent-worker 가 플랫폼 클러스터 밖에서 도는 길 그대로 돈다: SANDBOX_KUBE_URL·토큰 파일·CA 파일 → rehearsalFromEnv
//   (helm 으로 vCluster, 가상 API 는 kubectl port-forward. sbx-operator 의 pods/portforward)
//
//   kubectl -n platform create token agent-worker > sa.token   (kind 에 플랫폼 차트 sandbox 부분을 먼저 올린다)
//   npx tsx apps/agent-worker/scripts/rehearse-kind.ts --server https://127.0.0.1:<포트> --ca-file kind-ca.crt --token-file sa.token \
//     --input <RehearsalInput.json> \
//     [--tenant-id <uuid>] [--run-id <uuid>] [--map <ref>=<sandboxRef>] [--out result.json]
//   helm·kubectl 은 SANDBOX_HELM_BIN·SANDBOX_KUBECTL_BIN 또는 PATH
//   --map: 이미지 받는 곳 하나를 바꾼다 (예: 일부러 고장 난 이미지로 실패 경우 만들기)
// 입력 예: scripts/fixtures/rehearsal-3tier-onprem.json = 팀 3티어 예시(deploy/ci/values/v2-3tier-onprem.json)를 지금 차트 값 모양으로 옮겨
//   gitops/charts/app 로 렌더한 원본 15개 + 워커 치환(apps/worker rehearsal substitute·buildRehearsalInput)이 만든 적용본.
//   Postgres 객체는 적용본에 없다. databases[] 한 줄로 agent-worker 가 DB 대체물을 만든다.
//   이미지는 도착 주소@다이제스트를 공개 이미지(같은 다이제스트)로 바꿔 둔 표로 받는다
// kind 준비: 플랫폼 차트 sandbox 부분(RBAC·VAP·StorageClass, kind 는 provisioner rancher.io/local-path)을 올린다.
//   제어판 저장 emptyDir 이면 차트가 Deployment 를 그리므로 ClusterRole sbx-operator 에 apps/deployments create·delete 가 있어야 한다
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RehearsalInput } from "@svc/contracts";
import { rehearsalFromEnv } from "@svc/agent";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [server, caFile, tokenFile, inputPath] = [arg("server"), arg("ca-file"), arg("token-file"), arg("input")];
if (!server || !caFile || !tokenFile || !inputPath) { console.error("--server, --ca-file, --token-file, --input 이 필요"); process.exit(2); }
const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const rehearsal = rehearsalFromEnv({
  SANDBOX_KUBE_URL: server, SANDBOX_KUBE_CA_FILE: caFile, SANDBOX_KUBE_TOKEN_FILE: tokenFile,
  SANDBOX_VCLUSTER_CHART: join(vendor, "vcluster-0.37.6.tgz"),
  SANDBOX_HELM_BIN: process.env.SANDBOX_HELM_BIN, SANDBOX_KUBECTL_BIN: process.env.SANDBOX_KUBECTL_BIN,
});
if (!rehearsal.host) { console.error("호스트 접속 설정을 못 만듦"); process.exit(2); }
const host = rehearsal.host;

const input = RehearsalInput.parse(JSON.parse(readFileSync(inputPath, "utf8")));
const map = arg("map");
if (map) {
  const [ref, to] = map.split("=");
  input.images = input.images.map((i) => (i.ref === ref ? { ...i, sandboxRef: to! } : i));
}
const runId = arg("run-id") ?? randomUUID();
const tenantId = arg("tenant-id") ?? randomUUID();
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`[${stamp()}] 리허설 시작 run=${runId} tenant=${tenantId} backend=${rehearsal.describe} 가상 API=${host.reach ? "port-forward" : "서비스 주소"}`);
const result = await rehearsal.rehearse(input, { id: runId, tenantId, onPhase: (p) => console.log(`[${stamp()}] phase ${p}`) });
console.log(`[${stamp()}] verdict=${result.verdict} failureCode=${result.failureCode} sandbox=${result.sandbox.name} k8s=${result.sandbox.k8sVersion} deleted=${result.deleted}`);
console.log(`timingsMs ${JSON.stringify(result.timingsMs)}`);
for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.required ? " " : "~"} ${c.id.padEnd(16)} ${c.subject.padEnd(34)} ${String(c.ms).padStart(6)}ms  ${c.detail}`);
for (const w of result.warnings) console.log(`warning: ${w}`);
const left = await host.kube.call("GET", `/api/v1/namespaces?labelSelector=${encodeURIComponent("platform.svc/sandbox=true")}`);
console.log(`teardown: platform.svc/sandbox=true 네임스페이스 ${((left.body as any)?.items ?? []).map((n: any) => `${n.metadata.name}(${n.status.phase})`).join(", ") || "0개"}`);
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
