// PF RV-09: terraform 작업 전체 예산과 큐 기한. 단계 상한 합이 pg-boss 기한을 넘어 도는 중에 다시 배달되던 것
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tfBudget } from "@svc/contracts";
import { createRealTerraformRunner, type Exec } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("PF RV-09 정상: 큐 기한 = 작업 예산 + 지우기 예산 + 유예 둘 + 여유 (기본 7200초, 지우기 큐 3600초 이상)", () => {
  const b = tfBudget({});
  assert.equal(b.applyExpireSec, b.jobSec + b.destroySec + 2 * b.graceSec + 300);
  assert.ok(b.applyExpireSec > b.jobSec + b.graceSec, "apply 길 끝(시간 초과 + 유예)이 기한보다 먼저");
  assert.ok(b.destroyExpireSec >= b.destroySec + b.graceSec + 300);
  const c = tfBudget({ TF_JOB_BUDGET_SEC: "100", TF_DESTROY_BUDGET_SEC: "50", TF_STOP_GRACE_SEC: "10" });
  assert.equal(c.applyExpireSec, 100 + 50 + 20 + 300);
});

test("PF RV-09 거부: 작업 예산을 다 쓰면 다음 단계를 안 돌리고(124), 단계 상한은 남은 예산을 넘지 않음. 실패 즉시 지우기는 따로 예산", async () => {
  const calls: { step: string; timeoutMs: number }[] = [];
  const exec: Exec = async (_c, args, o) => {
    const step = args.find((a) => ["init", "plan", "apply", "destroy", "output"].includes(a)) ?? "?";
    calls.push({ step, timeoutMs: o.timeoutMs });
    if (step === "apply") { await sleep(60); return { code: 1, stdout: "", stderr: "boom", ms: 60 }; }
    return { code: 0, stdout: "", stderr: "", ms: 1 };
  };
  const root = mkdtempSync(join(tmpdir(), "rv09-"));
  const r = createRealTerraformRunner({ exec, workRoot: root,
    env: { TF_WORK_DIR: root, TF_APPLY_TIMEOUT_SEC: "2700", TF_JOB_BUDGET_SEC: "0.05", TF_DESTROY_BUDGET_SEC: "100", TF_DESTROY_ON_FAIL: "1" } });
  const out = await r.apply("aws", "11111111-1111-4111-8111-111111111111", {} as never);
  assert.equal(out.ok, false);
  for (const c of calls.filter((c) => c.step !== "destroy")) assert.ok(c.timeoutMs <= 50, `${c.step} ${c.timeoutMs}`);
  const d = calls.find((c) => c.step === "destroy");
  assert.ok(d, "apply 가 예산을 다 써도 실패 즉시 지우기는 돈다 (고아 안 남김)");
  assert.ok(d.timeoutMs > 50_000 && d.timeoutMs <= 100_000, String(d.timeoutMs));
  // 예산 0 이면 terraform 을 아예 안 부른다
  calls.length = 0;
  const z = createRealTerraformRunner({ exec, workRoot: root, env: { TF_WORK_DIR: root, TF_JOB_BUDGET_SEC: "0" } });
  const o2 = await z.apply("aws", "22222222-2222-4222-8222-222222222222", {} as never);
  assert.equal(o2.ok, false); assert.equal(calls.length, 0); assert.equal(o2.steps[0]?.code, 124);
});
