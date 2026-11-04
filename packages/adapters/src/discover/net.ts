import { arr, CliError, get, runJson, str, type CliDeps } from "../common/cli.js";
import { unreadOrThrow } from "../common/unread.js";

// E-1·E-2: 출발 네트워크 사실 두 가지 (읽기만).
//   E-1 나가는 IP: 출발 앱이 밖으로 나갈 때 쓰는 고정 IP (AWS NAT 게이트웨이 공인 IP, GCP Cloud NAT 수동 주소). 파트너 허용 목록에 들어 있을 수 있다
//   E-2 사설 DNS: 출발 VPC 에 붙은 사설 영역(Route 53 private hosted zone, Cloud DNS private zone)의 A·AAAA·CNAME 레코드
//   도착에 고정 IP·사설 영역을 만드는 건 이 파일 몫이 아님 (계획 줄로만 드러냄). 못 읽으면 notes 에 이유, 값은 지어내지 않음
//   PF-A3: 못 읽음 ≠ 없음 → 일시 오류는 SOURCE_TRANSIENT(재시도), 그 밖은 import.unread 줄(check.unread.net.egress·dns.private 검토)
// OBSROLE: 이 파일이 부르는 명령의 권한. 명령을 바꾸면 같이 바꾼다
export const AWS_NET_READ_ACTIONS = ["ec2:DescribeNatGateways", "route53:ListHostedZonesByVPC", "route53:ListResourceRecordSets"] as const;
export const GCP_NET_READ_PERMISSIONS = ["compute.routers.list", "compute.addresses.list", "dns.managedZones.list", "dns.resourceRecordSets.list"] as const;

type Obj = Record<string, unknown>;
// DRAFT(ai): 영역 10개, 영역마다 레코드 500개까지 (호출 수·IR 크기 제한). 넘으면 notes
const MAX_ZONES = 10, MAX_RECORDS = 500;
const RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);
const undot = (s: string) => s.replace(/\.$/, "").toLowerCase();

export interface RawEgress { kind: "net.egress"; source: string; ips: string[]; fixed: boolean | null }
export interface RawDnsRecord { kind: "dns.record"; zone: string; name: string; type: string; values: string[] }

export async function readAwsNet(d: CliDeps, region: string, vpcId: string | null, notes: string[]): Promise<Obj[]> {
  if (!vpcId) return [];
  const r = ["--region", region, "--output", "json"];
  const out: Obj[] = [];
  try {
    const nats = arr(get(await runJson(d, "aws", ["ec2", "describe-nat-gateways", "--filter", `Name=vpc-id,Values=${vpcId}`, ...r]), "NatGateways"))
      .filter((n) => n.State === "available");
    const ips = [...new Set(nats.flatMap((n) => arr(n.NatGatewayAddresses).map((a) => str(a.PublicIp)).filter((x): x is string => !!x)))].sort();
    out.push({ kind: "net.egress", source: "aws:nat-gateway", ips, fixed: nats.length ? true : null } satisfies RawEgress);
  } catch (e) { if (!(e instanceof CliError)) throw e; notes.push(`NAT 게이트웨이 못 읽음 → 출발 나가는 IP 모름: ${e.message.slice(0, 160)}`); out.push(unreadOrThrow(e, "net.egress", "NAT 게이트웨이(출발 나가는 IP)")); }
  try {
    const zones = arr(get(await runJson(d, "aws", ["route53", "list-hosted-zones-by-vpc", "--vpc-id", vpcId, "--vpc-region", region, "--output", "json"]), "HostedZoneSummaries"))
      .sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
    if (zones.length > MAX_ZONES) notes.push(`사설 DNS 영역 ${zones.length}개 중 앞 ${MAX_ZONES}개만 읽음`);
    for (const z of zones.slice(0, MAX_ZONES)) {
      const zone = undot(String(z.Name ?? "")), id = String(z.HostedZoneId ?? "");
      const sets = arr(get(await runJson(d, "aws", ["route53", "list-resource-record-sets", "--hosted-zone-id", id, "--max-items", String(MAX_RECORDS), "--output", "json"]), "ResourceRecordSets"));
      for (const s of sets) {
        const type = String(s.Type ?? "");
        if (!RECORD_TYPES.has(type)) continue;
        const alias = str(get(s, "AliasTarget", "DNSName"));
        const values = alias ? [undot(alias)] : arr(s.ResourceRecords).map((x) => str(x.Value)).filter((x): x is string => !!x).map(undot);
        out.push({ kind: "dns.record", zone, name: undot(String(s.Name ?? "")), type, values } satisfies RawDnsRecord);
      }
    }
  } catch (e) { if (!(e instanceof CliError)) throw e; notes.push(`Route 53 사설 영역 못 읽음: ${e.message.slice(0, 160)}`); out.push(unreadOrThrow(e, "dns.private", "Route 53 사설 영역")); }
  return out;
}

export async function readGcpNet(d: CliDeps, project: string, notes: string[]): Promise<Obj[]> {
  const p = ["--project", project, "--format", "json"];
  const out: Obj[] = [];
  try {
    const routers = arr(await runJson(d, "gcloud", ["compute", "routers", "list", ...p]));
    const nats = routers.flatMap((r) => arr(r.nats));
    const urls = nats.flatMap((n) => arr(n.natIps).map(String));
    const auto = nats.some((n) => n.natIpAllocateOption !== "MANUAL_ONLY");
    let ips: string[] = [];
    if (urls.length) {
      const addrs = arr(await runJson(d, "gcloud", ["compute", "addresses", "list", ...p]));
      ips = [...new Set(urls.map((u) => str(addrs.find((a) => a.selfLink === u || String(u).endsWith(`/${String(a.name)}`))?.address)).filter((x): x is string => !!x))].sort();
    }
    // DRAFT(ai): 자동 할당(AUTO_ONLY)은 IP 가 바뀔 수 있어 허용 목록에 넣기 어렵다 → fixed=false 로 적고 계획 줄은 그대로 띄움
    if (nats.length) out.push({ kind: "net.egress", source: "gcp:cloud-nat", ips, fixed: auto ? false : true } satisfies RawEgress);
  } catch (e) { if (!(e instanceof CliError)) throw e; notes.push(`Cloud NAT 못 읽음 → 출발 나가는 IP 모름: ${e.message.slice(0, 160)}`); out.push(unreadOrThrow(e, "net.egress", "Cloud NAT(출발 나가는 IP)")); }
  try {
    const zones = arr(await runJson(d, "gcloud", ["dns", "managed-zones", "list", ...p])).filter((z) => z.visibility === "private")
      .sort((a, b) => String(a.dnsName).localeCompare(String(b.dnsName)));
    if (zones.length > MAX_ZONES) notes.push(`사설 DNS 영역 ${zones.length}개 중 앞 ${MAX_ZONES}개만 읽음`);
    for (const z of zones.slice(0, MAX_ZONES)) {
      const sets = arr(await runJson(d, "gcloud", ["dns", "record-sets", "list", "--zone", String(z.name), "--limit", String(MAX_RECORDS), ...p]));
      for (const s of sets) {
        const type = String(s.type ?? "");
        if (!RECORD_TYPES.has(type)) continue;
        out.push({ kind: "dns.record", zone: undot(String(z.dnsName ?? "")), name: undot(String(s.name ?? "")), type,
          values: arr(s.rrdatas).map(String).map(undot) } satisfies RawDnsRecord);
      }
    }
  } catch (e) { if (!(e instanceof CliError)) throw e; notes.push(`Cloud DNS 사설 영역 못 읽음: ${e.message.slice(0, 160)}`); out.push(unreadOrThrow(e, "dns.private", "Cloud DNS 사설 영역")); }
  return out;
}
