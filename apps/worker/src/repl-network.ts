import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workDirOf, workRootOf } from "@svc/adapters";

// 중계기 이전의 도착 DB 복제 길 (지금은 GCP 도착 aws-gcp 만). 중계 공개 IP 는 apply 때 생기는 사실이라 계획 지문 밖에 두고,
//   이전 작업 폴더 repl-network.json(0600)에 남긴다 (db-writer.json 과 같은 자리). apply 와 컷오버·롤백의 다시 apply 가 같은 파일을 읽어
//   postgres_json 에 덧씌운다 (adapters withReplicationNetworkV2) → 다시 apply 가 중계 IP 를 Cloud SQL 허용 주소에서 빼지 않는다.
// TODO(human): 이 길(공개 + 허용 주소)을 계획서에도 보일지. 지금은 apply 감사 detail.replicationNetwork 에만 남는다
// TODO(human): 정리(cleanup) 뒤 복제 길을 닫을지 (repl_public 끄고 다시 apply). 지금은 중계기만 지워지고 Cloud SQL 공개 주소·허용 주소가 남는다
export interface ReplNetwork {
  /** 워커가 Cloud SQL 에 붙는 나가는 대역 (PLATFORM_EGRESS_CIDRS, apply 마다 지금 값) */
  platformCidrs: string[];
  /** 중계 공개 IP (RDS 역방향 구독이 이 IP 로 Cloud SQL 에 들어온다). 중계기를 다시 만들어 바뀌면 옛 IP 는 빠진다 */
  relayIp: string | null;
  /** 앱 계정을 Cloud SQL API 사용자 대신 워커가 SQL 로 만든다 (울타리가 먹는 일반 역할) */
  appLoginSql: boolean;
}

const fileOf = (env: NodeJS.ProcessEnv, tenant: string, migrationId: string) => join(workDirOf(workRootOf(env), migrationId, tenant), "repl-network.json");

export function loadReplNetwork(env: NodeJS.ProcessEnv, tenant: string, migrationId: string): ReplNetwork | null {
  const f = fileOf(env, tenant, migrationId);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Partial<ReplNetwork>;
    if (!Array.isArray(j.platformCidrs)) return null;
    return { platformCidrs: j.platformCidrs.filter((c): c is string => typeof c === "string"), relayIp: typeof j.relayIp === "string" ? j.relayIp : null,
             appLoginSql: j.appLoginSql === true };
  } catch { return null; }
}

export function saveReplNetwork(env: NodeJS.ProcessEnv, tenant: string, migrationId: string, n: ReplNetwork): void {
  const f = fileOf(env, tenant, migrationId);
  mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(n, null, 2), { mode: 0o600 });
}

/** Cloud SQL authorized_networks 에 더할 대역 (정렬, 중복 없음) */
export const peerCidrsOf = (n: ReplNetwork): string[] => [...new Set([...n.platformCidrs, ...(n.relayIp ? [`${n.relayIp}/32`] : [])])].sort();
