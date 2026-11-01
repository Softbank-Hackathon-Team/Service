// Z47-04 기본안 (DRAFT(ai), Jeong 위임 10/31 17:59Z): 앱 역할(app-*) 신뢰 정책 검사.
// 문제: 실행 역할은 iam:CreateRole(app-*, 권한 경계 필수)을 가진다. 경계는 "역할이 무엇을 하나"만 막고 "누가 빌리나"는 못 막는다.
//   IAM 에는 신뢰 정책 내용을 조건으로 거는 키가 없어서, 실행 자격(15분)을 훔친 사람이 외부 계정이 믿는 app-* 역할을 만들면 뒷문이 남는다.
// 고른 것: 구조는 그대로(아키텍처 유지) + apply 직후 iam:GetRole(이미 허용)로 신뢰 정책을 읽어 이 함수로 검사 → 어긋나면 apply 실패 처리
//   (failed → 롤백 경로의 destroy 가 그 역할을 지운다) + 감사 temp_role.trust_violation.
// 버린 것: ① 앱 역할을 고객 온보딩 템플릿에서 미리 만들기 → 가장 단단하지만 온보딩 단계·고객 작업이 늘어 결선 범위 밖
//          ② CreateRole 을 별도 역할로 분리 → 그 역할 자격을 훔쳐도 같은 뒷문이라 효과 없음
// 남는 것: 검사 전 몇 초~몇 분은 뒷문이 열려 있다(탐지형). CloudTrail SourceIdentity 로 누가 만들었는지는 남는다
export const APP_ROLE_TRUSTED_SERVICE = "pods.eks.amazonaws.com";
const ALLOWED_ACTIONS = new Set(["sts:AssumeRole", "sts:TagSession"]);

export interface TrustCheck { ok: boolean; violations: string[] }

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

// GetRole 의 AssumeRolePolicyDocument 는 URL 인코딩된 문자열로 온다【사실, IAM GetRole API 문서】. 객체·평문 JSON 도 받는다
export function parseTrustDoc(doc: unknown): { Statement?: unknown } {
  if (typeof doc !== "string") return (doc ?? {}) as { Statement?: unknown };
  const text = doc.trimStart().startsWith("%") ? decodeURIComponent(doc) : doc;
  return JSON.parse(text) as { Statement?: unknown };
}

// 허용: Allow 문만, Principal 은 { Service: "pods.eks.amazonaws.com" } 하나, Action 은 AssumeRole·TagSession 만.
// Deny 문은 더 좁히는 것이라 허용. NotPrincipal·NotAction·AWS·Federated·"*" 주체는 위반
export function checkAppRoleTrust(doc: unknown): TrustCheck {
  const v: string[] = [];
  let parsed: { Statement?: unknown };
  try { parsed = parseTrustDoc(doc); } catch { return { ok: false, violations: ["TRUST_UNPARSEABLE"] }; }
  const stmts = arr(parsed.Statement) as Array<Record<string, unknown>>;
  if (stmts.length === 0) v.push("TRUST_EMPTY");
  stmts.forEach((s, i) => {
    if (s.Effect === "Deny") return;
    if (s.Effect !== "Allow") { v.push(`TRUST_EFFECT#${i}`); return; }
    if (s.NotPrincipal !== undefined) v.push(`TRUST_NOT_PRINCIPAL#${i}`);
    if (s.NotAction !== undefined) v.push(`TRUST_NOT_ACTION#${i}`);
    const p = s.Principal;
    if (p === "*" || typeof p !== "object" || p === null) { v.push(`TRUST_PRINCIPAL_ANY#${i}`); }
    else {
      for (const k of Object.keys(p)) if (k !== "Service") v.push(`TRUST_PRINCIPAL_${k.toUpperCase()}#${i}`);
      const svc = arr((p as Record<string, unknown>).Service);
      if (svc.length === 0 || svc.some((x) => x !== APP_ROLE_TRUSTED_SERVICE)) v.push(`TRUST_SERVICE#${i}`);
    }
    const acts = arr(s.Action);
    if (acts.length === 0 || acts.some((a) => typeof a !== "string" || !ALLOWED_ACTIONS.has(a))) v.push(`TRUST_ACTION#${i}`);
  });
  return { ok: v.length === 0, violations: v };
}

// apply 직후 부르는 자리 (워커 AWS 실행기가 진짜가 되면 apply.ts 에서). GetRole 은 실행 역할 천장·apply 세션 정책에 이미 있다
export interface IamGetRole { getRole(i: { RoleName: string }): Promise<{ Role?: { AssumeRolePolicyDocument?: string } }> }
export async function verifyAppRoleTrust(iam: IamGetRole, roleName: string): Promise<TrustCheck & { roleName: string }> {
  if (!/^app-/.test(roleName)) return { ok: false, violations: ["TRUST_ROLE_NOT_APP"], roleName };
  const r = await iam.getRole({ RoleName: roleName });
  return { ...checkAppRoleTrust(r.Role?.AssumeRolePolicyDocument), roleName };
}
