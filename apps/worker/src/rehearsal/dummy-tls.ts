import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

// 리허설 kubernetes.io/tls 비밀의 가짜 값: 묶음 지문·비밀 이름에서 정해지는 Ed25519 자체 서명 인증서와 키 (같은 입력이면 같은 글자).
//   16진 가짜 값이면 인증서를 읽어 TLS 를 여는 앱이 리허설에서만 죽는다. 고객 값과 상관없고, 레포에 키를 두지 않는다
// DRAFT(ai): Ed25519 = 서명이 결정적이라 치환이 순수 함수로 남는다. RSA 만 읽는 앱은 여전히 리허설에서만 실패할 수 있다
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const ED25519 = seq(Buffer.from("06032b6570", "hex"));
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END ${label}-----\n`;

export function dummyTls(seed: string, name: string): { "tls.crt": string; "tls.key": string } {
  const h = (what: string) => createHash("sha256").update(`${seed}\0${name}\0${what}`).digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, h("tls.key")]), format: "der", type: "pkcs8" });
  const serial = h("serial").subarray(0, 8);
  serial[0] = (serial[0]! & 0x7f) | 0x40;   // 양수, 최소 길이 DER
  const cn = seq(tlv(0x31, seq(Buffer.from("0603550403", "hex"), tlv(0x0c, Buffer.from(name.slice(0, 64))))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), ED25519, cn,
    seq(tlv(0x17, Buffer.from("000101000000Z")), tlv(0x18, Buffer.from("99991231235959Z"))),   // RFC 5280 4.1.2.5: 만료 없음
    cn, createPublicKey(key).export({ type: "spki", format: "der" }));
  const cert = seq(tbs, ED25519, tlv(0x03, Buffer.from([0]), sign(null, tbs, key)));
  return { "tls.crt": pem("CERTIFICATE", cert), "tls.key": key.export({ type: "pkcs8", format: "pem" }) as string };
}
