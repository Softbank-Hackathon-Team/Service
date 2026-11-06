import { randomUUID } from "node:crypto";
import { QUEUES, RehearsalTarget, rehearsalSettings, type RehearsalEvidence, type RehearsalFailureCode } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { RetryLater, jobData, type MigrationRow, type StepJob, type StepOutcome, type StopHint } from "../jobs/_step.js";
import { ENV_DIR, renderForRehearsal, type DeployInput, type GitopsRepo } from "../gitops/index.js";
import { mirrorFix, mirrorImages } from "./image-mirror.js";
import { podImages, unsupportedOf } from "./substitute.js";
import { buildRehearsalInput, imagePairs, parseManifests } from "./input.js";
import { expireRun, insertFinished, insertQueued, insertReused, insertSkipped, readRun, type RunKey, type RunRow } from "./store.js";

// deploy 리허설 문 (설계 2.2). secretValuesGate 뒤, GitOps 커밋 바로 앞.
// 이번 차례(epoch = migrations.version) 줄 하나의 상태로 갈리는 상태 기계다:
//   줄 없음   → 꺼짐·미지원 도착이면 skipped 줄 → 커밋 / 같은 지문 통과가 있으면 재사용 줄 → 커밋 /
//              그 밖은 렌더 → 치환 → 이미지 복사 → RetryLater (queued 줄 + sandbox-rehearsal 작업 + 다시 넣는 deploy 작업이 한 트랜잭션)
//   queued·running → 그 단계 기한(줄 서기·실행) 전이면 RetryLater, 지나면 error(REHEARSAL_TIMEOUT) → paused
//   passed    → 그 지문으로 커밋 (렌더가 다르면 commitBundle 이 REHEARSAL_BUNDLE_MISMATCH)
//   failed·error → paused (줄의 실패 코드)
//   skipped   → 커밋 (줄의 이유가 근거)
// 기다리는 동안 작업을 붙잡지 않는다 (deploy 큐 만료 900초). agent-worker 가 결과를 쓰고 core wakeQueued 로 깨운다

export type Gate =
  | { kind: "commit"; evidence: RehearsalEvidence; expectBundleSha?: string; detail: Record<string, unknown> }
  | { kind: "stop"; outcome: StepOutcome };
export interface GateDeps { mirror?: typeof mirrorImages; env?: NodeJS.ProcessEnv }

/** 구조로 정해지는 건너뜀 (ECS·Cloud Run·VM, 클러스터 없음, MOCK_ARGO 흉내). 리허설 문 앞 길에서 줄만 남긴다 */
export async function recordSkip(j: StepJob, epoch: number, planId: string | null, reason: "non_k8s" | "no_cluster" | "mock"): Promise<RehearsalEvidence> {
  await withTenant(j.tenantId, (tx) => insertSkipped(tx, { tenantId: j.tenantId, migrationId: j.migrationId, epoch, planId }, reason));
  return reason;
}

export async function rehearsalGate(j: StepJob, m: MigrationRow, epoch: number, i: DeployInput, repo: GitopsRepo, deps: GateDeps = {}): Promise<Gate> {
  const key: RunKey = { tenantId: j.tenantId, migrationId: j.migrationId, epoch, planId: i.plan.planId };
  const row = await withTenant(j.tenantId, (tx) => readRun(tx, key));
  if (row) return fromRow(j, key, row, deps);
  const s = rehearsalSettings(deps.env ?? process.env);
  const target = RehearsalTarget.safeParse(ENV_DIR[i.target.provider]);
  if (!s.enabled || !target.success) {
    const reason = !s.enabled ? "disabled" : "unsupported_target";
    await withTenant(j.tenantId, (tx) => insertSkipped(tx, key, reason));
    return { kind: "commit", evidence: reason, detail: { skipped: reason } };
  }
  const { values, rendered } = await renderForRehearsal(repo, i);
  const reused = await withTenant(j.tenantId, (tx) => insertReused(tx, key, rendered.bundleSha256));
  if (reused) return { kind: "commit", evidence: "reused", expectBundleSha: rendered.bundleSha256,
    detail: { sandboxRunId: reused.id, reusedFrom: reused.from, bundleSha256: rendered.bundleSha256 } };

  const docs = parseManifests(rendered);
  const unsupported = unsupportedOf(docs);
  if (unsupported.length)
    return finishEarly(j, key, { status: "failed", code: "REHEARSAL_UNSUPPORTED_KIND", bundleSha256: rendered.bundleSha256 },
      `치환 표에 없는 종류: ${unsupported.slice(0, 10).join(", ")}`, { unsupported });
  const mirrored = await (deps.mirror ?? mirrorImages)(j, m, imagePairs(i, podImages(docs)), deps.env ? { env: deps.env } : {});
  if (!mirrored.ok)
    return finishEarly(j, key, { status: "error", code: mirrored.code, bundleSha256: rendered.bundleSha256 },
      `이미지 복사 실패 (${mirrored.reason}): ${mirrored.message}`, { mirror: { reason: mirrored.reason, image: mirrored.image } }, mirrorFix(mirrored));

  const input = buildRehearsalInput({ target: target.data, i, values, rendered, docs, images: mirrored.images, mirrored: !mirrored.skipped,
    runBudgetSec: s.timeoutSec });
  const id = randomUUID();
  // 줄과 작업은 다시 넣는 deploy 작업과 같은 트랜잭션에 (runStep). 리허설이 아무리 빨리 끝나도 깨울 deploy 작업이 이미 있다
  throw new RetryLater(QUEUES.deploy, jobData(j), s.pollSec, { rehearsal: { sandboxRunId: id, status: "queued", bundleSha256: input.bundleSha256 } },
    { expected: true, inTx: (tx) => insertQueued(tx, { ...key, id, requestId: j.requestId }, input, s.queueTimeoutSec) });
}

async function fromRow(j: StepJob, key: RunKey, row: RunRow, deps: GateDeps): Promise<Gate> {
  switch (row.status) {
    case "skipped":
      return { kind: "commit", evidence: row.skipReason!, detail: { sandboxRunId: row.id, skipped: row.skipReason } };
    case "passed":
      return { kind: "commit", evidence: row.reusedFrom ? "reused" : "passed", expectBundleSha: row.bundleSha256!, detail: passDetail(row) };
    case "failed": case "error":
      return { kind: "stop", outcome: paused(row.failureCode ?? "REHEARSAL_SANDBOX_UNAVAILABLE", failReason(row), { sandboxRunId: row.id, status: row.status, failedChecks: failedChecks(row) },
        sandboxFix(row)) };
    case "queued": case "running": {
      const s = rehearsalSettings(deps.env ?? process.env);
      if (row.leftSec !== null && row.leftSec <= 0) {
        const expired = await withTenant(j.tenantId, (tx) => expireRun(tx, row.id));
        if (!expired) {
          const now = await withTenant(j.tenantId, (tx) => readRun(tx, key));
          if (now && now.status !== row.status) return fromRow(j, key, now, deps);
        }
        const stage = row.status === "queued" ? "queue" : "run";
        return { kind: "stop", outcome: paused("REHEARSAL_TIMEOUT", stage === "queue"
          ? `리허설이 차례를 기다리다 줄 서기 기한을 넘겼다 (샌드박스는 돌지 않았다). 재개하면 다시 줄을 선다`
          : `리허설이 실행 기한 안에 끝나지 않았다. 재개하면 새 샌드박스에서 다시 돈다`,
          { sandboxRunId: row.id, status: "error", stage }) };
      }
      // 기한 직후에 한 번 더 보게 (기한이 짧게 남았으면 그만큼만)
      const delay = row.leftSec === null ? s.pollSec : Math.max(1, Math.min(s.pollSec, Math.ceil(row.leftSec)));
      throw new RetryLater(QUEUES.deploy, jobData(j), delay, { rehearsal: { sandboxRunId: row.id, status: row.status } }, { expected: true });
    }
  }
}

async function finishEarly(j: StepJob, key: RunKey, x: { status: "failed" | "error"; code: RehearsalFailureCode; bundleSha256: string },
  reason: string, extra: Record<string, unknown>, fix?: StopHint): Promise<Gate> {
  await withTenant(j.tenantId, (tx) => insertFinished(tx, key, x));
  return { kind: "stop", outcome: paused(x.code, reason, { status: x.status, ...extra }, fix) };
}

// fix = 설정·권한이 모자라 멈췄을 때 고칠 자리 (deploy 칸의 error·reason 옆)
const paused = (code: RehearsalFailureCode, reason: string, rehearsal: Record<string, unknown>, fix?: StopHint): StepOutcome =>
  ({ to: "paused", failureCode: code, detail: { deploy: { error: code, reason, ...fix }, rehearsal } });

// agent-worker 쪽이 설정이 없어 샌드박스를 못 띄운 경우의 고칠 자리. 키 = 실패한 sandbox_ready 줄의 앞머리(KubeError 코드 "<코드>: <글>"),
//   워커가 이미지를 안 복사한 입력(agent rehearsal/run.ts: sandbox_ready + REHEARSAL_IMAGE_MIRROR_FAILED)은 NOT_MIRRORED
const SANDBOX_FIX: Record<"SANDBOX_NO_HOST" | "NOT_MIRRORED", StopHint> = {
  SANDBOX_NO_HOST: { missing: ["SANDBOX_KUBE_URL"],
    hint: "agent-worker 가 호스트 클러스터에 닿지 않는다: 플랫폼 클러스터 안이면 차트 sandbox.enabled=true(agent-worker 서비스 계정 토큰·샌드박스 권한)로 올리고, 밖에서 돌리면 agent-worker env SANDBOX_KUBE_URL(+SANDBOX_KUBE_TOKEN_FILE·SANDBOX_KUBE_CA_FILE)을 준 뒤 재개한다 (시험·로컬 흉내면 agent-worker MOCK_SANDBOX=1)" },
  NOT_MIRRORED: { missing: ["helm: sandbox.imageRegistry"],
    hint: "워커가 MOCK_SANDBOX=1 이라 이미지를 샌드박스 자리로 복사하지 않았는데 agent-worker 는 진짜 샌드박스다: 워커 MOCK_SANDBOX 를 끄고 차트 sandbox.imageRegistry(worker SANDBOX_IMAGE_REGISTRY)를 채운 뒤 재개한다 (시험·로컬 흉내면 agent-worker 에도 MOCK_SANDBOX=1)" },
};
function sandboxFix(row: RunRow): StopHint | undefined {
  const ready = (row.result?.checks ?? []).filter((c) => c.required && !c.ok && c.id === "sandbox_ready");
  if (!ready.length) return undefined;
  if (row.failureCode === "REHEARSAL_IMAGE_MIRROR_FAILED") return SANDBOX_FIX.NOT_MIRRORED;
  const code = ready.map((c) => /^([A-Z_]+): /.exec(c.detail)?.[1]).find((x) => x && x in SANDBOX_FIX);
  return code ? SANDBOX_FIX[code as keyof typeof SANDBOX_FIX] : undefined;
}
const failedChecks = (row: RunRow) => (row.result?.checks ?? []).filter((c) => c.required && !c.ok).slice(0, 5)
  .map((c) => ({ id: c.id, subject: c.subject, detail: c.detail }));
// 결과가 없는 끝(agent-worker 입력 거부·처리기 오류)은 agent-worker 가 감사에만 쓴 이유를 그대로 (store readRun errorReason)
const failReason = (row: RunRow) => {
  const first = failedChecks(row)[0];
  return first ? `리허설 실패 ${first.id} ${first.subject}: ${first.detail}`.slice(0, 500)
    : `리허설 ${row.status} (${row.failureCode ?? "?"})${row.errorReason ? `: ${row.errorReason}` : ""}`.slice(0, 500);
};
function passDetail(row: RunRow): Record<string, unknown> {
  const counts: Record<string, number> = { identical: 0, substituted: 0, not_checked: 0 };
  for (const it of row.result?.fidelity.items ?? []) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return { sandboxRunId: row.id, ...(row.reusedFrom ? { reusedFrom: row.reusedFrom } : {}), sandboxName: row.sandboxName,
    bundleSha256: row.bundleSha256, mock: row.result?.sandbox.mock ?? null, counts };
}
