import type { Provider, TfVars } from "@svc/contracts";

// Z77 DRAFT(ai): 도착 클라우드 DB 의 "네트워크 길" 변수 (데모 환경만). 결정 문서: parallel/Z77/DB-NETWORK-DECISION.md
// 기본은 아무것도 안 더한다 → 사설 DB 그대로, 계획 지문(tfPlanHash)도 예전과 똑같다.
// 켜는 환경변수 (worker 의 .env 에만 둔다):
//   DB_PUBLIC=1            도착 DB 에 공개 주소를 준다. 단 DB_PEER_CIDRS 와만 5432 로 주고받는다
//   DB_PEER_CIDRS=a/32,b/32 맥 공인 IP(+다른 클라우드 DB 의 나가는 IP). /24 보다 넓으면 거절, 0.0.0.0/0 거절
//   DB_DISPOSABLE=1        삭제 보호·마지막 스냅샷 끔 (그날 바로 파기하는 데모 DB 만)
// 출발이 맥일 때 정방향 구독 길(역방향 SSH 중계기)은 앱 모듈이 아니라 infra/modules/aws/demo-relay 를 사람이 따로 apply 한다
//   → 중계기 사설 IP/32 를 DB_PEER_CIDRS 에 넣으면 RDS 가 그쪽 5432 로 나갈 수 있다
// 계획 단계(plan.ts)와 apply 단계(apply-real.ts)가 같은 함수를 불러 지문에 넣는다.
//   → 승인 뒤에 .env 를 바꾸면 TF_PLAN_DRIFT 로 멈춘다 (승인한 사람이 본 것 = 만들어지는 것)
// 대안 "도착 Builder 에 항상 넣기" 는 버림: 기본값에서도 모든 계획 지문이 바뀌어 기존 승인·시험이 깨진다

export class DbNetworkError extends Error {
  readonly code = "DB_NETWORK_INVALID";
}

export interface DbNetworkSummary { public: boolean; peerCidrs: string[]; disposable: boolean }

const on = (v: string | undefined) => v === "1" || v === "true";
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** IPv4 CIDR 하나를 검사한다. 맞으면 null, 틀리면 이유 */
export function cidrProblem(c: string, minPrefix = 24): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(c);
  if (!m) return `${c}: IPv4 CIDR 모양이 아니다 (예: 203.0.113.7/32)`;
  if (m.slice(1, 5).some((x) => Number(x) > 255)) return `${c}: 숫자가 255 를 넘는다`;
  const prefix = Number(m[5]);
  if (prefix > 32) return `${c}: /32 보다 클 수 없다`;
  if (prefix < minPrefix) return `${c}: /${minPrefix} 보다 넓은 범위는 안 받는다 (데모는 맥 공인 IP /32 만)`;
  return null;
}

export function dbNetworkFromEnv(provider: Provider, env: NodeJS.ProcessEnv = process.env): { vars: TfVars; summary: DbNetworkSummary } | null {
  const pub = on(env.DB_PUBLIC), disposable = on(env.DB_DISPOSABLE);
  if (!pub && !disposable) return null;
  // Z38 REVIEW-5 Z77-1: 이 값은 워커 .env 전체에 걸린다. 같은 워커가 onprem·azure_mock 이전도 계획하므로
  //   거기서 던지면 DB_PUBLIC=1 을 켜는 순간 데모 A(onprem)·smoke-azure 계획이 전부 실패한다 → 클라우드 도착이 아니면 손대지 않는다
  if (provider !== "aws" && provider !== "gcp") return null;
  const peerCidrs = list(env.DB_PEER_CIDRS);
  const problems = peerCidrs.map((c) => cidrProblem(c)).filter((x): x is string => !!x);
  if (pub && !peerCidrs.length) problems.push("DB_PUBLIC=1 인데 DB_PEER_CIDRS 가 비었다 (맥에서 curl -s ifconfig.me 로 얻은 값/32)");
  if (problems.length) throw new DbNetworkError(problems.join("; "));

  const vars: TfVars = {};
  if (pub) {
    vars.db_public = true;
    vars.db_peer_cidrs_json = JSON.stringify(peerCidrs);
    // aws: RDS 를 공개하려면 DB 서브넷 묶음이 인터넷 게이트웨이로 가는 공개 서브넷이어야 한다 → env 모듈 출력 public_subnet_ids
    if (provider === "aws") vars.db_public_subnet_ids_json = "<env:dbPublicSubnetIdsJson>";
  }
  if (disposable) vars.db_deletion_protection = false;
  return { vars, summary: { public: pub, peerCidrs, disposable } };
}

/** TA11 DRAFT(ai): 설계 27번 3.5. 환경변수를 postgres_json 각 항목에 넣는다.
 *  아무것도 안 켰으면 같은 객체 그대로 (지문 안 바뀜). 잘못된 값은 DbNetworkError */
export function withDbNetworkV2<T extends { vars: TfVars }>(tf: T, provider: Provider, env: NodeJS.ProcessEnv = process.env): T {
  const n = dbNetworkFromEnv(provider, env);
  if (!n || typeof tf.vars.postgres_json !== "string") return tf;
  const items = (JSON.parse(tf.vars.postgres_json) as Array<Record<string, unknown>>).map((p) => ({
    ...p,
    ...(n.summary.public ? {
      public: true,
      peer_cidrs_json: JSON.stringify([...new Set([...(JSON.parse(String(p.peer_cidrs_json ?? "[]")) as string[]), ...n.summary.peerCidrs])].sort()),
      ...(provider === "aws" ? { public_subnet_ids_json: "<env:dbPublicSubnetIdsJson>" } : {}),
    } : {}),
    ...(n.summary.disposable ? { deletion_protection: false } : {}),
  }));
  return { ...tf, vars: { ...tf.vars, postgres_json: JSON.stringify(items) } };
}
