import type { Provider } from "@svc/contracts";
import { actionsOfPolicy, type PermissionSet, type Stage } from "./permissions.js";

// 작업 단계가 임시 역할을 빌릴 때 "무슨 동작을 달라고 할지" (작업 Z39). 순수 함수.
// 동작 목록을 손으로 다시 쓰지 않고 최소 권한 파일(infra/permissions)에서 뽑는다 → 파일이 바뀌면 요청도 같이 바뀐다
//   AWS 실행: 그 단계의 세션 정책 동작 그대로 (중개자가 다시 세션 정책으로 좁힌다)
//   GCP·온프레 실행: 천장에서 단계에 맞는 동사만 (plan = 읽기, apply = 지우기 뺀 전부, destroy = 읽기 + 지우기)
//   관찰: 천장의 읽기 동작만
// DRAFT(ai): 요청 하나 50개 상한(TempRoleRequest)을 넘으면 앞에서 50개만. 지금 파일로는 넘는 곳이 없다 (시험으로 확인)

export const STEP_ROLE_MAX_ACTIONS = 50;
const READ_VERB = /^(describe|list|get|batchget|watch|lookup|search)/i;
const DELETE_VERB = /^(delete|deletecollection|remove|destroy)/i;
const verbOf = (a: string) => a.split(/[:.]/).pop() ?? "";
const isRead = (a: string) => READ_VERB.test(verbOf(a));
const isDelete = (a: string) => DELETE_VERB.test(verbOf(a));

// Azure 는 Mock 전용이라 천장 파일이 없다. 관찰 요청 모양만 맞춘다
const AZURE_OBSERVE = ["resources.list", "resourcegroups.get"];

export function stepActions(p: PermissionSet | null, provider: Provider, purpose: "observe" | "operate", stage?: Stage): string[] {
  const cap = (xs: string[]) => [...new Set(xs)].sort().slice(0, STEP_ROLE_MAX_ACTIONS);
  if (provider === "azure_mock") return purpose === "observe" ? AZURE_OBSERVE : [];
  if (!p) return [];
  const ceiling = provider === "aws" ? p.aws.ceiling : provider === "gcp" ? p.gcp.ceiling : p.onprem.ceiling;
  if (purpose === "observe") return cap(ceiling.filter(isRead));
  const st = stage ?? "plan";
  if (provider === "aws") return cap(actionsOfPolicy(JSON.parse(p.aws.sessionPolicies[st])));
  if (st === "plan") return cap(ceiling.filter(isRead));
  if (st === "destroy") return cap(ceiling.filter((a) => isRead(a) || isDelete(a)));
  return cap(ceiling.filter((a) => !isDelete(a)));
}

// 단계 → 어느 환경에서 무슨 목적으로 빌리나. 작업 단계 배선(worker jobs/_roles.ts)이 이 표를 따른다
export const STEP_ROLES = {
  precheck: [{ side: "source", purpose: "observe" }, { side: "target", purpose: "observe" }],
  plan: [{ side: "target", purpose: "operate", stage: "plan" }],
  apply: [{ side: "target", purpose: "operate", stage: "apply" }],
  cleanup: [{ side: "source", purpose: "operate", stage: "destroy" }],
  rollback: [{ side: "target", purpose: "operate", stage: "destroy" }],
} as const satisfies Record<string, ReadonlyArray<{ side: "source" | "target"; purpose: "observe" | "operate"; stage?: Stage }>>;
export type RoleStep = keyof typeof STEP_ROLES;
