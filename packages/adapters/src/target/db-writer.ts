import type { AppSpecV2 } from "@svc/contracts";
import { tenantOf, type Target } from "../common/target.js";
import { managedSecretName, type ManagedProvider } from "./managed.js";

// APP-22 (가) DECISION(team, 11/4 01:57Z Jeong 결정): 컷오버 전까지 도착 앱은 출발 DB 에 붙고, 컷오버 때 도착 DB 로 바꾼다 (롤백하면 다시 출발).
//   Terraform 이 앱까지 띄우는 도착(ECS·Cloud Run·VM·관리형 잡)은 루트 변수 db_writer_json 을 바꿔 다시 apply 한다 (k8s 는 GitOps database.activeWriter).
//   이 파일은 순수 함수: 출발 경로(주소·전용 계정) → db_writer_json. 비밀번호 값은 안 받는다 (워커가 출발 전용 그릇에 따로 넣음 → state·변수에 안 남음)

export type DbWriter = "source" | "target";
/** 도착 앱이 컷오버 전까지 출발 DB 에 붙는 경로 (postgres IR id 마다). user = 출발 전용 최소 권한 계정 */
export interface SourceDbLinkRef { host: string; port: number; user: string; dbName: string }

/** 출발 전용 계정 비밀번호를 넣는 도착 비밀 그릇 이름. aws = JSON {"password": …} 한 그릇 (managedSecretName 과 같은 줄기), gcp = 값 하나 (Cloud Run 은 키를 못 고름) */
export function dbLinkSecretName(p: ManagedProvider, spec: AppSpecV2, t: Target): string {
  return p === "aws" ? `platform/${tenantOf(t)}/${spec.app.name}/db-link` : `app-${spec.app.name}-db-link`;
}

/** db_writer_json (infra/modules/<aws|gcp>/root 변수 설명과 같은 모양) */
export function dbWriterVar(p: ManagedProvider, spec: AppSpecV2, t: Target, active: DbWriter, links: Record<string, SourceDbLinkRef>): string {
  const pg = new Set(spec.components.filter((c) => c.kind === "postgres").map((c) => c.id));
  const ids = Object.keys(links).filter((id) => pg.has(id)).sort();
  const secret = dbLinkSecretName(p, spec, t);
  const link: Record<string, Record<string, string>> = {};
  for (const id of ids) {
    const l = links[id]!;
    link[id] = { host: l.host, port: String(l.port), user: l.user, url: `postgresql://${l.user}@${l.host}:${l.port}/${l.dbName}`, reader: l.host };
  }
  // 그 postgres 와 짝(pairedWith)인 비밀 키 → 출발 전용 그릇. 짝 없는 비밀은 그대로
  const secrets: Record<string, { secret: string; key: string }> = {};
  for (const s of spec.secrets ?? []) for (const k of s.keys)
    if (k.pairedWith && ids.includes(k.pairedWith.component))
      secrets[`${managedSecretName(p, spec, t, s.name, k.key)}#${k.key}`] = { secret, key: "password" };
  return JSON.stringify({ active, link, secrets, external: ids.length ? [secret] : [] });
}
