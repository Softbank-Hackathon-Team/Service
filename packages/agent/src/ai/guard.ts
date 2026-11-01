import { parseAllDocuments } from "yaml";
import { redact, REDACTED } from "../draft/redact.js";

// 점검·수정(remediate) 경로의 두 가지 방어. 메모리·k3d 샌드박스 둘 다 이 파일을 쓴다.
//  1) Z3-F1 도구 결과 경계: 샌드박스·레포에서 온 글자는 <tool_result> 태그를 깰 수 없다
//  2) Z3-F5 평문 비밀: 비밀처럼 보이는 값은 LLM 에 안 가고, 매니페스트·PR 에도 못 들어간다
// DRAFT(ai): 이름·모양 규칙은 draft/redact.ts 와 같은 목록을 쓴다 (진짜 비밀 탐지기로 바꿀 자리)

export const SECRET_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth/i;
export const SECRET_VALUE = [
  /AKIA[0-9A-Z]{16}/g,                                  // AWS 액세스 키
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, // 개인 키
  /sk-ant-[A-Za-z0-9_-]{10,}/g,                         // Anthropic 키
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                        // GitHub 토큰
  /(:\/\/[^/\s:@]+:)[^/\s@]+(@)/g,                      // 접속 주소 안의 비밀번호
];
const looksSecretValue = (v: string) => SECRET_VALUE.some((r) => { r.lastIndex = 0; return r.test(v); });

// ── 1) 경계 ──────────────────────────────────────────────
// 데이터 안의 "<" 는 \u003c 로 바꾼다. </tool_result> 가 들어 있어도 태그로 읽히지 않는다.
// 출처 이름도 허용 글자만 남긴다. 너무 길면 뒤쪽(로그는 최근 줄이 중요)을 남기고 잘렸다고 적는다
export const MAX_TOOL_TEXT = 8000;
export function wrapToolResult(src: string, body: unknown): string {
  let text = typeof body === "string" ? body : JSON.stringify(body) ?? "null";
  if (text.length > MAX_TOOL_TEXT) text = `(앞 ${text.length - MAX_TOOL_TEXT}자 잘림)\n` + text.slice(-MAX_TOOL_TEXT);
  return `<tool_result source="${src.replace(/[^A-Za-z0-9:_./-]/g, "").slice(0, 120)}">\n${text.replace(/</g, "\\u003c")}\n</tool_result>`;
}

// ── 2) 평문 비밀 ─────────────────────────────────────────
// 자유 글(로그, 오류 메시지)에서 비밀 모양을 가린다. NAME=값 / NAME: 값 의 NAME 이 비밀 이름이면 값도 가린다
export function redactText(t: string): string {
  let out = t;
  for (const r of SECRET_VALUE) {
    r.lastIndex = 0;
    out = out.replace(r, (_m, a?: string, b?: string) => (typeof a === "string" && typeof b === "string" && a.startsWith("://") ? `${a}${REDACTED}${b}` : REDACTED));
  }
  return out.replace(/\b([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)("?)([^\s"',}]+)\3/g, (m, name: string, sep: string, q: string, val: string) =>
    SECRET_NAME.test(name) && !/^(arn:|projects\/|\$\{|secretKeyRef|valueFrom|\[REDACTED\])/.test(val) && val.length >= 4
      ? `${name}${sep}${q}${REDACTED}${q}` : m);
}

// YAML 매니페스트 글에서 env 의 평문 value 를 가린다 (repo_read 결과용). 파싱이 안 되면 글 규칙만 쓴다
export function redactManifestText(t: string): string {
  const lines = t.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-?\s*name:\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/.exec(lines[i]!);
    if (!m || !SECRET_NAME.test(m[2]!)) continue;
    const next = lines[i + 1];
    if (next !== undefined && /^\s*value:\s*\S/.test(next)) lines[i + 1] = next.replace(/(value:\s*)(.*)$/, `$1"${REDACTED}"`);
  }
  // 한 줄 모양 { name: X, value: Y }
  return redactText(lines.join("\n").replace(/(name:\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*,\s*value:\s*)("[^"]*"|[^\s,}]+)/g,
    (m, pre: string, name: string) => (SECRET_NAME.test(name) ? `${pre}"${REDACTED}"` : m)));
}

export { redact };

export interface EnvLike { name?: unknown; value?: unknown; valueFrom?: unknown }
// 매니페스트 객체 안의 평문 비밀 env 찾기. 비밀은 Secret 참조(valueFrom.secretKeyRef)로만 넣는다
export function plaintextSecretEnv(doc: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.env)) {
      for (const e of o.env as EnvLike[]) {
        if (!e || typeof e.name !== "string" || typeof e.value !== "string" || e.value === "") continue;
        if (SECRET_NAME.test(e.name) || looksSecretValue(e.value)) found.push(`${path}.env.${e.name}`);
      }
    }
    for (const [k, x] of Object.entries(o)) if (k !== "env") walk(x, path ? `${path}.${k}` : k);
  };
  walk(doc, "");
  // ConfigMap data 에 비밀 모양 값
  const cm = doc as { kind?: unknown; data?: Record<string, unknown> } | null;
  if (cm?.kind === "ConfigMap" && cm.data && typeof cm.data === "object") {
    for (const [k, x] of Object.entries(cm.data)) if (typeof x === "string" && (SECRET_NAME.test(k) || looksSecretValue(x))) found.push(`data.${k}`);
  }
  return found;
}

// ── 매니페스트 정책 (샌드박스 적용 전 + PR 게이트에서 같은 함수) ─────────────
// DRAFT(ai): Kyverno restricted 의 핵심만 코드로. 진짜 클러스터는 PSS restricted 라벨로 한 번 더 막는다
export const APPLY_KINDS = ["Deployment", "Service", "ConfigMap", "HorizontalPodAutoscaler"] as const;
export type ApplyKind = (typeof APPLY_KINDS)[number];
export interface ManifestDoc { kind: ApplyKind; name: string; namespace: string | null; obj: Record<string, unknown> }
export interface PolicyResult { ok: boolean; docs: ManifestDoc[]; violations: string[] }

const containersOf = (obj: Record<string, unknown>): Array<Record<string, unknown>> => {
  const spec = (obj.spec ?? {}) as Record<string, any>;
  const pod = spec.template?.spec ?? {};
  return [...(pod.containers ?? []), ...(pod.initContainers ?? [])].filter((c: unknown) => c && typeof c === "object");
};
const podSpecOf = (obj: Record<string, unknown>) => ((obj.spec as any)?.template?.spec ?? {}) as Record<string, any>;
export const imagesOf = (obj: Record<string, unknown>) => containersOf(obj).map((c) => String(c.image ?? ""));

export function checkManifest(text: string, o: { allowedImages?: Set<string> } = {}): PolicyResult {
  const v: string[] = [];
  const docs: ManifestDoc[] = [];
  let parsed;
  try { parsed = parseAllDocuments(text); } catch (e) { return { ok: false, docs, violations: [`YAML 파싱 실패: ${(e as Error).message.slice(0, 200)}`] }; }
  for (const d of parsed) {
    if (d.errors.length) { v.push(`YAML 오류: ${d.errors[0]!.message.slice(0, 200)}`); continue; }
    const obj = d.toJSON() as Record<string, unknown> | null;
    if (obj === null || obj === undefined) continue; // 빈 문서 (--- 만)
    if (typeof obj !== "object" || Array.isArray(obj)) { v.push("매니페스트가 객체가 아님"); continue; }
    const kind = String(obj.kind ?? "");
    const meta = (obj.metadata ?? {}) as Record<string, unknown>;
    const name = String(meta.name ?? "");
    if (!(APPLY_KINDS as readonly string[]).includes(kind)) { v.push(`POL-01 허용 안 된 종류: ${kind || "(없음)"}`); continue; }
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) { v.push(`POL-02 이름이 틀림: ${name || "(없음)"}`); continue; }
    const ns = typeof meta.namespace === "string" ? meta.namespace : null;
    const pod = podSpecOf(obj);
    if (pod.hostNetwork || pod.hostPID || pod.hostIPC) v.push(`POL-03 host 네임스페이스 공유: ${kind}/${name}`);
    if (Array.isArray(pod.volumes) && pod.volumes.some((x: any) => x && x.hostPath)) v.push(`POL-03 hostPath: ${kind}/${name}`);
    if (pod.serviceAccountName && pod.serviceAccountName !== "default") v.push(`POL-03 serviceAccount 지정: ${kind}/${name}`);
    for (const c of containersOf(obj)) {
      const sc = (c.securityContext ?? {}) as Record<string, any>;
      if (sc.privileged === true || sc.allowPrivilegeEscalation === true || sc.runAsUser === 0)
        v.push(`POL-04 권한 상승: ${kind}/${name}/${String(c.name)}`);
      if (Array.isArray(sc.capabilities?.add) && sc.capabilities.add.length) v.push(`POL-04 capabilities add: ${kind}/${name}/${String(c.name)}`);
      if (o.allowedImages && !o.allowedImages.has(String(c.image ?? ""))) v.push(`POL-05 처음 보는 이미지: ${String(c.image ?? "")}`);
    }
    for (const p of plaintextSecretEnv(obj)) v.push(`POL-06 평문 비밀: ${kind}/${name} ${p}`);
    docs.push({ kind: kind as ApplyKind, name, namespace: ns, obj });
  }
  if (docs.length === 0 && v.length === 0) v.push("적용할 문서가 없음");
  return { ok: v.length === 0, docs, violations: v };
}
