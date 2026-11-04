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

export async function collectFacts(o: CollectBase): Promise<FactsReport> {
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
  return { kind: "facts", agentVersion: o.agentVersion, sentAt, grants: { level }, dbs };
}
