import { AppSpec, AppSpecV2, PrecheckItem, upconvertV1, type Provider, type TfOutputs } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { postgresOf, v2Blockers, workloadsOf, identitiesOf } from "./shared.js";
import { targetBuilderFor } from "./index.js";
import { azureShapeBlockers } from "./azure-mock.js";

// TA3 DRAFT(ai): 계획·적용 연결용 순수 조각 (설계 27번 3.5·3.6). DB·네트워크 없음. 워커(plan·precheck·apply·deploy)가 부른다

export const NEEDS_HUMAN = "NEEDS_HUMAN";

// 최신 받아들인 판 한 줄 (core latestAcceptedSpecV2 결과 모양)
export interface SpecV2Source { spec: unknown; specV2: unknown | null; hadV2Before: boolean }
export type ResolvedSpecV2 =
  | { ok: true; spec: AppSpecV2; source: "spec_v2" | "upconvert" }
  | { ok: false; code: typeof NEEDS_HUMAN; reason: string };

/** v2 명세를 어디서 가져오나 (27번 3.5 표).
 *  spec_v2 있음 → 그것 / NULL → upconvertV1(spec) / NULL 인데 앞 판엔 있었음 → NEEDS_HUMAN (몰래 줄여 옮기지 않음) */
export function resolveSpecV2(row: SpecV2Source): ResolvedSpecV2 {
  if (row.specV2 != null) {
    const p = AppSpecV2.safeParse(row.specV2);
    if (!p.success) return { ok: false, code: NEEDS_HUMAN, reason: `spec_v2 모양이 틀림: ${p.error.issues[0]?.path.join(".") ?? "?"}` };
    return { ok: true, spec: p.data, source: "spec_v2" };
  }
  if (row.hadV2Before)
    return { ok: false, code: NEEDS_HUMAN, reason: "앞 판엔 spec_v2 가 있었는데 이 판(사람 편집)엔 없음 → v2 에만 있던 리소스가 빠졌을 수 있음. 다시 가져오거나 v2 로 고쳐야 함" };
  const v1 = AppSpec.safeParse(row.spec);
  if (!v1.success) return { ok: false, code: NEEDS_HUMAN, reason: "v1 명세 모양이 틀려 올리기(upconvert)를 못 함" };
  return { ok: true, spec: upconvertV1(v1.data).spec, source: "upconvert" };
}

/** 계획 단계가 쓰는 v2 명세. 못 쓰면 AdapterError(NEEDS_HUMAN) → planOnError 가 바로 failed */
export function specV2OrThrow(row: SpecV2Source): { spec: AppSpecV2; source: "spec_v2" | "upconvert" } {
  const r = resolveSpecV2(row);
  if (!r.ok) throw new AdapterError(NEEDS_HUMAN, r.reason);
  return r;
}

/** apply·deploy 때: 계획서가 고른 출처와 지금 판이 맞는지. 계획서가 spec_v2 였는데 지금 NULL 이면 upconvert 로 몰래 넘어가지 않는다 */
export function specV2ForPlan(row: SpecV2Source, planSource: "spec_v2" | "upconvert" | undefined): AppSpecV2 | null {
  const r = resolveSpecV2(row);
  if (!r.ok) return null;
  if (planSource && r.source !== planSource) return null;
  return r.spec;
}

/** precheck 대조 (27번 3.6). capability 밖·사람 확인 → block, 렌더 경고는 따로 안 냄(계획서 값 warnings) */
export function v2PrecheckItems(provider: Provider, row: SpecV2Source): PrecheckItem[] {
  const r = resolveSpecV2(row);
  if (!r.ok) return [{ id: "PC-V2-HUMAN", level: "block", message: `FAIL v2 명세 — ${r.reason}`, fix: "명세를 다시 가져오거나 v2 판을 고친다" }];
  const b = v2Blockers(r.spec, targetBuilderFor(provider).capabilities());
  // E2E-v5: capability 표로 못 거르는 Builder 모양 제한 (azure_mock 신원 1개). 빼면 계획 단계에서 UNSUPPORTED_V2 로 failed 가 됨
  if (provider === "azure_mock") b.unsupported.push(...azureShapeBlockers(r.spec));
  const out: PrecheckItem[] = [
    { id: "PC-V2-SOURCE", level: "info", message: `PASS v2 명세 출처 — ${r.source} (리소스 ${r.spec.components.length}개)` },
  ];
  b.unsupported.forEach((m, n) => out.push({ id: `PC-V2-UNSUP-${n + 1}`, level: "block", message: `FAIL ${m}`, fix: "도착을 바꾸거나 그 칸을 명세에서 뺀다 (사람 승인)" }));
  b.needsHuman.forEach((m, n) => out.push({ id: `PC-V2-HUMAN-${n + 1}`, level: "block", message: `FAIL 사람 확인 필요 — ${m}`, fix: "명세 검토에서 정한다" }));
  return out.map((i) => PrecheckItem.parse(i));
}

/** 진짜 terraform 출력(맵은 JSON 글자)을 자리표시 키로 펼침: link_outputs → link.<id>.<출력>, identity_* → identity.<id>.<칸>.
 *  원래 키는 그대로 둔다 (v1 평평한 이름 = 복제·비밀번호·프록시 코드가 읽음). 이미 펼친 키가 있으면 덮지 않는다 */
export function flattenTfOutputsV2(out: TfOutputs): TfOutputs {
  const res: TfOutputs = { ...out };
  const put = (k: string, v: unknown) => { if (res[k] === undefined && v != null) res[k] = typeof v === "string" ? v : String(v); };
  const obj = (s: string | undefined): Record<string, unknown> | null => {
    if (!s) return null;
    try { const o = JSON.parse(s); return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : null; } catch { return null; }
  };
  for (const [id, links] of Object.entries(obj(out.link_outputs) ?? {}))
    if (links && typeof links === "object") for (const [k, v] of Object.entries(links as Record<string, unknown>)) put(`link.${id}.${k}`, v);
  for (const [id, v] of Object.entries(obj(out.identity_gsa_emails) ?? {})) put(`identity.${id}.gsa_email`, v);
  for (const [id, v] of Object.entries(obj(out.identity_role_arns) ?? {})) put(`identity.${id}.role_arn`, v);
  return res;
}

/** STUB: 흉내 길(MOCK_IAC=1)의 v2 출력. v1 STUB_TF_OUTPUTS 에 더할 link.<id>.* · identity.<id>.* 가짜 값 (결정적) */
export function stubTfOutputsV2(spec: AppSpecV2): TfOutputs {
  const out: TfOutputs = {};
  for (const p of postgresOf(spec)) {
    const host = `stub-${p.id}.target.internal`;
    Object.assign(out, { [`link.${p.id}.host`]: host, [`link.${p.id}.port`]: "5432", [`link.${p.id}.user`]: "app",
      [`link.${p.id}.url`]: `postgresql://app@${host}:5432/${spec.app.name.replace(/-/g, "_")}` });
  }
  for (const i of identitiesOf(spec)) {
    out[`identity.${i.id}.gsa_email`] = `stub-${i.id}@stub-project.iam.gserviceaccount.com`;
    out[`identity.${i.id}.role_arn`] = `arn:aws:iam::000000000000:role/stub-${i.id}`;
  }
  return out;
}

// 이 명세가 k8s 워크로드를 하나라도 가지나 (없으면 배포할 값이 없다)
export const hasWorkloadsV2 = (spec: AppSpecV2) => workloadsOf(spec).length > 0;
