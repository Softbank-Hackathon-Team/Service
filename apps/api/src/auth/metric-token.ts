import { createHash, randomBytes } from "node:crypto";
import { pool } from "@svc/core";
import { METRIC_TOKEN_PREFIX } from "@svc/contracts";

// 환경별 지표 토큰. 원문 = "svc_mt_" + 무작위 32바이트(base64url). DB 에는 sha256 hex 만
export const hashMetricToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newMetricToken = () => `${METRIC_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
export const isMetricTokenShape = (token: string) =>
  token.startsWith(METRIC_TOKEN_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(METRIC_TOKEN_PREFIX.length));

export interface MetricTokenOwner { tenantId: string; envId: string }
// 해시로 찾기. 게이트웨이는 회사 번호를 모르므로 SECURITY DEFINER 함수(0035 metric_token_lookup)로만 찾는다
export type MetricTokenLookup = (hash: string) => Promise<MetricTokenOwner | undefined>;
export const dbMetricTokenLookup: MetricTokenLookup = async (hash) => {
  const r = (await pool.query("SELECT * FROM metric_token_lookup($1)", [hash])).rows[0];
  return r ? { tenantId: r.tenant_id, envId: r.env_id } : undefined;
};
