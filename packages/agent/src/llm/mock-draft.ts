import type { ContentBlock, LlmMessage, LlmProvider, LlmResponse } from "../ai/llm.js";

// 시험 전용 가짜 공급자 (FAKE_LLM=1 일 때만 쓰인다, 작업 Z90). 진짜 모델처럼 도구를 불러 결과를 읽고, 읽은 것만으로 submit_draft 를 만든다.
// 시험·데모 리허설용. 판단력은 없다: 규칙 기반 명세를 그대로 내고, 정해진 형식의 설명을 만든다.
// 진짜 모델과 같은 LlmProvider 인터페이스라 호출부는 바뀌지 않는다.
type Block = { type: string; [k: string]: unknown };

function toolResults(messages: LlmMessage[]): Record<string, unknown> {
  const names = new Map<string, string>();
  const out: Record<string, unknown> = {};
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b.type === "tool_use") names.set(String(b.id), String(b.name));
      if (b.type === "tool_result") {
        const text = String(b.content ?? "");
        const body = /<tool_result[^>]*>\n([\s\S]*)\n<\/tool_result>/.exec(text)?.[1] ?? text;
        try { out[names.get(String(b.tool_use_id)) ?? "?"] = JSON.parse(body); }
        catch { out[names.get(String(b.tool_use_id)) ?? "?"] = body; }
      }
    }
  }
  return out;
}

export function mockDraftLlm(model = "mock-draft"): LlmProvider {
  let n = 0;
  const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `mock_${++n}`, name, input });
  const reply = (content: ContentBlock[]): LlmResponse => ({
    content, stop_reason: "tool_use", usage: { input_tokens: 900, output_tokens: 120 }, model,
  });
  return {
    model,
    async create({ messages }) {
      const seen = toolResults(messages);
      // 1턴: 읽기 도구를 한꺼번에 부른다 (병렬 도구 호출)
      if (!("baseline_get" in seen)) {
        return reply([
          { type: "text", text: "자원 목록, 명세, 도착 환경, 규칙 위험, 계획서를 먼저 읽는다." },
          use("inventory_list", {}), use("baseline_get", {}), use("target_get", {}), use("risk_rules", {}), use("plan_get", {}),
        ]);
      }
      const base = seen.baseline_get as { spec: Record<string, unknown>; fieldMeta: Record<string, { needs_review?: boolean }> };
      // 2턴: 모양 확인
      if (!("validate_spec" in seen)) return reply([use("validate_spec", { spec: base.spec })]);
      // 3턴: 끝내기
      const target = seen.target_get as { provider: string; region: string };
      const inv = seen.inventory_list as { provider: string; items: Array<{ kind: string; name: string }> };
      const rules = (seen.risk_rules ?? []) as Array<{ id: string; title: string }>;
      const plan = seen.plan_get as { steps?: Array<{ id: string }> } | null;
      const review = Object.entries(base.fieldMeta).filter(([, m]) => m.needs_review).map(([k]) => k);
      type C = { id: string; kind: string; props: { image?: { repository?: string } } };
      const comps = (base.spec.components ?? []) as C[];
      const svc = comps.find((c) => c.kind === "service");
      const app = (base.spec.app as { name?: string } | undefined)?.name ?? "?";
      const hasDb = comps.some((c) => c.kind === "postgres");
      const order = plan?.steps?.map((s) => s.id).join(" → ") ?? "provision → deploy → sync → shift → cutover → cleanup (계획서 생성 전, 기본 순서)";
      const explanation = [
        `${app} 앱을 ${inv.provider}에서 ${target.provider}(${target.region})로 옮긴다. 원본 자원 ${inv.items.length}개 중 ${inv.items.map((i) => i.kind).join(", ")}을 읽었다.`,
        `단계: ${order}.`,
        hasDb ? "DB는 논리 복제로 따라오게 한 뒤 컷오버 순간에만 쓰기를 잠깐 멈춘다." : "DB가 없어 복제·컷오버 단계는 건너뛴다.",
        "트래픽은 10%, 50%, 100% 순서로 옮기고, 오류율 1% 초과나 p95 지연 2배가 30초 이어지면 되돌린다.",
        review.length ? `사람이 확인할 칸: ${review.join(", ")}.` : "확인이 필요한 칸은 없다.",
        `규칙 위험 ${rules.length}개(${rules.map((r) => r.id).join(", ")})는 위험 목록에 함께 실린다.`,
        "(시험용 가짜 LLM 이 만든 설명, FAKE_LLM=1)",
      ].join(" ");
      const repo = svc?.props.image?.repository;
      const risks = svc && repo && inv.provider !== target.provider ? [{
        level: "medium" as const, title: "출발 이미지 저장소 접근",
        detail: `이미지 ${repo}를 도착 환경에서 받을 수 있어야 한다. 저장소 복사 또는 읽기 권한이 필요하다`,
        field: `components.${svc.id}.image`, mitigation: "배포 전 도착 클러스터에서 이미지 받기 시험",
      }] : [];
      return reply([use("submit_draft", {
        spec: base.spec,
        field_notes: review.map((f) => ({ field: f, rationale: "원본에 근거가 없어 원래 값을 유지 (STUB)" })),
        risks, plan_explanation: explanation,
      })]);
    },
  };
}
