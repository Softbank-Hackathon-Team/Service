// 이전별 비밀(복제 역할 비밀번호 · SSH 터널 키 · CNPG 서버 TLS)을 만들어 gitops 레포에 SealedSecret 으로 실어 보낸다 (pull 방식)
// DECISION(team): 온프레 CNPG 로의 DB 복제는 이전마다 최소 권한 역할 + 플랫폼이 발급한 CNPG 서버 인증서 + SSH 터널을 쓴다.
//   플랫폼은 비밀을 저장하지 않는다: 마스터 키 + 번호로 "파생"하고, 클러스터 안 sealed-secrets 컨트롤러만 풀 수 있는
//   Bitnami SealedSecret 으로 봉인해 gitops 레포에 커밋한다 (2026-11-05 팀 결정)
// 순수 함수가 대부분이다. 바깥 프로세스는 issueServerCert 의 openssl 하나뿐 (Node 에 X.509 만드는 API 가 없다)
import { execFile } from "node:child_process";
import {
  X509Certificate, constants, createCipheriv, createECDH, createHash, createHmac, createPrivateKey, createPublicKey,
  generateKeyPairSync, publicEncrypt, randomBytes, type KeyObject,
} from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 1. 비밀번호 파생 ───────────────────────────────────────────────────────────────
// 마스터 키가 이보다 짧으면 거부한다 (HMAC 키 엔트로피 하한)
// DRAFT(ai): 32자. packages/replication 의 derive: 와 같은 하한이어야 한다 (합칠 때 확인)
export const MIN_MASTER_KEY_LENGTH = 32;

export class MigrationSecretError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "MigrationSecretError"; }
}

function needMasterKey(masterKey: string): void {
  if (typeof masterKey !== "string" || masterKey.length < MIN_MASTER_KEY_LENGTH) {
    // 값은 메시지에 넣지 않는다 (길이만)
    throw new MigrationSecretError("MASTER_KEY_TOO_SHORT", `REPL_SECRET_MASTER_KEY 는 ${MIN_MASTER_KEY_LENGTH}자 이상이어야 한다`);
  }
}

/**
 * derive:<purpose> = base64url(HMAC-SHA256(masterKey, `${tenantId}:${migrationId}:${side}:${purpose}`)).slice(0, 32)
 * 주의: packages/replication 의 derive: 해석과 글자 하나까지 같아야 한다. 다르면 워커가 봉인한 비밀번호와
 *   복제 코드가 접속에 쓰는 비밀번호가 달라 복제가 인증 실패한다. 나중에 한 곳으로 합친다 (TODO(human): 합칠 위치)
 */
export function derivePassword(masterKey: string, tenantId: string, migrationId: string, side: string, purpose: string): string {
  needMasterKey(masterKey);
  return createHmac("sha256", masterKey).update(`${tenantId}:${migrationId}:${side}:${purpose}`).digest("base64url").slice(0, 32);
}

// ── 2. SSH 키 쌍 파생 (ed25519, 결정적) ────────────────────────────────────────────
// ed25519 개인 키 PKCS8 DER = 고정 머리 16바이트 + 32바이트 seed (RFC 8410 §7: OneAsymmetricKey, OID 1.3.101.112)
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sshString = (b: Buffer | string) => { const v = typeof b === "string" ? Buffer.from(b) : b; return Buffer.concat([u32(v.length), v]); };

function ed25519FromSeed(seed: Buffer): { priv: KeyObject; pub: Buffer } {
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return { priv, pub: spki.subarray(spki.length - 32) };   // SPKI 의 BIT STRING 끝 32바이트 = 원시 공개 키
}

export interface SshKeypair { privateKeyOpenssh: string; publicKeyLine: string }

/**
 * seed = HMAC-SHA256(masterKey, `ssh:${tenantId}:${migrationId}`) 로 ed25519 키 쌍을 만든다. 같은 입력이면 같은 키.
 * privateKeyOpenssh: "openssh-key-v1" 형식, 암호 없음 (PROTOCOL.key, OpenSSH sshkey.c sshkey_private_to_blob2 와 같은 배치)
 * publicKeyLine: authorized_keys 한 줄 `ssh-ed25519 AAAA... <comment>`
 */
export function deriveSshKeypair(masterKey: string, tenantId: string, migrationId: string, comment = `svc-migration-${migrationId}`): SshKeypair {
  needMasterKey(masterKey);
  return opensshEd25519(createHmac("sha256", masterKey).update(`ssh:${tenantId}:${migrationId}`).digest(), comment);
}

/**
 * 중계기(출발 계정 EC2) sshd 의 ed25519 호스트 키. seed = HMAC-SHA256(masterKey, `ssh-host:${tenantId}:${migrationId}`).
 * 플랫폼이 EC2 를 만들기 전에 이미 공개 키를 안다 → 터널의 known_hosts 를 처음부터 고정한다 (ssh-keyscan 첫 접속 믿기 없음).
 * 터널 키(ssh:…)와 글이 달라 서로 다른 키가 된다. 개인 키는 중계기 user-data 로만 나간다 (저장·로그 없음)
 */
export function deriveSshHostKey(masterKey: string, tenantId: string, migrationId: string, comment = `svc-relay-host-${migrationId}`): SshKeypair {
  needMasterKey(masterKey);
  return opensshEd25519(createHmac("sha256", masterKey).update(`ssh-host:${tenantId}:${migrationId}`).digest(), comment);
}

/** known_hosts 한 줄 `<호스트> ssh-ed25519 AAAA…` (포트 22 가 아니면 `[호스트]:포트`). 공개 키 줄의 comment 는 뺀다 */
export function knownHostsLine(host: string, publicKeyLine: string, port = 22): string {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new MigrationSecretError("SSH_HOST_INVALID", "known_hosts 호스트는 이름 또는 IPv4 만");
  const [type, key] = publicKeyLine.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !key) throw new MigrationSecretError("SSH_KEY_INVALID", "ssh-ed25519 공개 키 줄이 아니다");
  return `${port === 22 ? host : `[${host}]:${port}`} ${type} ${key}`;
}

// seed 32바이트 → OpenSSH 형식 ed25519 키 쌍 (터널 키·중계기 호스트 키가 같이 쓴다)
function opensshEd25519(seed: Buffer, comment: string): SshKeypair {
  if (/[\r\n]/.test(comment)) throw new MigrationSecretError("SSH_COMMENT_INVALID", "comment 에 줄바꿈을 넣을 수 없다");
  const { pub } = ed25519FromSeed(seed);
  const pubBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  // checkint 두 번(같은 값): 원래는 무작위. 같은 입력 → 같은 파일이 되도록 seed 에서 뽑는다 (암호 없는 파일이라 보안 의미 없음)
  const check = createHash("sha256").update("checkint").update(seed).digest().readUInt32BE(0);
  let priv = Buffer.concat([
    u32(check), u32(check),
    sshString("ssh-ed25519"), sshString(pub),
    sshString(Buffer.concat([seed, pub])),   // OpenSSH ed25519 개인 키 = seed(32) || 공개 키(32)
    sshString(comment),
  ]);
  // 암호 없음("none")의 블록 크기 8 에 맞춰 1,2,3… 으로 채운다
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"), sshString("none"), sshString(""),   // ciphername, kdfname, kdfoptions
    u32(1), sshString(pubBlob), sshString(priv),
  ]);
  const b64 = blob.toString("base64").match(/.{1,70}/g)!.join("\n");
  return {
    privateKeyOpenssh: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKeyLine: `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`,
  };
}

// ── 3. CNPG 서버 인증서 (이전마다 쓰고 버리는 CA) ────────────────────────────────────
// DNS 이름 한 칸 (소문자 RFC 1123). -subj·확장 파일에 그대로 들어가므로 '/', '=', ',', 줄바꿈이 못 들어오게 막는다
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** CNPG 가 만드는 세 Service(-rw, -r, -ro)의 클러스터 안 이름 4가지씩 (CNPG 문서 "Certificates > Server certificates" 의 SAN 목록과 같은 모양) */
// DRAFT(ai): 클러스터 도메인 cluster.local 고정. 다른 도메인을 쓰는 온프레가 나오면 인자로 뺀다
export function cnpgServerDnsNames(cluster: string, namespace: string): string[] {
  return ["rw", "r", "ro"].flatMap((s) => {
    const svc = `${cluster}-${s}`;
    return [svc, `${svc}.${namespace}`, `${svc}.${namespace}.svc`, `${svc}.${namespace}.svc.cluster.local`];
  });
}

/** CNPG 서버 CA 개인 키 seed = HMAC-SHA256(masterKey, `ca:${tenantId}:${migrationId}`) 32바이트.
 *  같은 이전이면 같은 CA 키 → 다시 발급해도 CA 공개 키가 같다 (워커는 도착 줄 ca_pem 으로 확인한다). 키 자체는 남기지 않는다 */
export function deriveCaSeed(masterKey: string, tenantId: string, migrationId: string): Buffer {
  needMasterKey(masterKey);
  return createHmac("sha256", masterKey).update(`ca:${tenantId}:${migrationId}`).digest();
}

export interface ServerCertInput {
  // 있으면 CA 개인 키를 이 32바이트 seed 에서 파생한다 (나중에 같은 CA 로 다시 발급할 수 있게). 없으면 무작위 = 진짜 일회용
  caSeed?: Buffer | null;
  cnName: string;
  dnsNames: string[];
  days: number;
}
export interface ServerCert { caCertPem: string; serverCertPem: string; serverKeyPem: string }
export interface OpensslDeps { opensslBin?: string; timeoutMs?: number }

// P-256 개인 키를 seed 에서 만든다: d = SHA-256("svc-ca-p256" || seed || 카운터), 0 < d < n 이 될 때까지 카운터를 올린다
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
function p256FromSeed(seed: Buffer): KeyObject {
  for (let i = 0; ; i++) {
    const d = createHash("sha256").update("svc-ca-p256").update(seed).update(u32(i)).digest();
    const v = BigInt(`0x${d.toString("hex")}`);
    if (v === 0n || v >= P256_N) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey();   // 04 || x(32) || y(32)
    return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: d.toString("base64url"),
      x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") }, format: "jwk" });
  }
}

function runOpenssl(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new MigrationSecretError("OPENSSL_MISSING", `openssl 실행 파일(${bin})이 없다. 워커 이미지에 openssl 을 넣어야 한다`));
      }
      // stderr 에 키 내용은 안 나온다 (파일 경로만 넘긴다). 길이만 자른다
      reject(new MigrationSecretError("OPENSSL_FAILED", `openssl ${args[0]}: ${String(stderr || err.message).trim().slice(0, 300)}`));
    });
  });
}

/**
 * CNPG 서버용: 일회용 CA 인증서 + 그 CA 가 서명한 서버 인증서·키.
 * CA 개인 키는 돌려주지도 남기지도 않는다 (임시 폴더 0700 안에서만 쓰고 지운다). 워커는 caCertPem 으로 검증만 한다.
 * CNPG 에는 serverTLSSecret(tls.crt·tls.key) + serverCASecret(ca.crt 만) 로 넣는다 (CA 키 없이도 된다)
 */
export async function issueServerCert(i: ServerCertInput, d: OpensslDeps = {}): Promise<ServerCert> {
  if (!DNS_NAME.test(i.cnName)) throw new MigrationSecretError("CERT_NAME_INVALID", "cnName 은 소문자 DNS 이름이어야 한다");
  if (i.dnsNames.length === 0 || i.dnsNames.length > 100 || !i.dnsNames.every((n) => DNS_NAME.test(n))) {
    throw new MigrationSecretError("CERT_NAME_INVALID", "dnsNames 는 1~100개의 소문자 DNS 이름이어야 한다");
  }
  // DRAFT(ai): 최대 3650일. 이전 하나의 수명보다 넉넉하게
  if (!Number.isInteger(i.days) || i.days < 1 || i.days > 3650) throw new MigrationSecretError("CERT_DAYS_INVALID", "days 는 1~3650 정수");
  if (i.caSeed != null && i.caSeed.length !== 32) throw new MigrationSecretError("CA_SEED_INVALID", "caSeed 는 32바이트");

  // DRAFT(ai): 키는 ECDSA P-256 (CNPG 가 스스로 만드는 인증서와 같은 종류). 키는 Node 로 만들고 openssl 은 X.509 서명만 한다
  const caKey = i.caSeed ? p256FromSeed(i.caSeed) : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const serverKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const serverKeyPem = serverKey.export({ format: "pem", type: "pkcs8" }) as string;
  const bin = d.opensslBin ?? "openssl";
  const timeoutMs = d.timeoutMs ?? 30_000;
  const days = String(i.days);

  const dir = await mkdtemp(join(tmpdir(), "svc-cert-"));
  try {
    await chmod(dir, 0o700);
    await writeFile(join(dir, "ca.key"), caKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
    await writeFile(join(dir, "server.key"), serverKeyPem, { mode: 0o600 });
    await writeFile(join(dir, "server.ext"), [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${i.dnsNames.map((n) => `DNS:${n}`).join(",")}`,
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid",
      "",
    ].join("\n"), { mode: 0o600 });
    // CA: 경로 길이 0 (중간 CA 를 못 만든다), 인증서 서명만
    await runOpenssl(bin, ["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", days, "-subj", `/CN=svc-migration-ca.${i.cnName}`,
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-out", "ca.crt"], dir, timeoutMs);
    await runOpenssl(bin, ["req", "-new", "-key", "server.key", "-subj", `/CN=${i.cnName}`, "-out", "server.csr"], dir, timeoutMs);
    await runOpenssl(bin, ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-set_serial", `0x${randomBytes(16).toString("hex").replace(/^[89a-f]/, "1")}`,   // 양수 128비트 일련번호 (일련번호 파일을 안 남긴다)
      "-days", days, "-sha256", "-extfile", "server.ext", "-out", "server.crt"], dir, timeoutMs);
    const caCertPem = await readFile(join(dir, "ca.crt"), "utf8");
    const serverCertPem = await readFile(join(dir, "server.crt"), "utf8");
    // 만든 것이 서로 맞는지 Node 로 한 번 더 본다 (openssl 판에 따라 조용히 다른 걸 내는 경우를 막는다)
    const ca = new X509Certificate(caCertPem), srv = new X509Certificate(serverCertPem);
    if (!ca.ca || !srv.verify(ca.publicKey) || !srv.checkPrivateKey(serverKey)) {
      throw new MigrationSecretError("OPENSSL_FAILED", "openssl 이 만든 인증서가 CA·키와 맞지 않는다");
    }
    return { caCertPem, serverCertPem, serverKeyPem };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 4. SealedSecret 봉인 (strict 범위) ─────────────────────────────────────────────
// 【사실】 upstream github.com/bitnami-labs/sealed-secrets 태그 v0.40.0 (2026-09-10 공개, 시험 VM 의 컨트롤러 판)
//   pkg/crypto/crypto.go HybridEncrypt:
//     세션 키 32바이트 무작위 → RSA-OAEP(SHA-256, label) 로 세션 키 암호화
//     → 출력 = uint16 BE(RSA 암호문 길이) || RSA 암호문 || AES-256-GCM(세션 키, 12바이트 0 nonce, 추가 데이터 없음) 암호문+태그(16)
//   pkg/apis/sealedsecrets/v1alpha1/sealedsecret_expansion.go:
//     EncryptionLabel strict = `${namespace}/${name}`, NewSealedSecret 은 값마다 따로 HybridEncrypt → base64.StdEncoding
//   pkg/kubeseal/kubeseal.go ParseKey: PEM 의 첫 인증서, RSA 공개 키여야 함, 만료된 인증서는 거부
// Go rsa.EncryptOAEP(sha256.New(), …) 는 MGF1 에도 SHA-256 을 쓴다. Node 는 oaepHash 를 주면 OpenSSL 이 MGF1 도 같은 해시로 맞춘다
//   (확인: upstream singleDecrypt 를 Go 표준 라이브러리로 옮긴 복호기가 이 함수의 출력을 풀었고, 다른 label 이면 RSA 단계에서 거부했다. 2026-11-05 1회, 레포 밖)
export const SEALED_SECRETS_UPSTREAM_TAG = "v0.40.0";
const K8S_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_KEY = /^[-._a-zA-Z0-9]{1,253}$/;

/** 컨트롤러 공개 인증서 PEM → RSA 공개 키. kubeseal ParseKey 와 같은 규칙 (첫 인증서 · RSA · 만료 거부) */
export function sealingPublicKey(certPem: string, now: Date = new Date()): KeyObject {
  let cert: X509Certificate;
  try { cert = new X509Certificate(certPem); } catch {
    throw new MigrationSecretError("SEALING_CERT_INVALID", "봉인 인증서 PEM 을 읽을 수 없다");
  }
  if (cert.publicKey.asymmetricKeyType !== "rsa") throw new MigrationSecretError("SEALING_CERT_INVALID", "봉인 인증서는 RSA 공개 키여야 한다");
  if (now.getTime() > new Date(cert.validTo).getTime()) throw new MigrationSecretError("SEALING_CERT_EXPIRED", `봉인 인증서가 ${cert.validTo} 에 만료됐다`);
  return cert.publicKey;
}

function sealWith(pub: KeyObject, label: string, plaintext: Buffer): string {
  const sessionKey = randomBytes(32);
  const rsaCt = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(label) }, sessionKey);
  if (rsaCt.length > 0xffff) throw new MigrationSecretError("SEALING_CERT_INVALID", "RSA 키가 너무 크다");
  const len = Buffer.alloc(2); len.writeUInt16BE(rsaCt.length);
  // 세션 키를 한 번만 쓰므로 0 nonce 가 안전하다 (upstream 과 같은 이유)
  const gcm = createCipheriv("aes-256-gcm", sessionKey, Buffer.alloc(12));
  const ct = Buffer.concat([gcm.update(plaintext), gcm.final(), gcm.getAuthTag()]);
  return Buffer.concat([len, rsaCt, ct]).toString("base64");
}

function needSecretRef(namespace: string, secretName: string): void {
  if (!NS_NAME.test(namespace)) throw new MigrationSecretError("SEALED_NAME_INVALID", "namespace 는 RFC 1123 label 이어야 한다 (strict 범위는 namespace 필수)");
  if (!K8S_NAME.test(secretName)) throw new MigrationSecretError("SEALED_NAME_INVALID", "secret 이름은 RFC 1123 subdomain 이어야 한다");
}

/** 값 하나를 strict 범위(이 namespace 의 이 이름 Secret 에서만 풀림)로 봉인. 결과 = encryptedData 의 값 한 칸 (base64 std) */
export function sealSecretValue(certPem: string, namespace: string, secretName: string, plaintext: Buffer): string {
  needSecretRef(namespace, secretName);
  return sealWith(sealingPublicKey(certPem), `${namespace}/${secretName}`, plaintext);
}

// 차트 계약 values.sealedSecrets[] = { name, type?, encryptedData } 의 한 칸 (type 은 부르는 쪽이 붙인다)
export interface SealedSecretValues { name: string; encryptedData: Record<string, string> }

export function sealedSecretValues(certPem: string, namespace: string, name: string, data: Record<string, string | Buffer>): SealedSecretValues {
  needSecretRef(namespace, name);
  const pub = sealingPublicKey(certPem);
  const keys = Object.keys(data).sort();   // 같은 입력 → 같은 키 순서 (값은 매번 다르다: 무작위 세션 키)
  if (keys.length === 0) throw new MigrationSecretError("SEALED_DATA_EMPTY", "봉인할 값이 없다");
  const encryptedData: Record<string, string> = {};
  for (const k of keys) {
    if (!SECRET_KEY.test(k)) throw new MigrationSecretError("SEALED_KEY_INVALID", `Secret 키 이름이 틀렸다: ${k.slice(0, 60)}`);
    const v = data[k]!;
    encryptedData[k] = sealWith(pub, `${namespace}/${name}`, typeof v === "string" ? Buffer.from(v, "utf8") : v);
  }
  return { name, encryptedData };
}
