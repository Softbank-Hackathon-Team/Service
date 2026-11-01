import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

// 비밀번호 저장 (Z93). 외부 패키지 없이 node:crypto scrypt.
// 출처: OWASP Password Storage Cheat Sheet — scrypt 최소 N=2^17, r=8, p=1. 소금은 사용자마다 무작위 16바이트.
// 저장 모양: scrypt$N$r$p$소금(base64url)$해시(base64url). 매개변수를 같이 저장해서 나중에 N 을 올려도 옛 해시가 그대로 검증된다
// DRAFT(ai) Z93: argon2id 가 OWASP 1순위지만 native 패키지(npm install)가 필요하다 → 2순위 scrypt 로 의존성 0
export const SCRYPT_DEFAULT = { N: 2 ** 17, r: 8, p: 1, keylen: 64 } as const;
export const PASSWORD_MIN = 8;   // OWASP Authentication Cheat Sheet: 최소 8 (MFA 없음)
export const PASSWORD_MAX = 256; // 아주 긴 입력으로 CPU 를 오래 쓰게 하는 것 막기 (OWASP 권장 상한 ≥64)

const scrypt = (pw: string, salt: Buffer, keylen: number, o: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, keylen, o, (e, k) => (e ? rej(e) : res(k))));
// node 기본 maxmem 은 32MB 라 N=2^17·r=8(128MB)에서 오류가 난다 → 필요한 만큼 + 여유
const maxmem = (N: number, r: number) => 128 * N * r + 16 * 1024 * 1024;

function paramsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  // 시험에서만 낮춘다 (AUTH_SCRYPT_N=16384). 운영은 비워 둔다
  const n = Number(env.AUTH_SCRYPT_N);
  return Number.isInteger(n) && n >= 2 ** 14 && (n & (n - 1)) === 0 ? { ...SCRYPT_DEFAULT, N: n } : SCRYPT_DEFAULT;
}

export async function hashPassword(pw: string, p: { N: number; r: number; p: number; keylen: number } = paramsFromEnv()): Promise<string> {
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) throw new RangeError(`password length must be ${PASSWORD_MIN}..${PASSWORD_MAX}`);
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize("NFKC"), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: maxmem(p.N, p.r) });
  return `scrypt$${p.N}$${p.r}$${p.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function parseHash(stored: string) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 저장 값이 엉터리여도 메모리를 터뜨리지 않게 범위를 막는다
  if (N < 2 ** 10 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(m[4]!, "base64url"), key = Buffer.from(m[5]!, "base64url");
  if (salt.length < 16 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (pw.length > PASSWORD_MAX) return false;
  const h = stored ? parseHash(stored) : null;
  if (!h) { await dummyVerify(pw); return false; }
  const got = await scrypt(pw.normalize("NFKC"), h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r) });
  return timingSafeEqual(got, h.key);
}

// 없는 이메일·비밀번호 없는 계정도 같은 시간만큼 계산한다 (응답 시간으로 계정 있는지 알아내기 막기, OWASP Authentication Cheat Sheet)
let dummy: Promise<string> | null = null;
export async function dummyVerify(pw: string) {
  dummy ??= hashPassword("dummy-password-for-timing");
  const h = parseHash(await dummy)!;
  await scrypt(pw.slice(0, PASSWORD_MAX).normalize("NFKC"), h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h.N, h.r) });
}
