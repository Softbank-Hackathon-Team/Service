// APP-22 (가) DECISION(team, 11/4 01:57Z Jeong 결정): 컷오버 전까지 도착 앱은 출발 DB 에 붙고, 컷오버 때 도착 DB 로 바꾼다 (롤백하면 다시 출발).
//   Terraform 이 앱까지 띄우는 도착(ECS·Cloud Run·VM·관리형 잡)의 길 (k8s 는 app-link.ts 의 GitOps database.activeWriter):
//   1. apply: 출발 경로(주소·전용 계정·비밀번호)를 얻고 → 비밀번호는 도착 비밀 그릇(dbLinkSecretName)에 stdin 으로 넣고 → db_writer_json(active=source) 로 apply.
//      경로 사실(비밀번호 뺀 것)은 이전 작업 폴더 db-writer.json(0600)에 남긴다 → 컷오버·롤백이 같은 값으로 다시 apply
//   2. 컷오버(C6 뒤): active=target 으로 다시 apply. 3. 컷오버 뒤 롤백: active=source 로 다시 apply
//   출발 경로: SOURCE_DB_LINK=real 이면 출발 쪽 경로 만들기(openSourceDbLink, 출발 RDS 에 도착 egress 만 여는 SG + 최소 권한 계정)를 부른다.
//     아니면 APP_LINK_SOURCE_URL (미리 마련한 경로, postgres://<계정>:<비밀번호>@<host>:<port>/<db>)
//   비밀번호는 로그·DB·파일·Terraform 변수에 안 남긴다 (그릇에만)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbLinkSecretName, dbWriterVar, workDirOf, workRootOf, type DbWriter, type SourceDbLinkRef } from "@svc/adapters";
import type { AppSpecV2, Provider } from "@svc/contracts";

export type ManagedProvider = "aws" | "gcp";
export interface SourceLink extends SourceDbLinkRef { password: string }
/** 출발 경로를 만드는 함수 (SOURCE_DB_LINK=real). 출발 쪽 경로 담당 코드가 setSourceDbLinkOpener 로 꽂는다 */
export type SourceDbLinkOpener = (tenantId: string, migrationId: string) => Promise<SourceLink>;
let opener: SourceDbLinkOpener | null = null;
export const setSourceDbLinkOpener = (f: SourceDbLinkOpener | null) => { opener = f; };

export class DbWriterError extends Error {
  constructor(readonly code: "APP_LINK_SOURCE_MISSING" | "APP_LINK_SECRET_FAILED" | "APP_LINK_STATE_MISSING", message: string) { super(message); this.name = "DbWriterError"; }
}

/** 이 도착이 db_writer_json 길을 쓰나: 켬 + 복제 있음 + Terraform 실행 방식 + postgres 있음 */
export function dbWriterApplies(env: NodeJS.ProcessEnv, provider: Provider, spec: AppSpecV2, terraformRuntime: boolean): provider is ManagedProvider {
  return env.APP_LINK !== "0" && !!env.REPL_SOURCE_URL && terraformRuntime && (provider === "aws" || provider === "gcp")
    && spec.components.some((c) => c.kind === "postgres");
}

/** 출발 경로 (SOURCE_DB_LINK=real → 꽂힌 opener, 아니면 APP_LINK_SOURCE_URL). 못 얻으면 DbWriterError */
export async function sourceLinkFor(env: NodeJS.ProcessEnv, tenantId: string, migrationId: string): Promise<SourceLink> {
  if (env.SOURCE_DB_LINK === "real") {
    if (!opener) throw new DbWriterError("APP_LINK_SOURCE_MISSING", "SOURCE_DB_LINK=real but no source DB link opener is registered");
    return opener(tenantId, migrationId);
  }
  const raw = (env.APP_LINK_SOURCE_URL ?? "").trim();
  if (!raw) throw new DbWriterError("APP_LINK_SOURCE_MISSING", "no path from the target app to the source DB (SOURCE_DB_LINK=real or APP_LINK_SOURCE_URL)");
  let u: URL;
  try { u = new URL(raw); } catch { throw new DbWriterError("APP_LINK_SOURCE_MISSING", "APP_LINK_SOURCE_URL is not a URL"); }
  const user = decodeURIComponent(u.username), password = decodeURIComponent(u.password), dbName = u.pathname.replace(/^\//, "");
  if (!u.hostname || !user || !password || !dbName || raw.includes("{tf:"))
    throw new DbWriterError("APP_LINK_SOURCE_MISSING", "APP_LINK_SOURCE_URL needs user, password, host and database (postgres://<user>:<password>@<host>:<port>/<db>)");
  return { host: u.hostname, port: Number(u.port || 5432), user, password, dbName };
}

/** 이 apply 에 쓸 postgres IR id → 출발 경로. 복제는 이전마다 출발 DB 하나라(REPL_*) postgres 가 여럿이면 REPL_LINK_COMPONENT 로 고른다 */
export function linkTargets(env: NodeJS.ProcessEnv, spec: AppSpecV2): string[] {
  const pg = spec.components.filter((c) => c.kind === "postgres").map((c) => c.id);
  const pick = (env.REPL_LINK_COMPONENT ?? "").trim();
  if (pick) return pg.includes(pick) ? [pick] : [];
  return pg.length === 1 ? pg : [];
}

export interface WriterState { provider: ManagedProvider; secret: string; links: Record<string, SourceDbLinkRef>; active: DbWriter; projectId?: string; region?: string }
const stateFile = (env: NodeJS.ProcessEnv, tenant: string, migrationId: string) => join(workDirOf(workRootOf(env), migrationId, tenant), "db-writer.json");
export function saveWriterState(env: NodeJS.ProcessEnv, tenant: string, migrationId: string, s: WriterState): void {
  const f = stateFile(env, tenant, migrationId);
  mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 });
}
export function loadWriterState(env: NodeJS.ProcessEnv, tenant: string, migrationId: string): WriterState | null {
  const f = stateFile(env, tenant, migrationId);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as WriterState; } catch { return null; }
}

/** 이 apply 의 db_writer_json 변수 */
export const writerVar = (s: WriterState, spec: AppSpecV2, t: { envId: string; provider: Provider; region: string; migrationId: string; tenantId: string }, active: DbWriter) =>
  dbWriterVar(s.provider, spec, t, active, s.links);

export type SecretPut = (provider: ManagedProvider, name: string, password: string, o: { env: NodeJS.ProcessEnv; projectId?: string; region?: string }) => Promise<void>;

/** 비밀번호를 도착 비밀 그릇에 넣는다 (그릇이 없으면 만든다). 값은 stdin 으로만 넘긴다 */
export const putLinkSecret: SecretPut = async (provider, name, password, o) => {
  if (provider === "aws") {
    const body = JSON.stringify({ password });
    const reg = o.region ? ["--region", o.region] : [];
    const c = await run("aws", ["secretsmanager", "create-secret", "--name", name, "--secret-string", "file:///dev/stdin", ...reg], body, o.env);
    if (c.code === 0) return;
    if (!/ResourceExistsException/.test(c.stderr)) throw new DbWriterError("APP_LINK_SECRET_FAILED", `aws create-secret ${name}: ${c.stderr.slice(0, 200)}`);
    const p = await run("aws", ["secretsmanager", "put-secret-value", "--secret-id", name, "--secret-string", "file:///dev/stdin", ...reg], body, o.env);
    if (p.code !== 0) throw new DbWriterError("APP_LINK_SECRET_FAILED", `aws put-secret-value ${name}: ${p.stderr.slice(0, 200)}`);
    return;
  }
  const proj = o.projectId ? ["--project", o.projectId] : [];
  const c = await run("gcloud", ["secrets", "create", name, "--replication-policy=automatic", ...proj, "--quiet"], "", o.env);
  if (c.code !== 0 && !/already exists|ALREADY_EXISTS/i.test(c.stderr)) throw new DbWriterError("APP_LINK_SECRET_FAILED", `gcloud secrets create ${name}: ${c.stderr.slice(0, 200)}`);
  const v = await run("gcloud", ["secrets", "versions", "add", name, "--data-file=-", ...proj, "--quiet"], password, o.env);
  if (v.code !== 0) throw new DbWriterError("APP_LINK_SECRET_FAILED", `gcloud secrets versions add ${name}: ${v.stderr.slice(0, 200)}`);
};

/** 출발 전용 계정 비밀 그릇 지우기 (정리·도착 지우기 때). 없으면 그냥 넘어간다 */
export async function deleteLinkSecret(s: WriterState, env: NodeJS.ProcessEnv): Promise<void> {
  if (s.provider === "aws") {
    const r = await run("aws", ["secretsmanager", "delete-secret", "--secret-id", s.secret, "--force-delete-without-recovery", ...(s.region ? ["--region", s.region] : [])], "", env);
    if (r.code !== 0 && !/ResourceNotFoundException/.test(r.stderr)) throw new DbWriterError("APP_LINK_SECRET_FAILED", `aws delete-secret ${s.secret}: ${r.stderr.slice(0, 200)}`);
    return;
  }
  const r = await run("gcloud", ["secrets", "delete", s.secret, "--quiet", ...(s.projectId ? ["--project", s.projectId] : [])], "", env);
  if (r.code !== 0 && !/NOT_FOUND|not found/i.test(r.stderr)) throw new DbWriterError("APP_LINK_SECRET_FAILED", `gcloud secrets delete ${s.secret}: ${r.stderr.slice(0, 200)}`);
}

function run(cmd: string, args: string[], stdin: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += String(d); });
    p.on("error", (e) => resolve({ code: 127, stderr: e.message }));
    p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    p.stdin.end(stdin);
  });
}

/** apply 때: 출발 경로를 얻어 그릇에 비밀번호를 넣고, 상태 파일을 남기고, active=source 변수 값을 돌려준다 */
export async function prepareSourceWriter(i: { env: NodeJS.ProcessEnv; provider: ManagedProvider; spec: AppSpecV2; tenantId: string; tenant: string; migrationId: string;
  target: { envId: string; provider: Provider; region: string; migrationId: string }; projectId?: string; region?: string; put?: SecretPut; mock?: boolean }): Promise<{ var: string; state: WriterState }> {
  const ids = linkTargets(i.env, i.spec);
  if (!ids.length) throw new DbWriterError("APP_LINK_SOURCE_MISSING", "cannot tell which postgres component the source DB link is for (set REPL_LINK_COMPONENT)");
  const link = await sourceLinkFor(i.env, i.tenantId, i.migrationId);
  const t = { ...i.target, tenantId: i.tenant };
  const secret = dbLinkSecretName(i.provider, i.spec, t);
  if (!i.mock) await (i.put ?? putLinkSecret)(i.provider, secret, link.password, { env: i.env, projectId: i.projectId, region: i.region });
  const { password: _pw, ...ref } = link;
  const state: WriterState = { provider: i.provider, secret, links: Object.fromEntries(ids.map((id) => [id, ref])), active: "source",
    ...(i.projectId ? { projectId: i.projectId } : {}), ...(i.region ? { region: i.region } : {}) };
  saveWriterState(i.env, i.tenant, i.migrationId, state);
  return { var: writerVar(state, i.spec, t, "source"), state };
}
