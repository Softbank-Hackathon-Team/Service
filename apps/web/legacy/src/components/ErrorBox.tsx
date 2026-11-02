// 표시 메모: 오류 상자. 한국어 설명 한 줄 + 서버 원문(상태, 코드, 메시지, 요청 번호). 오류 코드별 문장은 explain() 에 있다.
import { HttpError } from "../api";
import { LABEL } from "../status";
import type { MigrationStatus } from "../types";

// 서버 원문 한 줄: "409 INVALID_TRANSITION — awaiting_approval -> provisioning (요청 …)"
// 디버깅·e2e가 이 줄을 보므로 모양을 바꾸지 않는다. 사람용 한국어 설명은 explain()이 위에 따로 붙인다
export function errText(e: unknown): string {
  if (e instanceof HttpError) {
    const b = e.body;
    return b?.code ? `${e.status} ${b.code} — ${b.message ?? ""}${b.requestId ? ` (요청 ${b.requestId})` : ""}` : `HTTP ${e.status}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

const lbl = (s: string) => (s in LABEL ? `${LABEL[s as MigrationStatus]}` : s);

// 오류 코드 → 사람이 읽는 한 문장. 모르는 코드는 null (원문만 보여 준다)
export function explain(e: unknown): string | null {
  if (e instanceof TypeError) return "API 서버에 닿지 못했어. API가 떠 있는지 확인해.";
  if (!(e instanceof HttpError)) return null;
  const code = e.body?.code;
  const msg = e.body?.message ?? "";
  switch (code) {
    case "INVALID_TRANSITION": {
      // 두 모양: "a -> b" (advance) / "a → b not allowed" (control.ts 비상 버튼)
      const m = /^(\w+)\s*(?:->|→)\s*(\w+)(?:\s+not allowed)?$/.exec(msg.trim());
      if (!m) return "지금 상태에서는 이 동작을 할 수 없어.";
      const [, from, to] = m as unknown as [string, string, string];
      if (from === "awaiting_approval" && to === "provisioning")
        return "아직 승인 전이야. 계획서를 승인해야 실행을 시작할 수 있어.";
      if (to === "rolling_back") return `지금 상태(${lbl(from)})에서는 롤백할 수 없어. 그 사이 상태가 바뀌었을 수 있어.`;
      if (to === "cancelled") return `지금 상태(${lbl(from)})에서는 취소할 수 없어. 그 사이 상태가 바뀌었을 수 있어.`;
      return `지금 상태(${lbl(from)})에서는 ${lbl(to)}(으)로 갈 수 없어. 화면이 낡았을 수 있어, 잠시 뒤 다시 확인해.`;
    }
    case "NOT_FOUND": return "찾는 것이 없어. 지운 것이거나, 다른 회사 것이라 이 회사 번호로는 안 보여.";
    case "UNAUTHENTICATED": return "회사 번호(x-dev-tenant)가 없거나 잘못됐어.";
    case "BAD_REQUEST": return "보낸 값이 형식에 안 맞아.";
    case "PLAN_HASH_MISMATCH": return "계획서 지문이 달라. 그 사이 계획서가 바뀌었어. 새로 읽고 다시 승인해.";
    case "PLAN_EXPIRED": return "계획서 유효 시간이 지났어. 계획을 다시 만들어야 해.";
    case "PLAN_SUPERSEDED": return "더 새 계획서가 있어. 최신 계획서로 다시 해.";
    case "PLAN_NOT_APPROVED": return "계획서가 아직 승인되지 않았어.";
    case "ENV_BUSY": return "이 환경은 다른 이전이 쓰는 중이야. 그 이전이 끝난 뒤 다시 해.";
    case "GUARD_FAILED":
      if (/manual cleanup/.test(msg)) return "실패한 이전을 취소하려면 남은 자원을 직접 정리했다고 확인해야 해.";
      return "시작 조건을 못 맞췄어 (예: 환경이 연결됨 상태가 아님).";
    case "IDEMPOTENCY_KEY_REUSED": return "같은 요청 키를 다른 내용에 다시 썼어. 버튼을 다시 눌러.";
    case "INTERNAL": return "서버 내부 오류야. API 터미널 로그를 봐.";
    default:
      if (e.status >= 500) return "서버 쪽 오류야. API 터미널 로그를 봐.";
      return null;
  }
}

// hint: 이 자리에서만 맞는 더 구체적인 설명 (예: 만들기 버튼의 404 → "환경이 이 회사에 없어")
export function ErrorBox({ error, hint }: { error: unknown; hint?: (e: unknown) => string | null }) {
  if (!error) return null;
  const head = hint?.(error) ?? explain(error);
  return (
    <div className="error" role="alert">
      {head && <div className="ehead">{head}</div>}
      <div className={head ? "eraw" : ""}>{errText(error)}</div>
    </div>
  );
}
