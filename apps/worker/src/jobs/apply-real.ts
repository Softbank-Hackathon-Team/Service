import type { AppSpec, PlanDoc, Provider, TfOutputs } from "@svc/contracts";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapterFor, createRealTerraformRunner, readImported, workRootOf, dbNetworkFromEnv, DbNetworkError, factEnvName, factsFromEnv, fillTfVars, withDbNetwork, type RealTerraformRunner } from "@svc/adapters";
import { appLinkFromEnv } from "@svc/dbproxy";
import { tenantSlug } from "../gitops/bundle.js";
import { stableHash } from "./_step.js";
import { envNumber } from "@svc/contracts";

// Z70 DRAFT(ai): apply 작업의 "진짜 terraform" 길. Z89: 기본이 이 길이다 (MOCK_IAC=1 인 시험만 흉내 길).
// apply.ts 는 이 함수 하나만 부른다.
//   ① 승인 뒤 바뀌었나: 계획 처리기와 같은 입력으로 toTerraform 을 다시 만들어 tfPlanHash 비교 (deploy 의 approvedValues 와 같은 생각)
//   ② "<env:키>" 자리표시 채우기: 환경 표 account_id + TF_FACT_* 환경변수. 하나라도 비면 apply 하지 않는다
//   ③ terraform init/plan/apply/output (실행기). 실패하면 failed, 작업 폴더를 detail 에 남긴다 → npm run tf:real -- destroy <이전 id>
//   ④ (선택, APP_LINK_TARGET_FROM_TF=1) 붙잡기 프록시의 target upstream 을 새 DB 주소로 바꾼다 (Z31 프록시 POST /upstream)

export interface RealApplyInput {
  migrationId: string; tenantId: string; envId: string;
  provider: Provider; accountId: string | null; spec: AppSpec; plan: PlanDoc;
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
}

export async function realApply(i: RealApplyInput, d: RealApplyDeps = {}): Promise<RealApplyOutcome> {
  const env = d.env ?? process.env;
  const base: Record<string, unknown> = { planId: i.plan.planId, provider: i.provider, real: true };
  // ① 계획 단계와 똑같은 대상 (plan.ts handlePlan: region "default", 추가 칸 없음)
  const target = { envId: i.envId, provider: i.provider, region: "default" };
  // Z77: 데모 DB 네트워크 변수(DB_PUBLIC 등)는 계획 단계와 같은 함수로 더한다 → 승인 뒤 .env 를 바꾸면 지문이 달라진다
  let tf; let dbNetwork: Record<string, unknown> | undefined;
  try {
    tf = withDbNetwork(adapterFor(i.provider).toTerraform(i.spec, target), i.provider, env);
    const n = dbNetworkFromEnv(i.provider, env);
    if (n) dbNetwork = { ...n.summary };
  } catch (e) {
    if (e instanceof DbNetworkError) return { ok: false, failureCode: e.code, detail: { ...base, error: e.message } };
    throw e;
  }
  if (dbNetwork) base.dbNetwork = dbNetwork; // 감사 기록에 "공개로 만들었다"가 남는다 (CIDR 은 맥 공인 IP, 비밀 아님)
  if (stableHash(tf) !== i.plan.tfPlanHash)
    return { ok: false, failureCode: "TF_PLAN_DRIFT", detail: { ...base, error: "승인한 Terraform 입력 지문과 지금 만든 지문이 다르다 (어댑터·명세가 승인 뒤 바뀜)" } };

  // ② 자리표시. deploy 의 envFacts 와 같은 규칙 (tenantId = tenantSlug, gcp projectId = account_id)
  const facts = factsFromEnv(env, {
    tenantId: tenantSlug(i.tenantId), migrationId: i.migrationId,
    accountId: i.provider === "aws" ? i.accountId ?? undefined : undefined,
    projectId: i.provider === "gcp" ? i.accountId ?? undefined : undefined,
  });
  // Z77: 클러스터 없이(TF_FACT_CLUSTER_NAME="")는 aws 만. gcp 앱 모듈은 GKE 조회가 필수라 빈 값이면 모자란 사실로 본다
  if (facts.clusterName === "" && i.provider !== "aws")
    return { ok: false, failureCode: "TF_FACTS_MISSING", detail: { ...base, missing: ["TF_FACT_CLUSTER_NAME"], error: "클러스터 없이 만들기는 aws 도착만" } };
  const noCluster = facts.clusterName === "";
  const filled = fillTfVars(tf.vars, facts);
  if (filled.missing.length)
    return { ok: false, failureCode: "TF_FACTS_MISSING", detail: { ...base, missing: filled.missing.map(factEnvName) } };

  // ③ 실행
  const runner = d.runner ?? createRealTerraformRunner({ env });
  // Z89 (Z62 주제 57): 가져오기가 이미 찾은 도착 자원이면 만들지 않고 그 출력으로 넘어간다 ("이미 있음")
  const imported = readImported(workRootOf(env), i.migrationId, tenantSlug(i.tenantId));
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
  const r = await runner.apply(i.provider, i.migrationId, filled.vars, d.signal, tenantSlug(i.tenantId));
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
  const tfOutputs: TfOutputs = { ...(facts.clusterName !== undefined ? { cluster_name: facts.clusterName } : {}), ...r.tfOutputs };

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
    } catch (e) { return { url: u, ok: false, error: (e as Error).message.slice(0, 120) }; }
  }));
}
