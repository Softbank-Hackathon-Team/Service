// tools/onprem-k3d.sh: 노트북 k3d 에 온프레 도착 환경을 명령 한 번으로 만든다.
//   k3d·kubectl·curl 은 기록용 가짜, 설치 한 줄(onprem.sh)도 가짜로 내려준다. 진짜 클러스터·플랫폼 호출 0. 토큰은 명령줄·화면에 안 나와야 한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "et_enroll-token-should-not-leak";

function run(args: string[], extraEnv: Record<string, string>, o: { clusterExists?: boolean; home?: string } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "onprem-k3d-bin-"));
  const calls = join(bin, "calls");
  const applied = join(bin, "applied");
  writeFileSync(join(bin, "k3d"), `#!/bin/sh
echo "k3d $*" >> "${calls}"
case "$*" in "cluster get"*) ${o.clusterExists ? "exit 0" : "exit 1"} ;; "kubeconfig get"*) echo "apiVersion: v1" ;; esac
exit 0
`);
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh
echo "kubectl $*" >> "${calls}"
case "$*" in
  *"get secret"*) exit 1 ;;
  *"create secret"*) echo "kind: Secret" ;;
  *"apply -f -"*) cat >> "${applied}" ;;
esac
exit 0
`);
  // 가짜 curl: 설치 한 줄 대신 받은 환경을 기록하는 스크립트를 내려준다
  writeFileSync(join(bin, "curl"), `#!/bin/sh
echo "curl $*" >> "${calls}"
out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
cat > "$out" <<'EOS'
echo "bootstrap state=$SVC_STATE_DIR kubeconfig=\${KUBECONFIG:+set} token=\${SVC_ENROLL_TOKEN:+set}" >> "$CALLS"
EOS
`);
  for (const t of ["k3d", "kubectl", "curl"]) chmodSync(join(bin, t), 0o755);
  for (const t of ["docker", "ssh-keygen"]) { writeFileSync(join(bin, t), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, t), 0o755); }
  const home = o.home ?? mkdtempSync(join(tmpdir(), "onprem-k3d-home-"));
  const r = spawnSync("bash", ["tools/onprem-k3d.sh", ...args], { cwd: ROOT, encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CALLS: calls, ...extraEnv } });
  return { ...r, home, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "", applied: existsSync(applied) ? readFileSync(applied, "utf8") : "" };
}

test("up: 클러스터를 만들고 설치 한 줄을 그 클러스터·전용 상태 폴더로 돌린 뒤 데모 vault 저장소와 비밀을 채운다", () => {
  const r = run(["up", "demo-a"], { SVC_ENROLL_TOKEN: TOKEN, SVC_API: "https://platform.example.test" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls, /k3d cluster create demo-a --servers 1 --agents 0 --k3s-arg --disable=traefik@server:0 --wait/);
  assert.match(r.calls, /curl -fsSL https:\/\/platform\.example\.test\/api\/v1\/install\/onprem\.sh/);
  assert.ok(r.calls.includes(`bootstrap state=${r.home}/.svc-onprem-demo-a kubeconfig=set token=set`), r.calls);
  assert.match(r.applied, /kind: ClusterSecretStore\nmetadata: \{ name: vault \}/);
  assert.match(r.applied, /remoteNamespace: svc-demo-secrets/);
  assert.match(r.calls, /kubectl .*-n svc-demo-secrets create secret generic shop-api-api-secrets --from-file=API_TOKEN=/);
  // 현재 컨텍스트를 바꾸지 않는다 (모든 kubectl 이 임시 kubeconfig)
  for (const l of r.calls.split("\n").filter((x) => x.startsWith("kubectl "))) assert.match(l, /--kubeconfig /);
  assert.ok(!r.calls.includes(TOKEN) && !r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
});

test("up: 이미 있는 클러스터와 이미 등록된 상태 폴더면 토큰 없이 설치만 다시 맞춘다", () => {
  const home = mkdtempSync(join(tmpdir(), "onprem-k3d-home-"));
  mkdirSync(join(home, ".svc-onprem-demo-b"), { recursive: true });
  writeFileSync(join(home, ".svc-onprem-demo-b", "agent-key.env"), "AGENT_KEY_ID=ak_x\n");
  const r = run(["up", "demo-b"], {}, { clusterExists: true, home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.calls, /k3d cluster create/);
  assert.match(r.calls, /bootstrap state=.*\.svc-onprem-demo-b kubeconfig=set token=\n/);
});

test("거부: 등록 전인데 토큰이 없으면 클러스터를 만들기 전에 멈춘다", () => {
  const r = run(["up", "demo-c"], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SVC_ENROLL_TOKEN 이 없다/);
  assert.equal(r.calls, "");
});

test("up: APP_NAME 을 주면 비밀 이름이 어댑터 규칙(<앱>-<비밀 소문자, _ → ->)을 따른다", () => {
  const r = run(["up", "demo-d"], { SVC_ENROLL_TOKEN: TOKEN, APP_NAME: "orders", DEMO_SECRETS: "DB_CREDS:PASSWORD" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls, /create secret generic orders-db-creds --from-file=PASSWORD=/);
});

test("거부: 이름 모양이 틀리면 아무것도 부르지 않는다", () => {
  const r = run(["up", "Bad_Name"], { SVC_ENROLL_TOKEN: TOKEN });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /이름은 소문자/);
  assert.equal(r.calls, "");
});
