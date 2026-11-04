import { z } from "zod";
import { Provider } from "@svc/contracts";

// 임시 역할 발급. 고객 권한은 비밀 키가 아니라 짧게 빌리는 역할로만 쓴다 (관찰 역할, 실행 역할 분리).
// DRAFT(ai): 아래 두 스키마는 워커 ↔ 보안 패키지 경계를 넘으므로 packages/contracts 로 옮길 후보다 (통합 스레드에 요청)
export const TempRoleRequest = z.object({
  tenantId: z.uuid(),
  envId: z.uuid(),
  provider: Provider,
  purpose: z.enum(["observe", "operate"]),
  migrationId: z.uuid().optional(),      // 실행 역할은 반드시 이전 한 건에 묶는다
  // 실행 역할의 단계. AWS 는 이 단계의 세션 정책(infra/permissions/aws-session-policy-<stage>.json)으로 다시 좁힌다
  stage: z.enum(["plan", "apply", "destroy"]).optional(),
  actions: z.array(z.string().min(3)).max(200),   // ID-8: 50 → 200 (AWS apply 세션 정책 66개가 잘리지 않게, STEP_ROLE_MAX_ACTIONS 와 같음)
  // DRAFT(ai): 최대 1시간. AWS AssumeRole 기본값(1h)과 같게 잡았다. 긴 작업은 다시 빌린다
  ttlSec: z.number().int().min(60).max(3600),
}).strict();
export type TempRoleRequest = z.infer<typeof TempRoleRequest>;

export const TempCredential = z.object({
  provider: Provider,
  purpose: z.enum(["observe", "operate"]),
  roleRef: z.string(),        // 예: arn:aws:iam::123:role/svc-observe, GCP 서비스 계정 이메일
  sessionName: z.string(),    // 고객 감사 로그(CloudTrail 등)에서 누가 했는지 찾는 이름
  actions: z.array(z.string()),
  issuedAt: z.string(),
  expiresAt: z.string(),
  credentialRef: z.string(),  // 자격 증명 자체가 아니라 메모리 안 보관 위치의 이름. DB·로그에 값은 안 남긴다
  stub: z.boolean(),
  stage: z.enum(["plan", "apply", "destroy"]).optional(),
  ttlAdjustedSec: z.number().int().optional(),   // 제공자 최소값 때문에 늘어난 경우 실제 TTL
}).strict();
export type TempCredential = z.infer<typeof TempCredential>;

export class TempRoleDenied extends Error {
  readonly status = 403;
  constructor(readonly code: string, message: string) { super(message); }
}

// 읽기 동작인가. AWS "ec2:DescribeInstances", GCP "compute.instances.get", k8s "pods:list"
const READ_VERB = /^(describe|list|get|batchget|watch|lookup|search)/i;
function isRead(action: string): boolean {
  const verb = action.split(/[:.]/).pop() ?? "";
  return READ_VERB.test(verb);
}
const isWildcard = (a: string) => a === "*" || a.endsWith(":*") || a.endsWith(".*") || a.includes("*");

// 최소 권한 검사. 순수 함수. 통과하지 못하면 TempRoleDenied 를 던진다
export function checkLeastPrivilege(req: TempRoleRequest): void {
  const wild = req.actions.filter(isWildcard);
  if (wild.length) throw new TempRoleDenied("ROLE_WILDCARD", `와일드카드 권한 금지 (SEC-IAM-02): ${wild.join(", ")}`);
  if (req.purpose === "observe") {
    const writes = req.actions.filter((a) => !isRead(a));
    if (writes.length) throw new TempRoleDenied("ROLE_OBSERVE_WRITE", `관찰 역할에 쓰기 동작: ${writes.join(", ")}`);
  } else {
    if (!req.migrationId) throw new TempRoleDenied("ROLE_OPERATE_NO_MIGRATION", "실행 역할은 이전 번호가 필요하다");
    if (req.actions.length === 0) throw new TempRoleDenied("ROLE_OPERATE_EMPTY", "실행 역할은 필요한 동작을 명시해야 한다");
  }
  if (req.provider === "azure_mock" && req.purpose === "operate")
    throw new TempRoleDenied("ROLE_AZURE_MOCK", "Azure는 Mock 전용이라 실행 역할을 주지 않는다");
}

export interface RoleIssuer {
  issue(req: TempRoleRequest, now: Date): Promise<TempCredential>;
}

// STUB: 진짜는 AWS STS AssumeRole(ExternalId), GCP 서비스 계정 가장(Workload Identity Federation),
// 온프레는 Agent 키로 범위 제한 토큰. 지금은 어떤 클라우드도 부르지 않고 가짜 참조만 돌려준다.
// TODO(human): 환경별 역할 이름(svc-observe / svc-operate) 규칙은 입력층 연결 템플릿과 맞춰 정한다
export function stubRoleIssuer(accountOf: (envId: string) => string = () => "000000000000"): RoleIssuer {
  return {
    async issue(raw, now) {
      const req = TempRoleRequest.parse(raw);
      checkLeastPrivilege(req);
      const acct = accountOf(req.envId);
      const roleName = `svc-${req.purpose}`;
      const roleRef = {
        aws: `arn:aws:iam::${acct}:role/${roleName}`,
        gcp: `${roleName}@${acct}.iam.gserviceaccount.com`,
        onprem: `agent://${req.envId}/${roleName}`,
        azure_mock: `azure-mock://${acct}/${roleName}`,
      }[req.provider];
      const session = `svc-${req.tenantId.slice(0, 8)}-${(req.migrationId ?? "observe").slice(0, 8)}`;
      return TempCredential.parse({
        provider: req.provider, purpose: req.purpose, roleRef, sessionName: session,
        actions: req.actions, issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + req.ttlSec * 1000).toISOString(),
        credentialRef: `stub-cred/${session}`, stub: true,
      });
    },
  };
}

export const isExpired = (c: TempCredential, now: Date) => Date.parse(c.expiresAt) <= now.getTime();
