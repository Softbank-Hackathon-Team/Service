// 이전 중 도착 GKE 업그레이드 멈춤: 명령 모양·멱등·빌린 토큰만. 클라우드 호출 0 (가짜 exec)
import { test } from "node:test";
import assert from "node:assert/strict";
import { freezeArgs, freezeExclusionName, freezeGkeUpgrades, releaseArgs, releaseGkeUpgrades, gcp } from "../src/index.js";

const MIG = "3f2a9c1e-7b4d-4e8a-9c0f-112233445566";
const T = { projectId: "cust-mig", location: "asia-northeast3-a", cluster: "platform-target", migrationId: MIG, token: "tok-borrowed" };
const NOW = new Date("2026-11-04T03:00:00.000Z");

function fake(existing: string[]) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec = async (_b: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: o.env });
    if (args[2] === "describe") {
      const ex = Object.fromEntries(existing.map((n) => [n, { startTime: "x", endTime: "y" }]));
      return { code: 0, stdout: JSON.stringify(existing.length ? { maintenancePolicy: { window: { maintenanceExclusions: ex } } } : {}), stderr: "", ms: 1 };
    }
    return { code: 0, stdout: "", stderr: "", ms: 1 };
  };
  return { calls, d: { exec, env: { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/own/key.json", CLOUDSDK_CORE_ACCOUNT: "worker@x" } } };
}

test("업그레이드 멈춤 정상: no_upgrades 제외를 72시간 걸고, 빌린 토큰만 쓰고, 두 번째는 건너뜀·끝나면 지움", async () => {
  const name = freezeExclusionName(MIG);
  assert.equal(name, "mig-3f2a9c1e7b4d");
  assert.deepEqual(freezeArgs(T, NOW).slice(-4), [`--add-maintenance-exclusion-name=${name}`, "--add-maintenance-exclusion-start=2026-11-04T03:00:00Z",
    "--add-maintenance-exclusion-end=2026-11-07T03:00:00Z", "--add-maintenance-exclusion-scope=no_upgrades"]);
  assert.deepEqual(releaseArgs(T).slice(0, 6), ["container", "clusters", "update", "platform-target", "--location=asia-northeast3-a", "--project=cust-mig"]);

  let f = fake([]);
  assert.deepEqual(await freezeGkeUpgrades(f.d, T, NOW), { done: "added", name });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1]!.args.includes("--add-maintenance-exclusion-scope=no_upgrades"));
  for (const c of f.calls) {
    assert.equal(c.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok-borrowed");
    assert.equal(c.env.CLOUDSDK_CORE_PROJECT, "cust-mig");
    assert.equal(c.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, "워커 자기 자격이 섞임");
    assert.equal(c.env.CLOUDSDK_CORE_ACCOUNT, undefined);
  }
  f = fake([name]);
  assert.deepEqual(await freezeGkeUpgrades(f.d, T, NOW), { done: "already", name });
  assert.equal(f.calls.length, 1, "이미 있는데 또 검");
  assert.deepEqual(await releaseGkeUpgrades(f.d, T), { done: "removed", name });
  assert.ok(f.calls.at(-1)!.args.includes(`--remove-maintenance-exclusion=${name}`));
  f = fake(["someone-else"]);
  assert.deepEqual(await releaseGkeUpgrades(f.d, T), { done: "absent", name });
  assert.ok(!f.calls.some((c) => c.args.some((a) => a.startsWith("--remove"))), "남의 제외를 지움");
  // 실행 역할 권한 표에 update 가 있음 (지우기 권한 없음)
  assert.deepEqual(gcp.PERMS.gke_upgrade_freeze, { read: ["container.clusters.get"], write: ["container.clusters.update"], remove: [] });
});

test("업그레이드 멈춤 거부: 토큰 없음·이름 모양 아님·길이 범위 밖이면 gcloud 를 안 부르고 던짐, gcloud 실패는 그대로 던짐", async () => {
  const f = fake([]);
  await assert.rejects(freezeGkeUpgrades(f.d, { ...T, token: "" }, NOW), /토큰/);
  await assert.rejects(freezeGkeUpgrades(f.d, { ...T, cluster: "x; rm -rf /" }, NOW), /cluster/);
  await assert.rejects(releaseGkeUpgrades(f.d, { ...T, projectId: "Cust_Mig" }), /projectId/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => freezeArgs(T, NOW, 0), /hours/);
  assert.throws(() => freezeArgs(T, NOW, 721), /hours/);
  assert.throws(() => freezeExclusionName("---"), /비었다/);
  const bad = { exec: async () => ({ code: 1, stdout: "", stderr: "PERMISSION_DENIED: container.clusters.update", ms: 1 }), env: {} };
  await assert.rejects(freezeGkeUpgrades(bad, T, NOW), /exit 1/);
});
