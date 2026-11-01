import pg from "pg";

// 식별자(표·구독·슬롯 이름)는 SQL에 끼워 넣어야 하므로 모양을 먼저 검사하고 따옴표로 감싼다.
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
export function assertName(n: string, what = "name"): string {
  if (!NAME.test(n)) throw new Error(`invalid ${what}: ${JSON.stringify(n)} (a-z, 0-9, _ only, max 63)`);
  return n;
}
export const ident = (n: string) => pg.escapeIdentifier(n);
export const lit = (s: string) => pg.escapeLiteral(s);
export const qualified = (schema: string, table: string) => `${ident(schema)}.${ident(table)}`;

export const now = () => performance.now();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => Promise<boolean>, { timeoutMs, everyMs = 20, what }: { timeoutMs: number; everyMs?: number; what: string }) {
  const t0 = now();
  for (;;) {
    if (await cond()) return now() - t0;
    if (now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${what}`);
    await sleep(everyMs);
  }
}
