import type { EntriesV2, FieldMetaV2 } from "@svc/contracts";

// GW-2 DRAFT(ai): 앱 호스트 이름이 걸린 출발 공개 DNS 레코드(Route53·Cloud DNS) → IR entry.hosts[].dns (기록만).
//   가중치 전환·컷오버 때 사람이 볼 계획 줄(PC-V2-DNS-n)까지만 잇는다. 도착에서 레코드를 바꾸는 건 범위 밖.
//   원본 종류: "dns.record"(레코드 하나), "dns.unread"(그 업체 영역을 못 읽음 + 까닭)
//   순수 함수. 클라우드 읽기 결과(JSON) → 원본 변환도 여기(route53RecordsOf·cloudDnsRecordsOf)
// TODO(human): 관찰 역할에 DNS 읽기 권한이 아직 없다. 넣을지 정하면 권한 표(common/observe-permissions.ts)·연결 템플릿에 더하고
//   discover(aws·gcp)에서 아래 명령을 부르게 한다. 그 전까지 discover 는 "dns.unread" 만 남겨 계획 줄이 "못 읽음" 검토로 뜬다.
//     AWS: route53 list-hosted-zones (route53:ListHostedZones) → 공개 영역마다 route53 list-resource-record-sets (route53:ListResourceRecordSets)
//     GCP: gcloud dns managed-zones list (dns.managedZones.list) → visibility public 영역마다 gcloud dns record-sets list (dns.resourceRecordSets.list)

export const DNS_RECORD_KIND = "dns.record";
export const DNS_UNREAD_KIND = "dns.unread";
type DnsRecordV2 = NonNullable<EntriesV2["hosts"][number]["dns"]>["records"][number];
export interface RawDnsRecord extends DnsRecordV2 { kind: typeof DNS_RECORD_KIND }
export interface RawDnsUnread { kind: typeof DNS_UNREAD_KIND; provider: "route53" | "clouddns"; reason: string }
type Obj = Record<string, unknown>;

const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);
const dot = (n: string) => (n.endsWith(".") ? n : `${n}.`).toLowerCase();
// Route53 는 이름 안 * 를 \052 로 돌려준다
const unescape = (n: string) => n.replace(/\\052/g, "*");

/** 이 레코드 이름이 호스트를 가리키나 (같은 이름, 또는 와일드카드 한 단계) */
export function recordCovers(record: string, host: string): boolean {
  const r = dot(unescape(record)), h = dot(host);
  if (r === h) return true;
  return r.startsWith("*.") && h.endsWith(r.slice(1)) && !h.slice(0, h.length - r.length + 1).includes(".");
}

/** aws route53 list-resource-record-sets 결과 → 원본 (주소 종류 A·AAAA·CNAME 만) */
export function route53RecordsOf(zone: string, json: unknown): RawDnsRecord[] {
  const sets = (json && typeof json === "object" && Array.isArray((json as Obj).ResourceRecordSets) ? (json as Obj).ResourceRecordSets : []) as Obj[];
  return sets.filter((s) => ADDRESS_TYPES.has(String(s.Type))).map((s) => {
    const alias = s.AliasTarget as Obj | undefined;
    const policy = s.Failover ? "failover" : s.Region ? "latency" : s.GeoLocation ? "geo" : s.MultiValueAnswer ? "multivalue" : s.CidrRoutingConfig ? "cidr" : undefined;
    return {
      kind: DNS_RECORD_KIND, provider: "route53" as const, zone: dot(zone), name: unescape(String(s.Name)), type: String(s.Type),
      ...(typeof s.TTL === "number" ? { ttl: s.TTL } : {}),
      values: (Array.isArray(s.ResourceRecords) ? s.ResourceRecords as Obj[] : []).map((x) => String(x.Value)).slice(0, 20),
      ...(alias?.DNSName ? { alias: String(alias.DNSName) } : {}),
      ...(typeof s.Weight === "number" ? { weight: s.Weight } : {}),
      ...(s.SetIdentifier ? { setId: String(s.SetIdentifier) } : {}),
      ...(policy ? { policy } : {}),
    };
  });
}

/** gcloud dns record-sets list --format json 결과 → 원본 */
export function cloudDnsRecordsOf(zone: string, json: unknown): RawDnsRecord[] {
  const sets = (Array.isArray(json) ? json : []) as Obj[];
  return sets.filter((s) => ADDRESS_TYPES.has(String(s.type))).map((s) => {
    const rp = s.routingPolicy as Obj | undefined;
    const policy = rp ? (rp.wrr ? "wrr" : rp.geo ? "geo" : rp.primaryBackup ? "failover" : "routing") : undefined;
    return {
      kind: DNS_RECORD_KIND, provider: "clouddns" as const, zone: dot(zone), name: String(s.name), type: String(s.type),
      ...(typeof s.ttl === "number" ? { ttl: s.ttl } : {}),
      values: (Array.isArray(s.rrdatas) ? s.rrdatas as unknown[] : []).map(String).slice(0, 20),
      ...(policy ? { policy } : {}),
    };
  });
}

/** STUB: 권한이 정해지기 전 discover 가 남기는 "못 읽음" 표시 (위 TODO(human)) */
export const dnsUnreadStub = (provider: RawDnsUnread["provider"]): RawDnsUnread => ({
  kind: DNS_UNREAD_KIND, provider,
  reason: provider === "route53" ? "관찰 역할에 route53:ListHostedZones·ListResourceRecordSets 권한이 아직 없음" : "관찰 역할에 dns.managedZones.list·dns.resourceRecordSets.list 권한이 아직 없음",
});

/** entry 호스트마다 그 이름을 가리키는 레코드를 붙인다 (제자리). DNS 원본이 하나도 없으면(온프레 등) 손대지 않는다 */
export function attachDns(entry: EntriesV2 | undefined, items: Obj[], fieldMeta: FieldMetaV2): void {
  if (!entry) return;
  const records = items.filter((i) => i.kind === DNS_RECORD_KIND) as unknown as RawDnsRecord[];
  const unread = items.filter((i) => i.kind === DNS_UNREAD_KIND) as unknown as RawDnsUnread[];
  if (!records.length && !unread.length) return;
  for (const h of entry.hosts) {
    const host = h.hostnames[0]!;
    // 같은 이름이 있으면 와일드카드는 안 붙인다 (DNS 규칙: 정확한 이름이 이김)
    const exact = records.filter((r) => dot(unescape(r.name)) === dot(host));
    const hit = (exact.length ? exact : records.filter((r) => recordCovers(r.name, host)))
      .sort((a, b) => `${a.provider}/${a.name}/${a.type}/${a.setId ?? ""}`.localeCompare(`${b.provider}/${b.name}/${b.type}/${b.setId ?? ""}`)).slice(0, 10);
    const recs = hit.map(({ kind: _k, ...r }) => r);
    if (unread.length && !recs.length) {
      h.dns = { read: false, records: [] };
      fieldMeta[`entry.${host}.dns`] = { source: unread.map((u) => `dns:${u.provider}`).join(","), confidence: 0.6, needs_review: true,
        rationale: `출발 공개 DNS 를 못 읽음 (${unread.map((u) => u.reason).join(" / ")}) → 전환·컷오버 때 바꿀 레코드를 사람이 확인` };
      continue;
    }
    h.dns = { read: true, records: recs };
    if (!recs.length) fieldMeta[`entry.${host}.dns`] = { source: "dns", confidence: 0.9, needs_review: true,
      rationale: "출발 클라우드 공개 영역에서 이 호스트 레코드를 못 찾음 → 다른 DNS 업체(Cloudflare 등)일 수 있음. 사람이 확인" };
    else if (recs.some((r) => r.policy || r.weight !== undefined)) fieldMeta[`entry.${host}.dns`] = { source: `dns:${recs[0]!.provider}`, confidence: 0.9, needs_review: true,
      rationale: "출발 DNS 가 이미 가중치·장애 조치 같은 라우팅 정책을 씀 → 전환 때 같이 볼 것" };
  }
}
