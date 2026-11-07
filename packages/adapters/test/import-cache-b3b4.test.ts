// #373 B3·B4 (상태: AI 초안): 가져오기 읽기 CLI 짧은 캐시 + EKS 정적 토큰 kubeconfig.
//   가짜 CLI 로 뜬 프로세스 수를 센다. kubectl 이 exec 플러그인 kubeconfig 를 읽으면 진짜처럼 aws eks get-token 하나를 더 센다 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearImportCache, discoverAws, eksKubeconfig, importCacheArgs, importCacheExec, importCacheSec, importCacheSize, newImportCacheStats, type ImportCacheScope,
} from "../src/index.js";
import type { Exec } from "../src/terraform/real-runner.js";
import { pfExec } from "./pf-a-eks-demo-fixture.js";

const ENDPOINT = "https://ABCDEF0123456789ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com";
const CA = Buffer.from("-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n").toString("base64");
const tokenOf = (n: number) => `k8s-aws-v1.${Buffer.from(`https://sts.ap-northeast-2.amazonaws.com/?Action=GetCallerIdentity&fake=${n}`).toString("base64url")}`;
const ok = (v: unknown) => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "", ms: 1 });
const env = (extra: Record<string, string> = {}) => ({ AWS_REGION: "ap-northeast-2", ...extra });
const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;
const SCOPE: ImportCacheScope = { tenantId: "11111111-1111-4111-8111-111111111111", envId: "e-aws-1", role: "arn:aws:iam::111122223333:role/svc-observe" };

/** PF-A EKS 데모 출발(pfExec) + 진짜와 같은 kubeconfig 흐름. spawns = 뜬 프로세스 전부 (kubectl 이 exec 플러그인으로 띄우는 get-token 포함) */
function eksFake(o: { tokenFail?: (n: number) => boolean } = {}) {
  const pf = pfExec();
  const spawns: string[] = [];
  const seen = { modes: new Set<number>(), tokens: new Set<string>() };
  let tokens = 0;
  const exec: Exec = async (cmd, args, opts) => {
    spawns.push(`${cmd} ${args.slice(0, 2).join(" ")}`);
    if (cmd === "aws" && args[0] === "eks" && args[1] === "describe-cluster") {
      const j = JSON.parse((await pf.exec(cmd, args, opts)).stdout) as { cluster: Record<string, unknown> };
      return ok({ cluster: { ...j.cluster, endpoint: ENDPOINT, certificateAuthority: { data: CA } } });
    }
    if (cmd === "aws" && args[0] === "eks" && args[1] === "get-token") {
      const n = ++tokens;
      if (o.tokenFail?.(n)) return { code: 255, stdout: "", stderr: "Unable to locate credentials", ms: 1 };
      return ok({ kind: "ExecCredential", apiVersion: "client.authentication.k8s.io/v1beta1", spec: {},
        status: { expirationTimestamp: new Date(Date.now() + 14 * 60_000).toISOString(), token: tokenOf(n) } });
    }
    if (cmd === "aws" && args[0] === "eks" && args[1] === "update-kubeconfig") {   // awscli 2.x 가 쓰는 모양 (사용자 = exec 플러그인)
      const kc = args[args.indexOf("--kubeconfig") + 1]!;
      writeFileSync(kc, JSON.stringify({ apiVersion: "v1", kind: "Config", users: [{ name: "u", user: { exec: { apiVersion: "client.authentication.k8s.io/v1beta1", command: "aws",
        args: ["--region", "ap-northeast-2", "eks", "get-token", "--cluster-name", args[args.indexOf("--name") + 1], "--output", "json"] } } }] }));
      return ok("Added new context");
    }
    if (cmd === "kubectl") {
      const kc = args[args.indexOf("--kubeconfig") + 1]!;
      const cfg = JSON.parse(readFileSync(kc, "utf8")) as { users: Array<{ user: { exec?: { command: string; args: string[] }; token?: string } }>; clusters?: Array<{ cluster: { server: string } }> };
      const u = cfg.users[0]!.user;
      if (u.exec) spawns.push(`${u.exec.command} ${u.exec.args.slice(2, 4).join(" ")} (kubectl exec 플러그인)`);   // 진짜 kubectl 은 부를 때마다 플러그인을 새로 띄운다
      else { seen.modes.add(statSync(kc).mode & 0o777); seen.tokens.add(u.token!); assert.equal(cfg.clusters![0]!.cluster.server, ENDPOINT); }
    }
    return pf.exec(cmd, args, opts);
  };
  return { exec, spawns, seen, tokens: () => tokens, unmatched: pf.unmatched };
}

test("B4: 정적 토큰 kubeconfig — kubectl 마다 뜨던 aws eks get-token 이 가져오기 한 번에 1번으로, 원본은 그대로", async (t) => {
  const before = eksFake();
  const invBefore = await discoverAws({ exec: before.exec, env: env({ IMPORT_EKS_STATIC_TOKEN: "0" }) }, {});
  const after = eksFake();
  const invAfter = await discoverAws({ exec: after.exec, env: env() }, {});
  assert.deepEqual(invAfter, invBefore);
  const kube = count(before.spawns, /^kubectl /);
  assert.ok(kube >= 15, `kubectl ${kube}번`);
  assert.equal(count(after.spawns, /^kubectl /), kube);
  assert.equal(count(before.spawns, /get-token/), kube, "exec kubeconfig: kubectl 하나에 get-token 하나");
  assert.equal(count(before.spawns, /update-kubeconfig/), 1);
  assert.equal(count(after.spawns, /get-token/), 1, "정적 토큰: 한 번만");
  assert.equal(count(after.spawns, /update-kubeconfig/), 0);
  assert.equal(before.spawns.length - after.spawns.length, kube, "줄어든 프로세스 = kubectl 수 (update-kubeconfig 1 → get-token 1)");
  assert.deepEqual([...after.seen.modes], [0o600], "토큰 파일은 0600");
  assert.deepEqual([...after.seen.tokens], [tokenOf(1)]);
  assert.ok(!JSON.stringify(invAfter).includes("k8s-aws-v1"), "토큰이 원본에 없음");
  t.diagnostic(`CLI 프로세스 (가져오기 한 번): 전 ${before.spawns.length} → 후 ${after.spawns.length} (kubectl ${kube}번, aws eks get-token ${kube} → 1)`);
});

test("B4 거부: get-token 실패·주소 없음·끔이면 예전 exec kubeconfig 로 같은 원본 (멈추지 않음)", async () => {
  const ref = await discoverAws({ exec: eksFake().exec, env: env({ IMPORT_EKS_STATIC_TOKEN: "0" }) }, {});
  const fail = eksFake({ tokenFail: () => true });
  assert.deepEqual(await discoverAws({ exec: fail.exec, env: env() }, {}), ref);
  assert.equal(count(fail.spawns, /^aws eks get-token$/), 1);
  assert.equal(count(fail.spawns, /update-kubeconfig/), 1, "실패하면 예전 길");
  assert.equal(fail.seen.tokens.size, 0);
  // describe-cluster 에 주소·CA 가 없으면(옛 시험 가짜와 같은 모양) get-token 을 부르지도 않는다
  const plain = pfExec();
  await discoverAws({ exec: plain.exec, env: env() }, {});
  assert.equal(plain.calls.filter((l) => / get-token /.test(l)).length, 0);
  assert.equal(plain.calls.filter((l) => / update-kubeconfig /.test(l)).length, 1);
});

test("B4: 토큰이 끝나기 2분 안이면 kubectl 앞에서 한 번만 다시 받고(동시 호출도 하나), 다시 받기가 실패하면 exec kubeconfig 로", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-b4-"));
  const path = join(dir, "eks-r-x.kubeconfig");
  try {
    let clock = 1_700_000_000_000, n = 0, failNext = false, execCalls = 0;
    const base: Exec = async (cmd, args) => {
      if (cmd === "aws" && args[1] === "get-token") {
        n++;
        if (failNext) return { code: 255, stdout: "", stderr: "ExpiredToken: the security token included in the request is expired", ms: 1 };
        return ok({ status: { token: tokenOf(n), expirationTimestamp: new Date(clock + 5 * 60_000).toISOString() } });
      }
      if (cmd === "kubectl") return ok(readFileSync(path, "utf8"));   // 시험용: kubectl 이 본 kubeconfig 를 그대로 돌려준다
      return ok("");
    };
    const k = await eksKubeconfig({ exec: base, env: {} }, { cluster: "x", region: "r", desc: { endpoint: ENDPOINT, certificateAuthority: { data: CA } }, path,
      execKubeconfig: async () => { execCalls++; writeFileSync(path, JSON.stringify({ users: [{ user: { exec: { command: "aws" } } }] })); }, now: () => clock });
    assert.equal(k.mode(), "static"); assert.equal(n, 1); assert.equal(execCalls, 0);
    const kubectl = () => k.deps.exec!("kubectl", ["get", "pods", "-n", "shop", "--kubeconfig", path, "-o", "json"], { cwd: ".", env: {}, timeoutMs: 1000 });
    const userOf = (o: { stdout: string }) => (JSON.parse(o.stdout) as { users: Array<{ user: { token?: string; exec?: unknown } }> }).users[0]!.user;
    clock += 2 * 60_000;   // 3분 남음 → 그대로
    assert.equal(userOf(await kubectl()).token, tokenOf(1)); assert.equal(n, 1);
    clock += 2 * 60_000;   // 1분 남음 → 다섯이 같이 불러도 한 번만 다시 받음
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => kubectl()));
    assert.equal(n, 2);
    for (const o of outs) assert.equal(userOf(o).token, tokenOf(2));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    clock += 4 * 60_000; failNext = true;   // 또 1분 남음 + 다시 받기 실패 → exec kubeconfig
    assert.ok(userOf(await kubectl()).exec, "exec kubeconfig 로 바뀜");
    assert.equal(k.mode(), "exec"); assert.equal(execCalls, 1);
    await kubectl(); await kubectl();
    assert.equal(n, 3, "exec 로 바뀐 뒤엔 토큰을 더 받지 않음");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B4 거부: get-token 응답이 깨져도 토큰 조각이 오류에 안 나오고, 예전 길도 실패하면 그 오류를 던짐", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-b4-"));
  const path = join(dir, "eks-r-x.kubeconfig");
  try {
    const garbage: Exec = async (cmd, args) => (cmd === "aws" && args[1] === "get-token" ? ok(`{"status":{"token":"${tokenOf(9)}" 깨진 JSON`) : ok(""));
    const k = await eksKubeconfig({ exec: garbage, env: {} }, { cluster: "x", region: "r", desc: { endpoint: ENDPOINT, certificateAuthority: { data: CA } }, path,
      execKubeconfig: async () => { writeFileSync(path, "{}"); } });
    assert.equal(k.mode(), "exec");
    await assert.rejects(eksKubeconfig({ exec: garbage, env: {} }, { cluster: "x", region: "r", desc: { endpoint: ENDPOINT, certificateAuthority: { data: CA } }, path,
      execKubeconfig: async () => { throw new Error("update-kubeconfig 실패"); } }), (e: Error) => /update-kubeconfig 실패/.test(e.message) && !e.message.includes("k8s-aws-v1"));
    // 주소가 https 가 아니면(모양 틀림) 토큰을 받지 않는다
    let asked = 0;
    const count1: Exec = async (cmd, args) => { if (args[1] === "get-token") asked++; return ok(""); };
    await eksKubeconfig({ exec: count1, env: {} }, { cluster: "x", region: "r", desc: { endpoint: "http://plain", certificateAuthority: { data: CA } }, path, execKubeconfig: async () => {} });
    await eksKubeconfig({ exec: count1, env: {} }, { cluster: "x", region: "r", desc: { endpoint: ENDPOINT, certificateAuthority: { data: CA }, outpostConfig: {} }, path, execKubeconfig: async () => {} });
    assert.equal(asked, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B3: 담는 명령 = 읽기만 (aws describe/list/get · kubectl get/api-resources · gcloud describe/list), 비밀값·토큰·쓰기·클러스터 신원 모름은 안 담음", () => {
  const KC = "/var/folders/xy/T/svc-import-Ab12Cd/eks-ap-northeast-2-c1.kubeconfig";
  const yes: Array<[string, string[]]> = [
    ["aws", ["sts", "get-caller-identity", "--output", "json"]],
    ["aws", ["eks", "describe-cluster", "--name", "c1", "--region", "r", "--output", "json"]],
    ["aws", ["rds", "describe-db-parameters", "--db-parameter-group-name", "pg", "--source", "user"]],
    ["aws", ["iam", "get-role-policy", "--role-name", "app", "--policy-name", "p", "--output", "json"]],
    ["kubectl", ["get", "deployments", "-A", "--kubeconfig", KC, "--request-timeout=15s", "-o", "json"]],
    ["kubectl", ["api-resources", "--namespaced=true", "--verbs=list", "-o", "name", "--kubeconfig", KC, "--request-timeout=15s"]],
    ["kubectl", ["get", "configmaps", "-n", "shop", "--context", "k3d-onprem", "--request-timeout=15s", "-o", "json"]],
    ["gcloud", ["sql", "instances", "list", "--project", "p", "--format", "json"]],
  ];
  const no: Array<[string, string[]]> = [
    ["aws", ["eks", "get-token", "--cluster-name", "c1", "--region", "r", "--output", "json"]],
    ["aws", ["eks", "update-kubeconfig", "--name", "c1", "--kubeconfig", KC, "--region", "r"]],
    ["aws", ["secretsmanager", "list-secrets", "--region", "r", "--output", "json"]],
    ["aws", ["secretsmanager", "get-secret-value", "--secret-id", "db"]],
    ["aws", ["ssm", "get-parameter", "--name", "db", "--with-decryption"]],
    ["aws", ["ecr", "get-login-password"]],
    ["aws", ["ec2", "get-password-data", "--instance-id", "i-1"]],
    ["aws", ["sts", "assume-role", "--role-arn", "arn"]],
    ["aws", ["s3api", "put-object", "--bucket", "b"]],
    ["kubectl", ["get", "secrets", "-n", "shop", "--kubeconfig", KC, "-o", "json"]],
    ["kubectl", ["get", "secret", "db", "-n", "shop", "--kubeconfig", KC, "-o", "json"]],
    ["kubectl", ["get", "externalsecrets.external-secrets.io", "-n", "shop", "--kubeconfig", KC, "-o", "json"]],
    ["kubectl", ["get", "--raw", "/api/v1/namespaces/shop/secrets", "--kubeconfig", KC]],
    ["kubectl", ["apply", "-f", "x.yaml", "--kubeconfig", KC]],
    ["kubectl", ["get", "pods", "-A", "--kubeconfig", "/tmp/svc-import-x/kubeconfig", "-o", "json"]],   // 이름 없는 kubeconfig = 어느 클러스터인지 모름
    ["kubectl", ["get", "pods", "-A", "-o", "json"]],   // 기본 kubeconfig
    ["gcloud", ["container", "clusters", "get-credentials", "c1", "--location", "l", "--project", "p"]],
    ["gcloud", ["secrets", "list", "--project", "p", "--format", "json"]],
    ["gcloud", ["auth", "print-access-token"]],
    ["terraform", ["show", "-json"]],
  ];
  for (const [c, a] of yes) assert.ok(importCacheArgs(c, a), `담아야 함: ${c} ${a.join(" ")}`);
  for (const [c, a] of no) assert.equal(importCacheArgs(c, a), null, `담으면 안 됨: ${c} ${a.join(" ")}`);
  assert.equal(importCacheArgs("kubectl", ["get", "pods", "-A", "--context", "k3d-onprem", "-o", "json"], { KUBECONFIG: "/tmp/other" }), null, "KUBECONFIG 환경변수로 고른 클러스터");
  // 임시 폴더가 달라도 같은 클러스터 = 같은 키 인자, 다른 클러스터 = 다른 키 인자
  const k = (p: string) => importCacheArgs("kubectl", ["get", "pods", "-A", "--kubeconfig", p, "-o", "json"]);
  assert.deepEqual(k("/tmp/svc-import-AAAAAA/eks-r-c1.kubeconfig"), k("/tmp/svc-import-BBBBBB/eks-r-c1.kubeconfig"));
  assert.notDeepEqual(k("/tmp/svc-import-AAAAAA/eks-r-c1.kubeconfig"), k("/tmp/svc-import-AAAAAA/eks-r-c2.kubeconfig"));
});

test("B3: TTL 안이면 기록 재생(나이 기록), TTL 이 지나면 다시 부름, 회사·환경·역할이 다르면 따로", async () => {
  clearImportCache();
  let clock = 0, n = 0;
  const base: Exec = async () => ({ code: 0, stdout: `{"n":${++n}}`, stderr: "", ms: 5 });
  const run = (e: Exec) => e("aws", ["rds", "describe-db-instances", "--region", "r", "--output", "json"], { cwd: ".", env: {}, timeoutMs: 1 });
  const st = newImportCacheStats(300);
  const ex = importCacheExec(base, { scope: SCOPE, ttlSec: 300, stats: st, now: () => clock });
  assert.equal((await run(ex)).stdout, '{"n":1}');
  clock += 299_000;
  assert.equal((await run(ex)).stdout, '{"n":1}', "299초 = 재생");
  assert.deepEqual(st, { ttlSec: 300, hits: 1, misses: 1, bypass: 0, maxAgeSec: 299 });
  clock += 1_000;
  assert.equal((await run(ex)).stdout, '{"n":2}', "300초 = 지남 → 다시 부름");
  assert.equal(st.misses, 2);
  for (const scope of [{ ...SCOPE, role: "arn:aws:iam::111122223333:role/svc-observe-b" }, { ...SCOPE, envId: "e-aws-2" }, { ...SCOPE, tenantId: "22222222-2222-4222-8222-222222222222" }]) {
    const before = n;
    const out = (await run(importCacheExec(base, { scope, ttlSec: 300, now: () => clock }))).stdout;
    assert.equal(out, `{"n":${before + 1}}`, JSON.stringify(scope));
  }
});

test("B3 거부: 실패는 안 담고, 비밀 명령은 매번 부르고, IMPORT_CACHE_SEC=0 이면 캐시 없음", async () => {
  clearImportCache();
  let n = 0, fail = true;
  const base: Exec = async (cmd, args) => (fail && args[1] === "list-clusters"
    ? { code: 255, stdout: "", stderr: "Could not connect to the endpoint URL", ms: 1 } : { code: 0, stdout: `${cmd}:${++n}`, stderr: "", ms: 1 });
  const st = newImportCacheStats(300);
  const ex = importCacheExec(base, { scope: SCOPE, ttlSec: 300, stats: st });
  const o = { cwd: ".", env: {}, timeoutMs: 1 };
  assert.equal((await ex("aws", ["eks", "list-clusters", "--region", "r"], o)).code, 255);
  fail = false;
  assert.equal((await ex("aws", ["eks", "list-clusters", "--region", "r"], o)).code, 0, "실패는 기록 안 됨 → 다시 부름");
  const KC = "/tmp/svc-import-Zz/eks-r-c1.kubeconfig";
  const secretCmds: Array<[string, string[]]> = [["kubectl", ["get", "secrets", "-n", "shop", "--kubeconfig", KC, "-o", "json"]], ["aws", ["secretsmanager", "list-secrets", "--region", "r"]],
    ["aws", ["eks", "get-token", "--cluster-name", "c1", "--region", "r"]]];
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) for (const [c, a] of secretCmds) seen.add((await ex(c, a, o)).stdout);
  assert.equal(seen.size, 6, "비밀·토큰 명령은 두 번째도 새로 부름");
  assert.equal(st.bypass, 6); assert.equal(st.hits, 0);
  // 끔
  assert.equal(importCacheSec({ IMPORT_CACHE_SEC: "0" }), 0);
  const raw: Exec = async () => ({ code: 0, stdout: "x", stderr: "", ms: 1 });
  assert.equal(importCacheExec(raw, { scope: SCOPE, ttlSec: 0 }), raw, "0 = 감싸지 않음");
  assert.deepEqual([undefined, "", "300", "60", "abc", "-5", "0"].map((v) => importCacheSec(v === undefined ? {} : { IMPORT_CACHE_SEC: v })), [300, 300, 300, 60, 0, 0, 0]);
});

test("B3+B4: 같은 출발을 TTL 안에 다시 가져오면 담지 않는 명령(토큰·시크릿 이름)과 실패한 명령만 다시 뜨고 원본은 같음", async (t) => {
  clearImportCache();
  const f1 = eksFake(), st1 = newImportCacheStats(300);
  const inv1 = await discoverAws({ exec: importCacheExec(f1.exec, { scope: SCOPE, ttlSec: 300, stats: st1 }), env: env() }, {});
  const f2 = eksFake(), st2 = newImportCacheStats(300);
  const inv2 = await discoverAws({ exec: importCacheExec(f2.exec, { scope: SCOPE, ttlSec: 300, stats: st2 }), env: env() }, {});
  assert.deepEqual(inv2, inv1);
  const failed = new Set(f1.unmatched.map((l) => l.split(" ").slice(0, 3).join(" ")));   // 가짜에 없는 명령 = 실패 = 안 담김
  assert.equal(st1.hits, 0);
  assert.equal(st2.hits + st2.misses, st1.misses, "두 번째의 담는 명령 = 첫 번째와 같음");
  assert.equal(st2.misses, [...f2.spawns].filter((l) => failed.has(l.split(" ").slice(0, 3).join(" "))).length, "두 번째에 다시 부른 담는 명령 = 첫 번째에 실패한 것뿐");
  assert.equal(count(f2.spawns, /^kubectl /), 0, "kubectl 은 전부 재생");
  assert.equal(count(f2.spawns, /^aws eks get-token$/), 1, "토큰은 기록하지 않고 새로 받음");
  assert.equal(count(f2.spawns, /^aws secretsmanager list-secrets$/), 1, "시크릿 이름 목록도 안 담음");
  assert.equal(st2.bypass, st1.bypass);
  assert.ok(importCacheSize() > 0);
  t.diagnostic(`CLI 프로세스: 첫 가져오기 ${f1.spawns.length} (담음 ${st1.misses}·안 담음 ${st1.bypass}) → TTL 안 두 번째 ${f2.spawns.length} (재생 ${st2.hits}·다시 부름 ${st2.misses}·안 담음 ${st2.bypass}, 가장 오래된 기록 ${st2.maxAgeSec}초)`);
  clearImportCache();
});
