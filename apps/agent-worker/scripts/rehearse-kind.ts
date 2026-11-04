// 로컬 kind 에서 리허설 한 번을 끝까지 (시험 전용). 운영 클러스터에 쓰지 않는다.
// agent-worker 서비스 계정 토큰 파일과 CA 파일로 호스트에 붙어 진짜 백엔드(createVcluster + runRehearsal)를 돌린다.
// 가상 API 는 클러스터 밖에서 서비스 주소로 못 닿으니 같은 신원으로 port-forward 한다 (sbx-operator 의 pods/portforward)
//
//   kubectl -n platform create token agent-worker > sa.token   (kind 에 플랫폼 차트 sandbox 부분을 먼저 올린다)
//   npx tsx apps/agent-worker/scripts/rehearse-kind.ts --server https://127.0.0.1:<포트> --ca-file kind-ca.crt --token-file sa.token \
//     --input <RehearsalInput.json> \
//     [--run-id <uuid>] [--map <ref>=<sandboxRef>] [--out result.json]
//   --map: 이미지 받는 곳 하나를 바꾼다 (예: 일부러 고장 난 이미지로 실패 경우 만들기)
// 입력 예: scripts/fixtures/rehearsal-3tier-onprem.json = 팀 3티어 예시(deploy/ci/values/v2-3tier-onprem.json)를 지금 차트 값 모양으로 옮겨
//   gitops/charts/app 로 렌더한 원본 15개 + 워커 치환을 손으로 흉내 낸 적용본 17개 (CNPG → Postgres 16 emptyDir, ExternalSecret → 가짜 Secret,
//   복제 1, PVC sbx-standard). 이미지는 도착 주소@다이제스트 그대로 두고 translateImage 로 공개 이미지(같은 다이제스트)를 받는다
// kind 준비: 플랫폼 차트 sandbox 부분(RBAC·VAP·StorageClass, kind 는 provisioner rancher.io/local-path)을 올린다.
//   제어판 저장 emptyDir 이면 차트가 Deployment 를 그리므로 ClusterRole sbx-operator 에 apps/deployments create·delete 가 있어야 한다
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RehearsalInput } from "@svc/contracts";
import {
  asHostKube, createVcluster, helmRunner, hostKubeconfig, kubeClient, leftoverRehearsal, loadVendorCrds, runRehearsal, sweepSandboxes,
  type VclusterHost,
} from "@svc/agent";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [server, caFile, tokenFile, inputPath] = [arg("server"), arg("ca-file"), arg("token-file"), arg("input")];
if (!server || !caFile || !tokenFile || !inputPath) { console.error("--server, --ca-file, --token-file, --input 이 필요"); process.exit(2); }
const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const kube = asHostKube(kubeClient({ baseUrl: server, tokenFile, ca: readFileSync(caFile, "utf8"), timeoutMs: 30_000 }));
const home = mkdtempSync(join(tmpdir(), "rehearse-kind-"));
const kubeconfigPath = join(home, "host.kubeconfig");
writeFileSync(kubeconfigPath, hostKubeconfig({ server, caFile, tokenFile }), { mode: 0o600 });

const forwards: ChildProcess[] = [];
const virtualUrl = (name: string) => new Promise<string>((resolve, reject) => {
  const p = spawn("kubectl", ["--kubeconfig", kubeconfigPath, "-n", name, "port-forward", `svc/${name}`, ":443"], { stdio: ["ignore", "pipe", "pipe"] });
  forwards.push(p);
  p.stdout.on("data", (d: Buffer) => { const m = /127\.0\.0\.1:(\d+)/.exec(d.toString()); if (m) resolve(`https://127.0.0.1:${m[1]}`); });
  p.on("exit", (c) => reject(new Error(`port-forward 끝남 (${c})`)));
});
const host: VclusterHost = {
  kube, chart: join(vendor, "vcluster-0.37.6.tgz"), workDir: home, virtualUrl,
  helm: helmRunner({ bin: process.env.SANDBOX_HELM_BIN ?? "/opt/homebrew/bin/helm", kubeconfig: kubeconfigPath, home }),
};

const input = RehearsalInput.parse(JSON.parse(readFileSync(inputPath, "utf8")));
const map = arg("map");
if (map) {
  const [ref, to] = map.split("=");
  input.images = input.images.map((i) => (i.ref === ref ? { ...i, sandboxRef: to! } : i));
}
const runId = arg("run-id") ?? randomUUID();
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`[${stamp()}] 리허설 시작 run=${runId}`);
const result = await runRehearsal(input, { id: runId, onPhase: (p) => console.log(`[${stamp()}] phase ${p}`) }, {
  create: (spec) => createVcluster(host, spec),
  sweepLeftovers: (keep) => sweepSandboxes(kube, leftoverRehearsal(keep)),
  crds: loadVendorCrds(join(vendor, "crds")),
  ttlSec: 1800,
});
for (const p of forwards) p.kill();
console.log(`[${stamp()}] verdict=${result.verdict} failureCode=${result.failureCode} sandbox=${result.sandbox.name} k8s=${result.sandbox.k8sVersion} deleted=${result.deleted}`);
console.log(`timingsMs ${JSON.stringify(result.timingsMs)}`);
for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.required ? " " : "~"} ${c.id.padEnd(16)} ${c.subject.padEnd(34)} ${String(c.ms).padStart(6)}ms  ${c.detail}`);
for (const w of result.warnings) console.log(`warning: ${w}`);
const left = await kube.call("GET", `/api/v1/namespaces?labelSelector=${encodeURIComponent("platform.svc/sandbox=true")}`);
console.log(`teardown: platform.svc/sandbox=true 네임스페이스 ${((left.body as any)?.items ?? []).map((n: any) => `${n.metadata.name}(${n.status.phase})`).join(", ") || "0개"}`);
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
