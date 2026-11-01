import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { IdParam } from "./kit.js";
import { withTenant, type Tx } from "@svc/core";
import { LiveSecurityReport } from "@svc/contracts";
import type { ExecRunner, LiveTarget } from "@svc/security";
import { buildSecurityView, type SecurityInput } from "../security/build.js";
import { loadConfig, loadFileInputs, loadSecurityDb } from "../security/load.js";
import { liveReports, loadLiveTargets, recordLiveChecks } from "../security/live.js";
import { SecurityView } from "../security/schema.js";
import { ApiError, SecurityRegression } from "@svc/contracts";
import { buildRegression, loadRegressionDb, type RegressionInput } from "../security/regression.js";

export interface SecurityRouteOpts {
  // 시험에서 DB 없이 경로를 돌리려고 재료 읽기를 바꿔 끼울 수 있게 했다. 기본은 DB + 파일 + 환경 변수
  load?: (tenantId: string, migrationId: string) => Promise<SecurityInput>;
  // Z91: 실제 점검 재료(출발·도착 환경 + terraform 출력)와 명령 실행기. 시험은 가짜 실행기를 끼운다
  liveTargets?: (tenantId: string, migrationId: string) => Promise<LiveTarget[]>;
  run?: ExecRunner;
  env?: NodeJS.ProcessEnv;
  record?: (tenantId: string, actor: string, migrationId: string, reports: LiveSecurityReport[]) => Promise<void>;
  // Z95: 보안 회귀 재료 읽기. 기본은 withTenant 안에서 감사의 마지막 security.live_check 를 쪽마다
  loadRegression?: (tenantId: string, migrationId: string) => Promise<Omit<RegressionInput, "now">>;
  now?: () => Date;
}

const defaultLoad = async (tenantId: string, id: string): Promise<SecurityInput> => {
  const db = await withTenant(tenantId, (tx: Tx) => loadSecurityDb(tx, id));
  return { ...db, ...loadFileInputs(), config: loadConfig() };
};
const defaultTargets = (tenantId: string, id: string) => withTenant(tenantId, (tx: Tx) => loadLiveTargets(tx, id));
const defaultRecord = (tenantId: string, actor: string, id: string, reports: LiveSecurityReport[]) =>
  withTenant(tenantId, (tx: Tx) => recordLiveChecks(tx, tenantId, actor, id, reports));

export const LiveCheckResult = z.object({
  migrationId: z.string(),
  source: LiveSecurityReport.nullable(),
  target: LiveSecurityReport.nullable(),
  recorded: z.boolean(),
}).strict();

// 이전 한 건의 보안 표. 읽기 전용이라 상태를 바꾸지 않고 감사도 남기지 않는다
// 응답에 비밀값·계정 번호·ExternalId 값은 없다 (있나 없나만)
// Z91: live = 출발·도착 실제 점검 (60초 기억). 클라우드 쓰기 명령은 실행기가 막는다
export async function securityRoutes(app: FastifyInstance, opts: SecurityRouteOpts = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? defaultLoad;
  // load 만 바꿔 끼운 시험(DB 없음)은 실제 점검 대상도 없다고 본다 → live = []
  const targets = opts.liveTargets ?? (opts.load ? async () => [] : defaultTargets);
  const record = opts.record ?? defaultRecord;
  const loadReg = opts.loadRegression
    ?? ((tenantId: string, id: string) => withTenant(tenantId, (tx: Tx) => loadRegressionDb(tx, id)));
  const now = opts.now ?? (() => new Date());

  r.get("/migrations/:id/security", {
    schema: { params: IdParam, response: { 200: SecurityView } },
  }, async (req, reply) => {
    const view = buildSecurityView(await load(req.tenantId, req.params.id));
    const live = await liveReports(await targets(req.tenantId, req.params.id),
      { run: opts.run, env: opts.env, key: `${req.tenantId}:${req.params.id}` });
    reply.header("cache-control", "no-store");
    return { ...view, live };
  });

  // Z91: 지금 출발·도착을 다시 점검하고 감사에 남긴다 (security.live_check, side 별 한 줄).
  // 보안 회귀(Z95 GET …/security/regression)는 이 스냅숏을 비교한다 → 출발 환경을 지우기 전에 한 번 눌러 두면 된다
  r.post("/migrations/:id/security/check", {
    schema: { params: IdParam, response: { 200: LiveCheckResult } },
  }, async (req, reply) => {
    const t = await targets(req.tenantId, req.params.id);
    const live = await liveReports(t, { run: opts.run, env: opts.env, key: `${req.tenantId}:${req.params.id}`, fresh: true });
    if (live) await record(req.tenantId, req.actor, req.params.id, live);
    reply.header("cache-control", "no-store");
    return { migrationId: req.params.id, source: live?.find((x) => x.side === "source") ?? null,
      target: live?.find((x) => x.side === "target") ?? null, recorded: !!live };
  });

  // Z95: 보안 회귀. 출발·도착 실점검 스냅숏을 열쇠별로 비교해 나빠짐·좋아짐·같음·비교 불가를 낸다.
  // 읽기 전용: 새로 점검하지 않는다 (점검은 위 POST …/security/check). 테넌트 RLS 안에서 읽고, 감사도 안 남긴다
  r.get("/migrations/:id/security/regression", {
    schema: { params: IdParam, response: { 200: SecurityRegression, 404: ApiError } },
  }, async (req, reply) => {
    const out = buildRegression({ ...(await loadReg(req.tenantId, req.params.id)), now: now() });
    reply.header("cache-control", "no-store");
    return out;
  });
}
