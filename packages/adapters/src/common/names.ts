import { createHash } from "node:crypto";
import { AdapterError } from "./errors.js";

// 클라우드 자원 이름: 길이·문자 제한 + 전역/재사용 충돌을 피하는 결정적 이름.
// 같은 seed면 언제나 같은 이름 → planHash가 흔들리지 않는다.
export function hash6(...parts: string[]): string {
  return createHash("sha256").update(parts.join("/")).digest("hex").slice(0, 6);
}

// prefix + 잘린 앱 이름 + sep + 해시6, 전체 max 글자 이내
export function boundedName(o: { prefix?: string; app: string; seed: string[]; max: number; sep?: string }): string {
  const prefix = o.prefix ?? "";
  const sep = o.sep ?? "-";
  const h = hash6(...o.seed);
  const room = o.max - prefix.length - sep.length - h.length;
  if (room < 1) throw new AdapterError("NAME_SPACE_EXHAUSTED", `이름 공간 부족: max=${o.max}`);
  const a = o.app.replace(/[^a-z0-9]/g, "").slice(0, room);
  return `${prefix}${a}${sep}${h}`;
}
