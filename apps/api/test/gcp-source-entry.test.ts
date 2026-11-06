// tools/gcp-source.sh entry: 출발 GCP 샘플을 Cloudflare 존 호스트 뒤에 둔다 (이전마다 트래픽 입구 자동 생성의 전제).
//   curl·kubectl 은 기록용 가짜. 진짜 Cloudflare·클러스터 호출 0. 토큰은 명령줄·화면에 안 나와야 한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "cf-api-token-should-not-leak";
const TUNNEL_TOKEN = "tunnel-token-should-not-leak";

function run(extraEnv: Record<string, string>, authFails = false) {
  const bin = mkdtempSync(join(tmpdir(), "gcp-entry-bin-"));
  const calls = join(bin, "calls");
  // 가짜 curl: -X 방법과 마지막 인자(URL)로 Cloudflare 응답 흉내
  writeFileSync(join(bin, "curl"), `#!/bin/bash
m=GET; for ((i=1;i<=$#;i++)); do [ "\${!i}" = -X ] && { j=$((i+1)); m=\${!j}; }; done
u=\${@: -1}; echo "curl $m \${u#*client/v4}" >> "${calls}"
${authFails ? `echo '{"success":false,"errors":[{"code":9106,"message":"Authentication failed"}],"result":null}'; exit 0` : ""}
case "$m $u" in
  "GET "*cfd_tunnel\\?name=*) echo '{"success":true,"result":[]}' ;;
  "POST "*/cfd_tunnel) echo '{"success":true,"result":{"id":"tid-1"}}' ;;
  "GET "*/token) echo '{"success":true,"result":"${TUNNEL_TOKEN}"}' ;;
  "GET "*dns_records*) echo '{"success":true,"result":[]}' ;;
  *) echo '{"success":true,"result":{}}' ;;
esac
`);
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh
echo "kubectl $*" >> "${calls}"
case "$*" in *"get-contexts"*) echo gke_test-proj-1_asia-northeast3-a_platform-target ;; *"create secret"*) echo "kind: Secret" ;; *"apply -f -"*) cat > /dev/null ;; esac
exit 0
`);
  for (const t of ["curl", "kubectl"]) chmodSync(join(bin, t), 0o755);
  const home = mkdtempSync(join(tmpdir(), "gcp-entry-home-"));
  const r = spawnSync("bash", ["tools/gcp-source.sh", "entry"], { cwd: ROOT, encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, GCP_PROJECT: "test-proj-1", GCP_SOURCE_STATE: join(home, "state"), ...extraEnv } });
  return { ...r, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

test("entry: 터널을 만들고 규칙·DNS CNAME·토큰 Secret·연결기를 놓는다. 토큰은 명령줄·화면에 없다", () => {
  const r = run({ ENTRY_HOST: "shop-gcp.example.test", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_ZONE_ID: "zone", CLOUDFLARE_API_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls, /curl POST \/accounts\/acc\/cfd_tunnel\n/);
  assert.match(r.calls, /curl PUT \/accounts\/acc\/cfd_tunnel\/tid-1\/configurations/);
  assert.match(r.calls, /curl POST \/zones\/zone\/dns_records/);
  assert.match(r.calls, /kubectl .*create secret generic source-cloudflared --from-file=token=/);
  assert.match(r.calls, /kubectl .*rollout status deployment\/source-cloudflared/);
  for (const s of [TOKEN, TUNNEL_TOKEN]) { assert.ok(!r.calls.includes(s)); assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s)); }
});

test("거부: Cloudflare 설정이 빠지면 아무것도 부르지 않고 빠진 이름을 알려 준다", () => {
  const r = run({ ENTRY_HOST: "shop-gcp.example.test" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN/);
  assert.equal(r.calls, "");
});

test("거부: 토큰이 틀리면 맨 처음 확인에서 멈추고 터널을 만들었다고 하지 않는다", () => {
  const r = run({ ENTRY_HOST: "shop-gcp.example.test", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_ZONE_ID: "zone", CLOUDFLARE_API_TOKEN: TOKEN }, true);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /토큰 인증 실패/);
  assert.doesNotMatch(r.stdout, /만듦/);
  assert.doesNotMatch(r.calls, /cfd_tunnel/);
});
