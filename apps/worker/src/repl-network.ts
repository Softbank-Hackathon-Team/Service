import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workDirOf, workRootOf } from "@svc/adapters";

// 중계기 이전의 도착 DB 복제 길 (지금은 GCP 도착 aws-gcp 만). 중계 공개 IP 는 apply 때 생기는 사실이라 계획 지문 밖에 두고,
//   이전 작업 폴더 repl-network.json(0600)에 남긴다 (db-writer.json 과 같은 자리). apply 와 컷오버·롤백의 다시 apply 가 같은 파일을 읽어
//   postgres_json 에 덧씌운다 (adapters withReplicationNetworkV2) → 다시 apply 가 중계 IP 를 Cloud SQL 허용 주소에서 빼지 않는다.
// TODO(human): 이 길(공개 + 허용 주소)을 계획서에도 보일지. 지금은 apply 감사 detail.replicationNetwork 에만 남는다
export interface ReplNetwork {
  /** Cloud SQL authorized_networks 에 더할 /32·대역 (플랫폼 나가는 대역 + 중계 공개 IP) */
  peerCidrs: string[];
  /** 앱 계정을 Cloud SQL API 사용자 대신 워커가 SQL 로 만든다 (울타리가 먹는 일반 역할) */
  appLoginSql: boolean;
}

const fileOf = (env: NodeJS.ProcessEnv, tenant: string, migrationId: string) => join(workDirOf(workRootOf(env), migrationId, tenant), "repl-network.json");

export function loadReplNetwork(env: NodeJS.ProcessEnv, tenant: string, migrationId: string): ReplNetwork | null {
  const f = fileOf(env, tenant, migrationId);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Partial<ReplNetwork>;
    return Array.isArray(j.peerCidrs) ? { peerCidrs: j.peerCidrs.filter((c): c is string => typeof c === "string"), appLoginSql: j.appLoginSql === true } : null;
  } catch { return null; }
}

export function saveReplNetwork(env: NodeJS.ProcessEnv, tenant: string, migrationId: string, n: ReplNetwork): void {
  const f = fileOf(env, tenant, migrationId);
  mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(n, null, 2), { mode: 0o600 });
}

/** 허용 주소를 더한다 (합집합, 정렬). 앱 로그인은 SQL (중계기 이전은 늘 켠다) */
export const withPeers = (n: ReplNetwork | null, add: readonly string[]): ReplNetwork =>
  ({ peerCidrs: [...new Set([...(n?.peerCidrs ?? []), ...add])].sort(), appLoginSql: true });
