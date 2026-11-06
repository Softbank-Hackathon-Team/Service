import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryExec, readAwsTargetFacts, readInventory } from "../src/index.js";
import { spawnExec, type Exec } from "../src/terraform/real-runner.js";

// 11/06: 실자원 읽기 CLI 동시 실행 한도 (inventory.ts inventoryExec). 환경 여럿을 같이 읽어도 INVENTORY_MAX_PROCS 개까지만 돌고,
//   결과는 명령 순서대로, 줄에서 기다린 시간은 명령 시간 제한에 들지 않는다

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPLIES: Record<string, unknown> = {
  "aws sts get-caller-identity": { Account: "123456789012" },
  "aws eks list-clusters": { clusters: ["c1"] },
  "aws rds describe-db-instances": { DBInstances: [{ DBInstanceIdentifier: "db1", DBInstanceStatus: "available" }] },
  "aws ec2 describe-vpcs": { Vpcs: [{ VpcId: "vpc-1", State: "available" }] },
  "aws elbv2 describe-load-balancers": { LoadBalancers: [{ LoadBalancerName: "lb1" }] },
  "aws ecr describe-repositories": { repositories: [{ repositoryName: "r1" }] },
  "gcloud container clusters list": [{ name: "g1" }],
  "gcloud sql instances list": [{ name: "s1" }],
  "gcloud compute networks list": [{ name: "n1" }],
  "gcloud compute forwarding-rules list": [{ name: "f1" }],
  "gcloud artifacts repositories list": [{ name: "projects/p1/locations/x/repositories/a1" }],
};
const reply = (cmd: string, args: string[]) => {
  const line = `${cmd} ${args.join(" ")}`;
  const k = Object.keys(REPLIES).find((p) => line.startsWith(p + " "));
  return JSON.stringify(k ? REPLIES[k] : cmd === "gcloud" ? [] : {});
};

/** 동시에 도는 수를 세는 가짜 CLI. 늦게 시작한 명령이 먼저 끝나도록 시간을 줄여 간다 */
function counting() {
  const st = { now: 0, peak: 0, calls: 0 };
  const exec: Exec = async (cmd, args) => {
    const i = st.calls++;
    st.now++; st.peak = Math.max(st.peak, st.now);
    await sleep(Math.max(1, 30 - i));
    st.now--;
    return { code: 0, stdout: reply(cmd, args), stderr: "", ms: 1 };
  };
  return { st, exec };
}

const names = (inv: Awaited<ReturnType<typeof readInventory>>) => inv.groups.map((g) => [g.category, g.items.map((x) => x.name)]);

test("환경 둘 + 도착 사실을 같이 읽어도 CLI 는 기본 4개까지만 동시에, 결과는 명령 순서대로", async () => {
  delete process.env.INVENTORY_MAX_PROCS;
  const { st, exec } = counting();
  const [aws, gcp, facts] = await Promise.all([
    readInventory("aws", { exec, env: { AWS_REGION: "ap-northeast-2" } }),
    readInventory("gcp", { exec, env: { GCP_PROJECT: "p1" } }),
    readAwsTargetFacts("shop-eks", { exec: inventoryExec(exec), env: { AWS_REGION: "ap-northeast-2" } }),
  ]);
  assert.equal(st.calls, 9 + 8 + 1, "aws sts·묶음 5·비용 3 + gcp 묶음 5·비용 3 + 도착 사실 1");
  assert.equal(st.peak, 4, "한도까지는 같이 돌고, 넘지는 않는다");
  assert.equal(aws.status, "ok"); assert.equal(gcp.status, "ok");
  assert.deepEqual(names(aws), [["cluster", ["c1"]], ["database", ["db1"]], ["network", ["vpc-1"]], ["ingress", ["lb1"]], ["registry", ["r1"]]]);
  assert.deepEqual(names(gcp), [["cluster", ["g1"]], ["database", ["s1"]], ["network", ["n1"]], ["ingress", ["f1"]], ["registry", ["a1"]]]);
  assert.equal(facts.ok, false);   // 가짜 응답에 서브넷이 없을 뿐. 한도를 같이 쓰는지만 본다
  assert.equal(st.now, 0);
});

test("INVENTORY_MAX_PROCS 로 한도를 바꾼다", async () => {
  process.env.INVENTORY_MAX_PROCS = "2";
  try {
    const { st, exec } = counting();
    await Promise.all([readInventory("aws", { exec, env: {} }), readInventory("gcp", { exec, env: { GCP_PROJECT: "p1" } })]);
    assert.equal(st.peak, 2);
  } finally { delete process.env.INVENTORY_MAX_PROCS; }
});

test("줄에서 기다린 시간은 시간 제한에 들지 않는다: 각 명령 25ms·제한 60ms·한도 2 → 마지막 명령이 줄에서 제한보다 오래(≈75ms) 기다려도 전부 성공", async () => {
  process.env.INVENTORY_MAX_PROCS = "2";
  try {
    // spawnExec 와 같은 규칙의 가짜: 시간 제한 타이머는 exec 가 불린 순간 시작
    const exec: Exec = (cmd, args, o) => new Promise((res) => {
      const t = setTimeout(() => res({ code: 130, stdout: "", stderr: `[z70] timeout ${o.timeoutMs}ms → SIGINT`, ms: o.timeoutMs }), o.timeoutMs);
      setTimeout(() => { clearTimeout(t); res({ code: 0, stdout: reply(cmd, args), stderr: "", ms: 25 }); }, 25);
    });
    const t0 = performance.now();
    const inv = await readInventory("aws", { exec, env: { INVENTORY_TIMEOUT_MS: "60" } });
    assert.ok(performance.now() - t0 > 100, "sts 뒤 명령 8개가 둘씩 → 마지막 명령은 줄에서 제한(60ms)보다 오래 기다렸다");
    assert.equal(inv.status, "ok", inv.reason ?? "");
    assert.ok(inv.groups.every((g) => !g.error));
  } finally { delete process.env.INVENTORY_MAX_PROCS; }
});

test("진짜 프로세스: 한도 1 에서 300ms 명령 다섯 개, 제한 1초 — 마지막은 줄에서 1초 넘게 기다려도 끊기지 않는다", async () => {
  process.env.INVENTORY_MAX_PROCS = "1";
  try {
    const exec = inventoryExec(spawnExec);
    const run = () => exec(process.execPath, ["-e", "setTimeout(() => console.log('ok'), 300)"], { cwd: process.cwd(), env: process.env, timeoutMs: 1000 });
    const t0 = performance.now();
    const rs = await Promise.all([run(), run(), run(), run(), run()]);
    assert.ok(performance.now() - t0 > 1500, "하나씩 돌았다");
    assert.deepEqual(rs.map((r) => [r.code, r.stdout.trim()]), Array(5).fill([0, "ok"]));
    assert.ok(rs.every((r) => !/timeout/.test(r.stderr)));
  } finally { delete process.env.INVENTORY_MAX_PROCS; }
});
