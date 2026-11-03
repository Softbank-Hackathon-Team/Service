import type { LinkV2, PostureV2, UnmappedV2 } from "@svc/contracts";
import type { MappedComponent } from "../types.js";

// DRAFT(ai): 출발 AWS IAM 정책 → 의존성 근거(grants) + 보안 기준선(posture.permissions) (설계 20번 4.3(나)·(다), PoC inferLinks 규칙 2).
//   - grants = 출발 IAM 문장 원문. 의도(intent)는 요약일 뿐, 모듈은 grants 를 같은 범위로 옮긴다 ("같은 크기" 원칙)
//   - 근거 정책은 앱 신원(Pod Identity association · IRSA 역할)에 붙은 것. 같은 네임스페이스 + 같은 ServiceAccount 를 쓰는 워크로드 전부에 붙인다
//   - 대상에는 그 대상 서비스의 동작만 (s3 대상에 sqs 동작 안 붙음). 계정 단위 동작(ListAllMyBuckets 등)은 대상 근거가 아님 → 기준선에만
//   - Deny·NotAction·NotResource 는 의존성으로 안 바꾸고 원문 그대로 기준선에 (빠뜨리면 도착이 출발보다 넓어진다)
//   - Resource "*" 만으로 덮인 대상은 다른 근거로 이미 이어진 의존성에만 grants 를 붙인다 (* 하나로 모든 자원에 의존성을 만들지 않음)
//   - 신뢰도: IAM 근거 = 1, 조건(Condition) 있는 Allow = 0.9 + "같은 조건으로 옮겨야 함"
//   순수 함수. 같은 입력 → 같은 출력 (목록 정렬)

/** 원본 항목: discover(aws-iam.ts) 가 신원 하나(역할 하나)마다 하나 만든다 */
export interface RawAwsIamPolicy {
  kind: "aws.iamPolicy";
  roleName: string;
  serviceAccount: string;
  namespace?: string;
  source?: "pod-identity" | "irsa";
  policies?: string[];              // 붙은 정책 이름 (관리형 ARN · 인라인 이름). 근거 표시용
  statements: unknown;              // IAM Statement 배열 (문자열 하나·객체 하나도 받는다)
}

type Intent = LinkV2["intent"];
type Grant = NonNullable<LinkV2["grants"]>[number];
export type PermissionV2 = PostureV2["permissions"][number];

const arr = <T = string>(x: unknown): T[] => (x == null ? [] : Array.isArray(x) ? (x as T[]) : [x as T]);   // IAM 은 문자열 하나도 허용

// 동작 이름 → 의도 요약. 못 묶으면 null (grants 원문으로 옮기고 readwrite + 검토)
const IAM_INTENT: Array<[RegExp, Intent]> = [
  [/^s3:\*$/, "admin"], [/^s3:(Get|List)/, "read"], [/^s3:(Put|Delete|Abort|Restore)/, "write"],
  [/^sqs:\*$/, "admin"], [/^sqs:SendMessage/, "write"], [/^sqs:(ReceiveMessage|DeleteMessage|ChangeMessageVisibility)/, "read"], [/^sqs:Get/, "read"],
  [/^elasticache:\*$/, "admin"], [/^rds:\*$/, "admin"],
];
const merge = (a: Intent | null, b: Intent | null): Intent | null =>
  !a ? b : !b ? a : a === b ? a : a === "admin" || b === "admin" ? "admin" : "readwrite";

// 특정 자원이 아니라 계정에 거는 동작. 대상 의존성의 근거가 아니다 (기준선에만 남음)
const ACCOUNT_LEVEL = /^(s3:(ListAllMyBuckets|CreateBucket|GetAccountPublicAccessBlock|PutAccountPublicAccessBlock)|sqs:ListQueues|elasticache:Describe|rds:Describe)/;

// 원본 종류(native.type) → ARN 서비스 이름. I6 의 DATA_RAW_KINDS(s3.bucket·sqs.queue·elasticache.replicationGroup)와 같은 이름
// DRAFT(ai): RDS IAM DB 인증(rds-db:connect)은 자원 ARN 이 리소스 ID(db-XXXX) 라 이름으로 못 맞춤 → 기준선(IR 밖 자원)으로 남김
export const ARN_SERVICE_BY_TYPE: Readonly<Record<string, string>> = {
  "rds.dbInstance": "rds", "s3.bucket": "s3", "sqs.queue": "sqs", "elasticache.replicationGroup": "elasticache",
};

/** ARN 풀기: arn:aws:<service>:<region>:<account>:<resource>. 이름 칸은 서비스마다 다르다 */
export function parseArn(r: string): { service: string; name: string; path: string } {
  if (r === "*") return { service: "*", name: "*", path: "" };
  const p = String(r).split(":");
  if (p[0] !== "arn" || p.length < 6) return { service: "?", name: r, path: "" };
  const service = p[2]!, rest = p.slice(5).join(":");
  const name = service === "s3" ? rest.split("/")[0]!
    : service === "rds" || service === "elasticache" ? rest.split(":").slice(1).join(":") || rest
    : rest.split("/").pop()!;
  return { service, name, path: service === "s3" ? rest.slice(name.length) : "" };
}
const glob = (pat: string) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
const wildName = (r: string) => r === "*" || parseArn(r).name.includes("*");
const sortStr = (xs: string[]) => [...xs].sort();

/** links.ts 의 add() 와 같은 모양으로 넘긴다 */
export interface IamLinkAdd {
  from: string; to: string; intent: Intent; source: string; confidence: 1 | 0.9; rationale?: string; grant: Grant;
}
export interface IamGrantsOut { adds: IamLinkAdd[]; permissions: PermissionV2[]; unmapped: UnmappedV2[] }

/**
 * @param hasLink 이미 다른 근거(env·비밀 이름)로 이어진 의존성인가 ("*" 만으로 덮인 대상 판정용)
 */
export function iamGrants(components: MappedComponent[], policies: RawAwsIamPolicy[],
  hasLink: (from: string, to: string) => boolean): IamGrantsOut {
  const adds: IamLinkAdd[] = [];
  const permissions: PermissionV2[] = [];
  const unmapped: UnmappedV2[] = [];
  const workloads = components.filter((c) => c.kind === "service" || c.kind === "job");
  const targets = components.filter((c) => c.kind !== "service" && c.kind !== "job" && ARN_SERVICE_BY_TYPE[c.native.type]);
  const svcOf = (t: MappedComponent) => ARN_SERVICE_BY_TYPE[t.native.type]!;
  const sorted = [...policies].sort((a, b) => `${a.namespace ?? ""}/${a.serviceAccount}/${a.roleName}`.localeCompare(`${b.namespace ?? ""}/${b.serviceAccount}/${b.roleName}`));

  for (const p of sorted) {
    // 네임스페이스 없는 정책은 어느 파드 신원인지 모른다 → 아무 데도 안 붙인다 (모든 네임스페이스에 붙이면 넓어진다)
    if (!p.namespace) {
      unmapped.push({ resource: `aws.iamPolicy:${p.roleName}`, grade: "B", reason: "신원의 네임스페이스를 모름 → 어느 서비스 권한인지 사람이 확인" });
      continue;
    }
    const subs = workloads.filter((w) => w.props.serviceAccount === p.serviceAccount && w.native.namespace === p.namespace);
    if (!subs.length) {
      unmapped.push({ resource: `aws.iamPolicy:${p.roleName}`, grade: "B", reason: `${p.namespace}/${p.serviceAccount} 를 쓰는 워크로드가 없음 → 이전 대상 밖 신원` });
      continue;
    }
    const source = `iam:${p.roleName}`;
    for (const st0 of arr<Record<string, unknown>>(p.statements)) {
      if (!st0 || typeof st0 !== "object") continue;
      const st = {
        Effect: (st0.Effect as string | undefined) ?? "Allow",
        Action: arr(st0.Action), NotAction: arr(st0.NotAction), Resource: arr(st0.Resource), NotResource: arr(st0.NotResource),
        Condition: st0.Condition as Record<string, unknown> | undefined,
      };
      const cond = st.Condition && Object.keys(st.Condition).length ? st.Condition : undefined;
      const odd = st.Effect !== "Allow" || st.NotAction.length > 0 || st.NotResource.length > 0;
      const covered = new Map<string, string[]>();   // targetId → 그 대상을 가리키는 resources
      const coverOf = new Map<string, string[]>();   // resource → 덮는 targetId 들 (기준선 covers 를 자원마다)
      // 대상에 쓸 수 있는 동작만: 서비스가 같고 계정 단위 동작이 아닌 것
      const actsFor = (t: MappedComponent) => st.Action.filter((a) => (a === "*" || a.split(":")[0] === svcOf(t)) && !ACCOUNT_LEVEL.test(a));
      if (!odd) for (const r of st.Resource) {
        const a = parseArn(r);
        for (const t of targets) {
          if (!actsFor(t).length) continue;
          const exact = t.native.uid && r === t.native.uid;
          const hit = exact || a.service === "*" || (a.service === svcOf(t) && (a.name === t.native.name || (a.name.includes("*") && glob(a.name).test(t.native.name))));
          if (!hit) continue;
          covered.set(t.id!, [...(covered.get(t.id!) ?? []), r]);
          coverOf.set(r, [...(coverOf.get(r) ?? []), t.id!]);
        }
      }
      for (const s of subs) {
        for (const [tid, rs] of [...covered].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
          if (rs.every((r) => r === "*") && !hasLink(s.id!, tid)) continue;
          const t = targets.find((x) => x.id === tid)!;
          const acts = actsFor(t);
          let intent: Intent | null = null;
          for (const a of acts) for (const [re, i] of IAM_INTENT) if (re.test(a)) { intent = merge(intent, i); break; }
          if (acts.includes("*")) intent = "admin";
          // DB·캐시 대상은 의도가 늘 connect (공통 명세 검사 INTENT_OK). 관리 권한의 크기는 grants 원문이 든다
          const conn = t.kind === "postgres" || t.kind === "cache";
          if (conn) intent = "connect";
          const why = [
            !conn && acts.some((a) => a === "*" || a.endsWith(":*")) && "와일드카드 동작 → 도착도 같은 크기(admin). 최소화는 권장안",
            conn && "DB·캐시 관리 권한(IAM) → 의도는 connect, 관리 권한 크기는 grants 원문으로",
            rs.some(wildName) && "와일드카드 자원이 이 대상을 덮음 → 같은 범위는 기준선에도 기록",
            cond && "조건 있음 → 모듈이 같은 조건으로 옮겨야 함(검토)",
            rs.some((r) => (parseArn(r).path ?? "").length > 2) && "버킷 안 일부 경로만 → grants 원문 범위로",
            !intent && "동작 이름을 의도로 못 묶음 → grants 원문으로 옮김",
          ].filter((x): x is string => Boolean(x)).join(" / ");
          adds.push({ from: s.id!, to: tid, intent: intent ?? "readwrite", source, confidence: cond ? 0.9 : 1,
            ...(why ? { rationale: why } : {}),
            grant: { effect: "Allow", actions: sortStr(acts), resources: sortStr(rs), ...(cond ? { conditions: cond } : {}) } });
        }
        // 기준선: 의존성으로 다 못 옮긴 것 (Deny·Not*, IR 밖 자원, 와일드카드 자원, 조건 있는 Allow)
        const rest = odd ? [...st.Resource, ...st.NotResource] : st.Resource.filter((r) => !coverOf.has(r) || wildName(r));
        const covers = [...new Set(rest.filter(wildName).flatMap((r) => coverOf.get(r) ?? []))].sort();
        if (odd || rest.length || cond)
          permissions.push({
            subject: s.id!, source, effect: st.Effect === "Deny" ? "Deny" : "Allow",
            actions: sortStr(st.Action),
            ...(st.NotAction.length ? { notActions: sortStr(st.NotAction) } : {}),
            resources: sortStr(odd || !rest.length ? st.Resource : rest),
            ...(st.NotResource.length ? { notResources: sortStr(st.NotResource) } : {}),
            ...(cond ? { conditions: cond } : {}),
            ...(covers.length ? { covers } : {}),
            mode: "mirror",
            note: st.Effect !== "Allow" ? "Deny 문장 → 도착에도 같은 막음"
              : odd ? "NotAction·NotResource → 원문 그대로, 검토 필요"
              : cond && !rest.length ? "조건 있는 Allow → 의존성 grants 와 같은 조건을 도착에도. 같은 조건이 없으면 사람에게"
              : rest.includes("*") ? "Resource 가 * → 도착에서도 같은 범위. 좁히기는 권장안"
              : rest.some(wildName) ? "와일드카드 자원 → 같은 범위" : "IR 밖 자원 → 대응 자원을 사람이 고름",
          });
      }
    }
  }
  const pk = (x: PermissionV2) => `${x.subject}\0${x.source}\0${x.effect}\0${x.resources.join(",")}\0${x.actions.join(",")}`;
  permissions.sort((a, b) => (pk(a) < pk(b) ? -1 : pk(a) > pk(b) ? 1 : 0));
  return { adds, permissions, unmapped };
}
