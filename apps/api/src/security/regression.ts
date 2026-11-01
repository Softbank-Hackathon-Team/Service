import { NotFound, type Tx } from "@svc/core";
import type { LiveSecurityReport, SecurityRegression } from "@svc/contracts";
import { compareLiveReports } from "@svc/security";
import { latestLiveSnapshot } from "./live.js";

// 보안 회귀 (Z95). 출발·도착 실점검 결과(Z91 LiveSecurityReport)를 열쇠별로 비교한다.
// GET 은 읽기 전용: 새로 점검하지 않고, 감사에 남은 마지막 점검(Z91 POST …/security/check 가 남긴 security.live_check)을
// 쪽마다 하나씩 쓴다 (Z91 latestLiveSnapshot 재사용, origin = snapshot)
export interface RegressionInput {
  migrationId: string;
  source: LiveSecurityReport | null;
  target: LiveSecurityReport | null;
  now: Date;
}

// withTenant 안에서 부른다. RLS 때문에 남의 회사 이전은 migrations 에서 0줄 → NotFound
export async function loadRegressionDb(tx: Tx, migrationId: string): Promise<Omit<RegressionInput, "now">> {
  const m = await tx.query("SELECT id FROM migrations WHERE id = $1", [migrationId]);
  if (!m.rows[0]) throw new NotFound("migration", migrationId);
  return { migrationId,
    source: await latestLiveSnapshot(tx, migrationId, "source"),
    target: await latestLiveSnapshot(tx, migrationId, "target") };
}

export function buildRegression(inp: RegressionInput): SecurityRegression {
  const { verdict, summary, items } = compareLiveReports(inp.source, inp.target);
  return {
    regressionVersion: 1, migrationId: inp.migrationId, generatedAt: inp.now.toISOString(),
    verdict, summary, source: inp.source, target: inp.target, items, recorded: false,
  };
}
