// PR 전 허용 목록 검사. 에이전트가 finish 로 넘긴 변경을 플랫폼이 PR로 만들기 전에 본다.
// STUB: 설계 v1의 GATE-01~12는 YAML을 파싱해 JSON 경로 단위로 비교한다. 지금은 줄 단위 간이 검사 4개만 둔다
import { redactManifestText } from "./guard.js";

import { countRedactionPlaceholders as placeholders } from "@svc/contracts";

export interface GateResult { ok: boolean; violations: string[] }

export function gateChanges(before: Map<string, string>, after: Map<string, string>): GateResult {
  const v: string[] = [];
  for (const [path, text] of after) {
    if (before.get(path) === text) continue;
    // Z90b-2 (Z38b §24-17): "." ".." 빈 세그먼트도 거부 (deploy/../../x.yaml 이 통과하던 구멍)
    if (!/^deploy\/[A-Za-z0-9_./-]+\.ya?ml$/.test(path) || path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
      v.push(`GATE-01 deploy/ 밖 파일: ${path}`);
    if (/kind:\s*(Secret|ServiceAccount|Role|RoleBinding|ClusterRole|ClusterRoleBinding)\b/.test(text))
      v.push(`GATE-02 금지 종류: ${path}`);
    if (/privileged:\s*true|runAsUser:\s*0\b/.test(text)) v.push(`GATE-03 권한 상승: ${path}`);
    const reg = (t: string) => [...t.matchAll(/image:\s*"?([^/\s"]+)\//g)].map((m) => m[1]).sort().join(",");
    if (before.has(path) && reg(before.get(path)!) !== reg(text)) v.push(`GATE-04 이미지 저장소 변경: ${path}`);
    // Z3-F5: 평문 비밀이 새로 들어오면 PR 후보에서 뺀다 (가리기 규칙이 새로 가린 칸 수로 센다. YAML 이 깨져도 동작)
    const hidden = (t: string) => redactManifestText(t).split("[REDACTED]").length - (t.split("[REDACTED]").length);
    if (hidden(text) > hidden(before.get(path) ?? "")) v.push(`GATE-05 평문 비밀: ${path} (Secret 참조로 바꿔야 함)`);
    // LLM-1: LLM 이 본 글은 가려져 있다(계정·주소·IP·비밀). 가린 자리 표시를 그대로 베껴 쓴 변경은 깨진 매니페스트라 PR 후보에서 뺀다
    if (placeholders(text) > placeholders(before.get(path) ?? "")) v.push(`GATE-06 가린 값 자리 표시가 들어감: ${path} (가려진 원래 값을 쓸 수 없음)`);
  }
  return { ok: v.length === 0, violations: v };
}
