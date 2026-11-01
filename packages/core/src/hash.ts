import { createHash } from "node:crypto";

// 키를 재귀로 정렬한 JSON (지문이 키 순서에 흔들리지 않게)
// L1: Date처럼 toJSON이 있는 값은 JSON.stringify와 같게 먼저 바꾼다 (안 그러면 Date가 {}가 되어
// DB(jsonb에는 ISO 문자열로 들어감)에서 다시 계산한 지문과 달라진다)
export function canonical(v: unknown): string {
  if (v && typeof (v as { toJSON?: unknown }).toJSON === "function") v = (v as { toJSON: () => unknown }).toJSON();
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// 멱등 키용 요청 지문: 메서드 + 경로(쿼리 제외) + 본문
export function requestHash(method: string, path: string, body: unknown): string {
  return sha256(`${method.toUpperCase()} ${path.split("?")[0]}\n${canonical(body ?? null)}`);
}
