import { X509Certificate } from "node:crypto";
import type { AgentReport } from "@svc/contracts";
import type { CollectBase } from "./collect.js";

// W5: 온프레 보안 사실 (kind "facts"). 보안 판정이 온프레를 "모름" 대신 측정값으로 보게 한다 (ADR-005 D3)
//   읽기만 한다 (get · auth can-i). 못 읽은 칸은 null 로 보낸다 (지어내지 않는다)
//   grants.level: 노드 목록을 읽을 수 있으면 L1 (설치 차트 grants.cluster=true), 아니면 L0
//   dbs: CloudNativePG Cluster 마다 TLS 강제·버전·인증 방식·바깥 노출
export type FactsReport = Extract<AgentReport, { kind: "facts" }>;
export type DbFact = FactsReport["dbs"][number];

interface CnpgCluster {
  metadata?: { name?: string; namespace?: string };
  spec?: { imageName?: string; postgresql?: { pg_hba?: string[] } };
  status?: { image?: string };
}
interface Service { metadata?: { namespace?: string }; spec?: { type?: string; selector?: Record<string, string> } }

// 이미지 태그의 첫 숫자 = 주 버전 (ghcr.io/cloudnative-pg/postgresql:16.4, :18.6-system-trixie). 다이제스트만 있으면 모름
export function pgMajorFromImage(image: string | undefined): number | null {
  const ref = (image ?? "").split("@")[0]!;
  const m = /:(\d+)(?:[.-]|$)/.exec(ref.slice(ref.lastIndexOf("/") + 1));   // 레지스트리 포트(host:5000/...)는 마지막 / 앞이라 안 걸린다
  return m ? Number(m[1]) : null;
}

// CNPG 는 spec.postgresql.pg_hba 줄을 자기 기본 규칙 앞에 둔다. 기본 규칙의 원격 접속 줄은 "host all all all <scram-sha-256>"
//   (host = TLS·비TLS 둘 다 받음). 그래서 비TLS 를 막으려면 앞쪽에 "hostnossl ... reject" 가 있어야 한다
//   【사실】 CloudNativePG 문서 "PostgreSQL Configuration > The pg_hba section": 사용자 줄 → 고정 기본 줄 순서, 첫 일치 규칙이 이긴다
//   DRAFT(ai): 원격 일반 접속(모든 DB·모든 사용자)만 본다. 특정 DB·사용자만 막는 줄은 강제로 치지 않는다
const CNPG_DEFAULT_REMOTE = "host all all all scram-sha-256";
export function pgHbaFacts(lines: string[] | undefined): { tlsEnforced: boolean; authMethods: string[] } {
  const rules = [...(lines ?? []), CNPG_DEFAULT_REMOTE]
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 4 && /^host(ssl|nossl)?$/.test(f[0]!));
  let tlsEnforced = false;
  for (const f of rules) {
    const [type, db, user] = f;
    const method = f[f.length - 1]!;
    if (db !== "all" || user !== "all") continue;
    if (type === "hostnossl" && method === "reject") { tlsEnforced = true; break; }
    if (type === "host" || type === "hostnossl") break;   // 비TLS 접속이 먼저 받아들여진다
  }
  const methods = new Set(rules.map((f) => f[f.length - 1]!).filter((m) => m !== "reject"));
  return { tlsEnforced, authMethods: [...methods].sort() };
}

const items = <T>(json: string): T[] => (JSON.parse(json) as { items?: T[] }).items ?? [];

// 클러스터 안 sealed-secrets 컨트롤러가 공개 봉인 인증서를 내주는 주소 (kubeseal --fetch-cert 가 Service 프록시로 읽는 것과 같은 경로 /v1/cert.pem)
// DRAFT(ai): 기본 설치(kube-system 의 sealed-secrets-controller, 포트 8080). 다르게 깔렸으면 SEALING_CERT_URL 로 바꾼다
export const DEFAULT_SEALING_CERT_URL = "http://sealed-secrets-controller.kube-system.svc:8080/v1/cert.pem";

/** 봉인 인증서 PEM 을 HTTP GET 으로 받는다. 200 이 아니거나 시간이 넘으면 throw (부르는 쪽이 칸을 비운다) */
export async function fetchSealingCert(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 5000) });
  if (!res.ok) throw new Error(`sealing cert ${res.status}`);
  return res.text();
}

// 받은 PEM 이 인증서 하나로 읽히고 RSA 공개 키인지 (sealed-secrets 는 RSA 만 쓴다). 아니면 null
export function sealingFact(pem: string, fetchedAt: string): FactsReport["sealing"] | null {
  const certPem = `${pem.trim()}\n`;
  if (!certPem.startsWith("-----BEGIN CERTIFICATE-----") || certPem.length > 16384) return null;
  try {
    if (new X509Certificate(certPem).publicKey.asymmetricKeyType !== "rsa") return null;
  } catch { return null; }
  return { certPem, fetchedAt };
}

// 클러스터가 밖으로 나가는 공인 IP 를 알려 주는 주소. 응답 본문 = IPv4 한 줄
// DRAFT(ai): 기본 https://checkip.amazonaws.com (AWS 가 운영, 인증 없음, 본문이 IP 한 줄). 고객 망이 막으면 EGRESS_IP_URL 로 바꾸고,
//   "off" 면 묻지 않는다 (그러면 워커가 중계기를 못 만들고 ONPREM_EGRESS_UNKNOWN 으로 멈춘다)
export const DEFAULT_EGRESS_IP_URL = "https://checkip.amazonaws.com";
export const EGRESS_IP_TIMEOUT_MS = 5000;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 나가는 공인 IPv4 를 HTTP GET 으로 받는다. 200 이 아니거나 5초가 넘거나 IPv4 한 줄이 아니면 throw (부르는 쪽이 칸을 비운다) */
export async function fetchEgressIp(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? EGRESS_IP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`egress ip ${res.status}`);
  const ip = (await res.text()).trim();
  if (!IPV4.test(ip)) throw new Error("egress ip: 응답이 IPv4 한 줄이 아니다");
  return ip;
}

// sealingCert: 봉인 인증서 PEM 을 가져오는 함수. 없으면 sealing 칸을 안 만든다. 실패해도 보고는 보낸다 (칸만 빠짐)
// egressIp: 나가는 공인 IP 를 가져오는 함수. 없거나 실패하면 egressIp 칸을 안 만든다 (보고는 보낸다)
export async function collectFacts(o: CollectBase & { sealingCert?: () => Promise<string>; egressIp?: () => Promise<string> }): Promise<FactsReport> {
  const sentAt = (o.now?.() ?? new Date()).toISOString();
  // kubectl auth can-i 는 "no" 면 0 이 아닌 코드로 끝난다 → 실패 = L0
  const level = await o.kubectl(["auth", "can-i", "list", "nodes"]).then((s) => (s.trim() === "yes" ? "L1" : "L0"), () => "L0" as const);
  let clusters: CnpgCluster[] = [];
  try { clusters = items<CnpgCluster>(await o.kubectl(["get", "clusters.postgresql.cnpg.io", "-A", "-o", "json"])); } catch { /* CNPG 가 없으면 DB 사실 없음 */ }
  let services: Service[] | null = null;
  try { services = items<Service>(await o.kubectl(["get", "services", "-A", "-o", "json"])); } catch { services = null; }
  const dbs: DbFact[] = clusters.slice(0, 50).map((c) => {
    const ns = c.metadata?.namespace ?? "", name = c.metadata?.name ?? "";
    const hba = pgHbaFacts(c.spec?.postgresql?.pg_hba);
    const exposed = services === null ? null : services.some((s) =>
      s.metadata?.namespace === ns && (s.spec?.type === "NodePort" || s.spec?.type === "LoadBalancer")
      && s.spec?.selector?.["cnpg.io/cluster"] === name);
    return {
      namespace: ns.slice(0, 63), cluster: name.slice(0, 63),
      majorVersion: pgMajorFromImage(c.status?.image ?? c.spec?.imageName),
      tlsEnforced: hba.tlsEnforced, authMethods: hba.authMethods.slice(0, 20), exposed,
    };
  });
  let sealing: FactsReport["sealing"] | null = null;
  if (o.sealingCert) {
    try { sealing = sealingFact(await o.sealingCert(), (o.now?.() ?? new Date()).toISOString()); } catch { sealing = null; }
  }
  let egressIp: string | null = null;
  if (o.egressIp) {
    try { const ip = (await o.egressIp()).trim(); egressIp = IPV4.test(ip) ? ip : null; } catch { egressIp = null; }
  }
  return { kind: "facts", agentVersion: o.agentVersion, sentAt, grants: { level }, dbs, ...(sealing ? { sealing } : {}), ...(egressIp ? { egressIp } : {}) };
}
