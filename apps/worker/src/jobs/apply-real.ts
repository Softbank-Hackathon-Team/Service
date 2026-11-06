import type { AppSpecV2, PlanDoc, Provider, TfOutputs } from "@svc/contracts";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRealTerraformRunner, envFor, dbNetworkFromEnv, DbNetworkError, factEnvName, fillTfVars, flattenTfOutputsV2, gcpTerraformEnv, withReplicationNetworkV2, type GcpTerraformCred, type RealTerraformRunner } from "@svc/adapters";
import { loadReplNetwork, peerCidrsOf } from "../repl-network.js";
import { tfCallV2 } from "./plan-v2.js";
import { specV2ForPlan, terraformRuntimeOf } from "@svc/adapters";
import { latestAcceptedSpecV2, loadLatestApproval, loadPlanById } from "@svc/core";
import { DbWriterError, dbWriterApplies, loadWriterState, prepareSourceWriter, saveWriterState, writerVar, type ManagedProvider, type SecretPut } from "../db-writer.js";
import { factsDrift, importedFor, mergedFactsOf, targetFactsOf } from "./plan-facts.js";
import { ensureEnvLayer, readEnvLayer, type EnsureEnvLayerDeps } from "../env-layer.js";
import { factsOfLayer, regionOf } from "@svc/adapters";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";
import { gcpPlatformSa } from "../platform.js";
import { appLinkFromEnv } from "@svc/dbproxy";
import { tenantSlug } from "../gitops/bundle.js";
import { stableHash } from "./_step.js";
import { envNumber, redactText } from "@svc/contracts";

// Z70 DRAFT(ai): apply 작업의 "진짜 terraform" 길. Z89: 기본이 이 길이다 (MOCK_IAC=1 인 시험만 흉내 길).
// apply.ts 는 이 함수 하나만 부른다.
//   ① 승인 뒤 바뀌었나: 계획 처리기와 같은 입력으로 Terraform 루트 호출을 다시 만들어 tfPlanHash 비교 (deploy 의 approvedValues 와 같은 생각)
//   ② "<env:키>" 자리표시 채우기: 환경 표 account_id + TF_FACT_* 환경변수. 하나라도 비면 apply 하지 않는다
//   ③ terraform init/plan/apply/output (실행기). 실패하면 failed, 작업 폴더를 detail 에 남긴다 → npm run tf:real -- destroy <이전 id>
//   ④ (선택, APP_LINK_TARGET_FROM_TF=1) 붙잡기 프록시의 target upstream 을 새 DB 주소로 바꾼다 (Z31 프록시 POST /upstream)

export interface RealApplyInput {
  migrationId: string; tenantId: string; envId: string;
  provider: Provider; accountId: string | null; spec: AppSpecV2; plan: PlanDoc;
  /** 환경 층 DB 사실 (ready 줄, ensureEnvLayer·loadReapplyInput 이 채움). 있으면 TF_FACT_* 보다 먼저. 없으면 예전 그대로 */
  envLayer?: { facts: Record<string, string>; varsHash: string } | null;
}
export type RealApplyOutcome =
  | { ok: true; tfOutputs: TfOutputs; detail: Record<string, unknown> }
  | { ok: false; failureCode: string; detail: Record<string, unknown> };

// DRAFT(ai): 도착 DB 주소가 들어 있는 출력 이름 (infra/modules/<환경>/app 의 output). onprem 은 차트 CNPG 라 없음
export const DB_ADDR_OUTPUT: Partial<Record<Provider, string>> = { aws: "db_address", gcp: "db_private_ip" };

export interface RealApplyDeps {
  env?: NodeJS.ProcessEnv;
  runner?: Pick<RealTerraformRunner, "apply">;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  // L5b: 빌린 자격 env (borrowedAwsCreds().env). 있으면 실행기 env 에서 워커 자기 자격(AWS_PROFILE·키)을 지우고 이것만 덮는다
  credEnv?: Record<string, string>;
  // 빌린 GCP 토큰. 있으면 Terraform·gcloud 가 워커 자기 자격 대신 이것만 쓴다 (gcp-token-server.ts)
  gcpCred?: GcpTerraformCred;
  /** APP-22: 출발 전용 계정 비밀번호를 도착 그릇에 넣기 (시험이 가짜로 바꿈) */
  putSecret?: SecretPut;
  /** 회사 전용 플랫폼 SA 이름 (시험이 가짜로 바꿈) */
  gcpPlatformSa?: (tenantId: string) => Promise<string | undefined>;
}

// Argo CD 허브가 고객 GKE 에 들어오는 신원. 회사 사실이라 계획 지문 밖에 두고 apply 때 더한다 (db_writer_json 과 같은 자리).
// 비면 앱 구역에 허브 권한을 안 만든다. 그러면 허브 배포가 거절되어 Argo 상태로 드러난다
async function hubPrincipalVar(i: RealApplyInput, env: NodeJS.ProcessEnv, d: RealApplyDeps): Promise<Record<string, string>> {
  const project = env.GCP_PLATFORM_PROJECT?.trim();
  if (i.provider !== "gcp" || !project) return {};
  const sa = await (d.gcpPlatformSa ?? gcpPlatformSa)(i.tenantId);
  return sa ? { hub_principal: `${sa}@${project}.iam.gserviceaccount.com` } : {};
}

/** 실행기 환경: 빌린 GCP 토큰 > 빌린 AWS 자격 > 워커 환경 */
export function runnerOpts(d: Pick<RealApplyDeps, "credEnv" | "gcpCred">, env: NodeJS.ProcessEnv) {
  const cred = d.gcpCred;
  if (cred) return { env: gcpTerraformEnv(cred, env), secretEnv: () => gcpTerraformEnv(cred, env) };
  return { env: d.credEnv ? envFor(d.credEnv, env) : env };
}

interface Prepared {
  env: NodeJS.ProcessEnv; base: Record<string, unknown>; target: { envId: string; provider: Provider; region: string; migrationId: string };
  imp: ReturnType<typeof importedFor>; facts: Record<string, string>; noCluster: boolean; vars: Record<string, unknown>;
}
/** ①② 계획과 같은 입력 다시 만들기 → 지문·사실 대조 → 자리표시 채우기. apply 와 APP-22 다시 apply 가 같이 쓴다 */
async function prepare(i: RealApplyInput, d: RealApplyDeps): Promise<Prepared | Extract<RealApplyOutcome, { ok: false }>> {
  const env = d.env ?? process.env;
  const base: Record<string, unknown> = { planId: i.plan.planId, provider: i.provider, real: true };
  // ① 계획 단계와 똑같은 대상 (plan.ts buildPlanDoc: region "default" + G8-1 이름 seed 인 migrationId)
  const target = { envId: i.envId, provider: i.provider, region: "default", migrationId: i.migrationId };
  // Z77: 데모 DB 네트워크 변수(DB_PUBLIC 등)는 계획 단계와 같은 함수로 더한다 → 승인 뒤 .env 를 바꾸면 지문이 달라진다
  let tf; let dbNetwork: Record<string, unknown> | undefined;
  try {
    tf = tfCallV2(i.spec, target, env);
    const n = dbNetworkFromEnv(i.provider, env);
    if (n) dbNetwork = { ...n.summary };
  } catch (e) {
    if (e instanceof DbNetworkError) return { ok: false, failureCode: e.code, detail: { ...base, error: e.message } };
    throw e;
  }
  if (dbNetwork) base.dbNetwork = dbNetwork; // 감사 기록에 "공개로 만들었다"가 남는다 (CIDR 은 맥 공인 IP, 비밀 아님)
  if (stableHash(tf) !== i.plan.tfPlanHash)
    return { ok: false, failureCode: "TF_PLAN_DRIFT", detail: { ...base, error: "승인한 Terraform 입력 지문과 지금 만든 지문이 다르다 (어댑터·명세가 승인 뒤 바뀜)" } };

  // G7-3·G7-4: 사람이 본 도착 사실(계정·VPC·클러스터)·재사용 여부가 지금과 같은가. 다르면 만들지 않는다
  const imp = importedFor(env, i.migrationId, i.tenantId);
  const drift = factsDrift(i.plan, targetFactsOf(tf.vars, env, i.provider, i.accountId, i.envLayer?.facts), imp, i.envLayer);
  if (drift) return { ok: false, failureCode: "TF_PLAN_DRIFT", detail: { ...base, error: drift } };

  // ② 자리표시. deploy 의 envFacts 와 같은 규칙 (tenantId = tenantSlug, gcp projectId = account_id)
  //   환경 층 DB 사실(ready)이 있으면 TF_FACT_* 보다 먼저 (mergedFactsOf = plan·apply·reapply 같은 규칙)
  const facts = mergedFactsOf(env, i.provider, i.accountId, i.envLayer?.facts, { tenantId: tenantSlug(i.tenantId), migrationId: i.migrationId });
  // Z77: 클러스터 없이(TF_FACT_CLUSTER_NAME="")는 aws 만. gcp 앱 모듈은 GKE 조회가 필수라 빈 값이면 모자란 사실로 본다
  if (facts.clusterName === "" && i.provider !== "aws")
    return { ok: false, failureCode: "TF_FACTS_MISSING", detail: { ...base, missing: ["TF_FACT_CLUSTER_NAME"], error: "클러스터 없이 만들기는 aws 도착만" } };
  const noCluster = facts.clusterName === "";
  const filled = fillTfVars(tf.vars, facts);
  if (filled.missing.length)
    return { ok: false, failureCode: "TF_FACTS_MISSING", detail: { ...base, missing: filled.missing.map(factEnvName) } };
  // 중계기 이전(aws-gcp)의 도착 DB 복제 길 (relay-step 이 작업 폴더 repl-network.json 에 둠): 복제 전용 공개 주소 + 허용 주소(플랫폼 나가는 대역·
  //   중계 공개 IP) + 앱 로그인은 SQL. 앱이 붙는 주소(link.host)는 사설 IP 그대로. 중계 IP 는 apply 때 생겨서 계획 지문 밖 (hub_principal·db_writer_json 과 같은 자리). 컷오버·롤백의 다시 apply 도 같은 파일을 읽는다
  let vars = filled.vars;
  const rn = i.provider === "gcp" ? loadReplNetwork(env, tenantSlug(i.tenantId), i.migrationId) : null;
  if (rn) {
    const peerCidrs = peerCidrsOf(rn);
    try { vars = withReplicationNetworkV2({ vars }, { peerCidrs, appLoginSql: rn.appLoginSql }).vars; }
    catch (e) { if (e instanceof DbNetworkError) return { ok: false, failureCode: e.code, detail: { ...base, error: e.message } }; throw e; }
    base.replicationNetwork = { replPublic: true, peerCidrs, relayIp: rn.relayIp, appLoginSql: rn.appLoginSql };
  }

  return { env, base, target, imp, facts, noCluster, vars: { ...(vars as Record<string, unknown>), ...(await hubPrincipalVar(i, env, d)) } };
}

export async function realApply(i: RealApplyInput, d: RealApplyDeps = {}): Promise<RealApplyOutcome> {
  const p = await prepare(i, d);
  if ("ok" in p) return p;
  const { env, base, imp, facts, noCluster } = p;
  // APP-22 (가) DECISION(team): Terraform 이 앱을 띄우는 도착은 컷오버 전까지 출발 DB 에 붙게 띄운다 (db_writer_json active=source)
  let vars = p.vars;
  if (!imp && dbWriterApplies(env, i.provider, i.spec, !!terraformRuntimeOf(i.spec))) {
    try {
      const w = await prepareSourceWriter({ env: runnerOpts(d, env).env, provider: i.provider as ManagedProvider, spec: i.spec, tenantId: i.tenantId, tenant: tenantSlug(i.tenantId),
        migrationId: i.migrationId, target: p.target, projectId: i.provider === "gcp" ? i.accountId ?? facts.projectId : undefined,
        region: typeof vars.region === "string" ? vars.region : undefined, put: d.putSecret });
      vars = { ...vars, db_writer_json: w.var };
      base.dbWriter = { active: "source", components: Object.keys(w.state.links), secret: w.state.secret };
    } catch (e) {
      if (e instanceof DbWriterError) return { ok: false, failureCode: e.code, detail: { ...base, error: e.message } };
      throw e;
    }
  }
  const filled = { vars };
  // ③ 실행
  const runner = d.runner ?? createRealTerraformRunner(runnerOpts(d, env));
  // Z89 (Z62 주제 57): 가져오기가 이미 찾은 도착 자원이면 만들지 않고 그 출력으로 넘어간다 ("이미 있음")
  const imported = imp;
  if (imported) {
    // Z89-03: 복제 끝점 {tf:키} 는 outputs.json(+db-secret.json)을 읽는다 → imported 출력도 outputs.json 으로 남긴다.
    //   비밀번호(db-secret.json)는 imported.json 에 넣지 않는다: 가져온 쪽이 같은 폴더에 0600 파일로 따로 둔다
    writeFileSync(join(dirname(imported.file), "outputs.json"), JSON.stringify(imported.tfOutputs, null, 2), { mode: 0o600 });
    return { ok: true, tfOutputs: { ...(facts.clusterName !== undefined ? { cluster_name: facts.clusterName } : {}), ...imported.tfOutputs },
             detail: { ...base, imported: true, source: imported.source, resources: imported.resources, file: imported.file,
                       outputs: Object.keys(imported.tfOutputs).sort(),
                       dbSecret: existsSync(join(dirname(imported.file), "db-secret.json")) } };
  }
  // Z89: state 는 회사별 폴더 (<TF_WORK_DIR>/<회사 slug>/<이전>). 다른 회사 state 와 같은 폴더를 쓸 길이 없다
  const r = await runner.apply(i.provider, i.migrationId, filled.vars as never, d.signal, tenantSlug(i.tenantId));
  const runDetail = { workDir: r.workDir, steps: r.steps, elapsedMs: r.elapsedMs, log: r.log, secretFetched: r.secretFetched ?? false };
  if (!r.ok) {
    // Z89: init 이 127(실행 파일 없음)이면 따로 알린다 — 화면에서 "terraform 설치/ MOCK_IAC" 가 바로 보이게
    const binMissing = r.failedStep === "init" && r.steps.at(-1)?.code === 127;
    // apply 실패 뒤 자동 destroy 가 성공했으면 남은 자원 없음 → 정리 명령 대신 그 사실을 남긴다
    const cleaned = r.destroyedAfterFail?.ok === true;
    return { ok: false, failureCode: binMissing ? "TF_BIN_MISSING" : "TF_APPLY_FAILED", detail: { ...base, ...runDetail, failedStep: r.failedStep,
      ...(r.destroyedAfterFail ? { destroyedAfterFail: r.destroyedAfterFail } : {}),
      ...(cleaned || binMissing || r.failedStep === "init" || r.failedStep === "plan" ? {} : { cleanup: `npm run tf:real -- destroy ${i.migrationId}` }) } };
  }
  // cluster_name 은 app 모듈 출력이 아니라 env 모듈 사실 → 채워 둔다 (STUB 표와 같은 이름)
  // Z77: 클러스터 없이 만든 경우 cluster_name = "" 를 그대로 남긴다 → deploy 단계가 이 값을 보고 STUB 로 넘긴다
  // TA3: 루트 출력의 맵(link_outputs·identity_*)은 자리표시 키(link.<id>.<출력>)로 펼쳐 둔다
  const raw: TfOutputs = { ...(facts.clusterName !== undefined ? { cluster_name: facts.clusterName } : {}), ...r.tfOutputs };
  const tfOutputs: TfOutputs = flattenTfOutputsV2(raw);

  // ④ 앱 DB 연결의 도착 주소
  let appLink: Record<string, unknown> | undefined;
  if (env.APP_LINK_TARGET_FROM_TF === "1") {
    const key = DB_ADDR_OUTPUT[i.provider];
    const host = key ? tfOutputs[key] : undefined;
    const cfg = appLinkFromEnv(env);
    if (!cfg || !host) appLink = { skipped: !cfg ? "no_app_link_urls" : "no_db_address" };
    else {
      const port = envNumber(env.APP_LINK_TARGET_PORT, 5432);
      const res = await setTargetUpstream(cfg.urls, host, port, cfg.token, d.fetch ?? fetch, cfg.timeoutMs);
      appLink = { upstream: "target", host, port, results: res };
      if (res.some((x) => !x.ok))
        return { ok: false, failureCode: "APP_LINK_UPSTREAM_FAILED", detail: { ...base, ...runDetail, appLink,
          cleanup: `npm run tf:real -- destroy ${i.migrationId}` } };
    }
  }
  return { ok: true, tfOutputs, detail: { ...base, ...runDetail, outputs: Object.keys(tfOutputs).sort(), ...(appLink ? { appLink } : {}),
    ...(noCluster ? { noCluster: true } : {}) } };
}

/** apply 작업의 진짜 길: ① 환경 층 확보(ensureEnvLayer, apply 맨 앞 = 승인 뒤 provisioning 에서만) → ② 앱 층 realApply (환경 층 사실을 씀).
 *  reapplyDbWriter(컷오버·롤백)는 이 함수를 거치지 않는다 → 그때 GKE 를 만들 일이 없다.
 *  B-2: 환경 층은 d.gcpCred(svc-operate)를 쓰지 않는다. d.envLayer.withEnvCred 가 그 단계에서만 svc-env 를 빌린다 */
export async function realApplyWithEnvLayer(i: RealApplyInput, d: RealApplyDeps & { envLayer?: Omit<EnsureEnvLayerDeps, "signal" | "env"> } = {}): Promise<RealApplyOutcome> {
  const el = await ensureEnvLayer({ tenantId: i.tenantId, migrationId: i.migrationId, envId: i.envId, provider: i.provider, projectId: i.accountId,
    region: regionOf({ envId: i.envId, provider: i.provider, region: "default" }), plan: i.plan },
    { ...d.envLayer, ...(d.env ? { env: d.env } : {}), ...(d.signal ? { signal: d.signal } : {}) });
  if (!el.ok) return { ok: false, failureCode: el.failureCode, detail: { planId: i.plan.planId, provider: i.provider, real: true, ...el.detail } };
  const out = await realApply({ ...i, ...(el.layer ? { envLayer: el.layer } : {}) }, d);
  return el.source === "db" ? { ...out, detail: { ...out.detail, envLayer: el.detail } } : out;
}

/** APP-22 (가) DECISION(team): Terraform 이 앱을 띄우는 도착의 앱 DB 주소 바꾸기 = db_writer_json active 만 바꿔 같은 입력으로 다시 apply.
 *  컷오버(C6 뒤) = target, 컷오버 뒤 롤백 = source. 경로 사실은 apply 때 남긴 db-writer.json (비밀번호는 그릇에 이미 있음).
 *  흉내 판(MOCK_IAC=1)은 apply 를 안 돌리고 상태 파일만 바꾼다 */
export async function reapplyDbWriter(i: RealApplyInput, writer: "source" | "target", d: RealApplyDeps & { mock?: boolean } = {}):
    Promise<{ ok: true; active: "source" | "target"; mock?: boolean; elapsedMs?: number } | { ok: false; failureCode: string; error: string; workDir?: string }> {
  const env = d.env ?? process.env, tenant = tenantSlug(i.tenantId);
  const st = loadWriterState(env, tenant, i.migrationId);
  if (!st) return { ok: false, failureCode: "APP_LINK_STATE_MISSING", error: "db-writer.json not found in the migration work dir (apply did not set up the source DB link)" };
  if (d.mock) { saveWriterState(env, tenant, i.migrationId, { ...st, active: writer }); return { ok: true, active: writer, mock: true }; }
  const p = await prepare(i, d);
  if ("ok" in p) return { ok: false, failureCode: p.failureCode, error: String((p.detail as { error?: unknown }).error ?? p.failureCode) };
  const vars = { ...p.vars, db_writer_json: writerVar(st, i.spec, { ...p.target, tenantId: tenant }, writer) };
  const runner = d.runner ?? createRealTerraformRunner(runnerOpts(d, env));
  const r = await runner.apply(i.provider, i.migrationId, vars as never, d.signal, tenant, { keepOnFail: true });
  if (!r.ok) return { ok: false, failureCode: "APP_LINK_REAPPLY_FAILED", error: `terraform ${r.failedStep ?? "apply"} failed`, workDir: r.workDir };
  saveWriterState(env, tenant, i.migrationId, { ...st, active: writer });
  return { ok: true, active: writer, elapsedMs: r.elapsedMs };
}

/** 다시 apply 에 쓸 입력 (승인한 계획서·받아들인 최신 명세·도착 환경). 없으면 null */
export async function loadReapplyInput(tx: { query: (sql: string, args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    m: { id: string; tenantId: string; targetEnvId: string }): Promise<RealApplyInput | null> {
  const ap = await loadLatestApproval(tx as never, m.id);
  const plan = ap ? await loadPlanById(tx as never, ap.planId) : null;
  const row = await latestAcceptedSpecV2(tx as never, m.id);
  const spec = row ? specV2ForPlan(row) : null;
  // apply 와 같은 도착 계정 규칙 (A안: GCP = gcp_target_project). 예전엔 account_id 라 전용 프로젝트 환경에서 다시 apply 가 TF_PLAN_DRIFT 였다
  const e = await tx.query(`SELECT provider, ${TARGET_ACCOUNT_SQL} AS account_id FROM environments WHERE id=$1`, [m.targetEnvId]);
  if (!plan || !spec || !e.rows[0]) return null;
  // 환경 층으로 만든 도착이면 다시 apply 도 같은 사실로 (없으면 TF_FACTS_MISSING). 여기서는 읽기만, 만들지 않는다
  const layer = e.rows[0].provider === "gcp" ? await readEnvLayer(tx as never, m.targetEnvId) : null;
  return { migrationId: m.id, tenantId: m.tenantId, envId: m.targetEnvId, provider: e.rows[0].provider as Provider,
           accountId: (e.rows[0].account_id as string | null) ?? null, spec, plan,
           ...(layer?.status === "ready" && layer.facts ? { envLayer: { facts: factsOfLayer(layer.facts), varsHash: layer.varsHash } } : {}) };
}

async function setTargetUpstream(urls: string[], host: string, port: number, token: string | undefined, f: typeof fetch, timeoutMs: number) {
  return Promise.all(urls.map(async (u) => {
    try {
      const r = await f(`${u}/upstream`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name: "target", host, port }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { url: u, ok: r.ok, status: r.status };
    } catch (e) { return { url: u, ok: false, error: redactText((e as Error).message).slice(0, 120) }; }   // RV-16
  }));
}
