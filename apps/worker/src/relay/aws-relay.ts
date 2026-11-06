// 온프레 이전 중계기: 출발 AWS 계정(RDS 가 있는 VPC 의 공개 서브넷)에 SSH 중계 EC2 1대 + 보안 그룹을 만들고, 정리 때 지운다.
// 예전엔 사람이 Terraform(infra/modules/aws/demo-relay, tools/onprem-relay.sh)으로 세웠다. 이 파일은 같은 모양을 워커가 `aws` CLI 로 만든다
//   (워커 이미지에 terraform 이 없다). 고객 실행 역할(svc-operate)을 빌리고 세션 정책은 중계기 동작만 (security STEP_ROLES.relay)
// 두 부분:
//   1) 순수 계획 (buildRelayPlan·relayUserData·pickPublicSubnet): 같은 입력 → 같은 출력. 시험이 고정한다
//   2) 실행기 (provisionRelay·teardownRelay): `aws` 를 주입한 exec 로 부른다 (Exec = adapters terraform 실행기와 같은 모양)
// 멱등: 모든 자원에 태그 managed-by=platform · svc:migration=<이전> · svc:role=<relay|relay-db-egress> 를 만들 때 같이 단다.
//   다시 돌면 태그로 찾은 것을 그대로 쓴다 (중복 생성 없음). 지울 때는 두 태그(managed-by=platform AND svc:migration=<이 이전>)가
//   응답에서 다시 확인된 것만 지운다 (필터만 믿지 않는다)
// 실측 (2026-11-05, 대역 RDS + 중계 + 온프레 VM CNPG): 롤백 창 역방향 구독은 출발 RDS 보안 그룹에 "중계 사설 IP/32:5432 로 나가기" 규칙이 있어야 붙었다
// 실측 (2026-11-06, 플랫폼 EKS 워커 + 비공개 RDS 다른 VPC): 워커 파드에서 출발 RDS:5432 는 TIMEOUT (같은 계정이라도 VPC 가 다르면 안 닿는다),
//   중계기 → RDS:5432 도 RDS 보안 그룹이 클러스터 보안 그룹만 받아 TIMEOUT. 그래서 길 두 개를 더 연다:
//   - 출발 입구(RELAY_SOURCE_PORT): 워커 → 중계 공개 IP:15432 → RDS:5432 (TCP 그대로 넘김, TLS 는 워커↔RDS 끝까지). 보안 그룹은 플랫폼 나가는 대역만
//   - RDS 들어오기: RDS 보안 그룹에 "중계 보안 그룹에서 5432" (이미 허용돼 있으면 안 단다)
// GCP 도착(aws-gcp): SSH 터널 없이 TCP 입구 둘. 출발 입구(15432 → RDS)는 플랫폼 나가는 대역 + Cloud SQL 나가는 IP/32 만 받고,
//   역방향 입구(중계 사설 IP:5432 → Cloud SQL 공개 IP:5432)는 VPC 안(RDS 역방향 구독)만 받는다. TLS 는 양 끝 DB 사이 그대로 (중계기는 못 푼다)
// GCP 출발(gcp-aws): 중계기는 도착 AWS 계정(새 RDS 가 있는 EKS VPC 의 공개 서브넷)에 산다. 입구 하나(15432 → 도착 RDS:5432):
//   워커(플랫폼 나가는 대역)와 롤백 창 역방향 구독(출발 Cloud SQL 나가는 IP/32)만 받는다. 정방향 구독(도착 RDS → Cloud SQL 공개 IP)은
//   중계기를 안 지나고 VPC NAT 로 나간다 → 도착 RDS 보안 그룹에 "Cloud SQL 공개 IP/32:5432 로 나가기" 규칙(relay-db-egress 태그)을 단다
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec, type Exec, type ExecResult } from "@svc/adapters";
import { OPENSSH_PEM, type SshKeypair } from "../gitops/migration-secrets.js";

export const RELAY_TAG = { managedBy: "managed-by", migration: "svc:migration", role: "svc:role" } as const;
export const RELAY_ROLE = "relay";
export const RELAY_DB_EGRESS_ROLE = "relay-db-egress";
export const RELAY_DB_INGRESS_ROLE = "relay-db-ingress";
export const RELAY_AMI_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
// DRAFT(ai): 데모 모듈(demo-relay)과 같은 t4g.nano. 터널 몇 개만 나르는 SSH 중계라 충분하다 【추정】
export const RELAY_INSTANCE_TYPE = "t4g.nano";
export const PG_PORT = 5432;
// DRAFT(ai): 워커가 출발 RDS 에 붙는 중계기 입구 포트. 5432(역방향 터널 → 온프레 CNPG)와 겹치지 않는 비특권 포트 (forwarder 가 root 없이 연다)
export const RELAY_SOURCE_PORT = 15432;
// GCP 도착 중계기 EC2 의 역방향 목적지(Cloud SQL 공개 IP) 태그. 다시 돌 때 user-data 의 목적지가 지금 Cloud SQL 과 같은지 이 값으로 본다
export const RELAY_REVERSE_TAG = "svc:reverse-target";

/** 중계기 종류 = 출발 계정의 중계기가 무엇을 나르나 (relay-step RELAY_ROUTES 가 (출발, 도착) 짝에서 고른다) */
// onprem-aws (ADR-031 R4): 온프레 출발 → AWS 도착. 중계기는 도착 계정에 살고(gcp-aws 처럼), 모양(sshd·규칙·입구)은 aws-onprem 과 같다.
//   rds = 도착 RDS. 온프레 터널이 -R 로 출발 CNPG 를 중계 :5432 에 내놓아 도착 RDS 가 구독하고, 롤백 창에는 -L 로 온프레가 도착 RDS 를 구독한다
export type RelayKind = "aws-onprem" | "aws-gcp" | "gcp-aws" | "onprem-aws";

export type RelayErrorCode = "RELAY_PROVISION_FAILED" | "RELAY_TEARDOWN_FAILED" | "RELAY_SOURCE_DB_UNKNOWN" | "RELAY_CONFIG_MISSING" | "RELAY_DB_EGRESS_DENIED"
  | "RELAY_DB_INGRESS_DENIED" | "RELAY_TARGET_DB_UNKNOWN";
export class RelayError extends Error {
  constructor(readonly code: RelayErrorCode, message: string, readonly awsCode?: string) { super(message); this.name = "RelayError"; }
}

export interface Tag { Key: string; Value: string }
export const relayTags = (migrationId: string, role: string): Tag[] => [
  { Key: RELAY_TAG.managedBy, Value: "platform" },
  { Key: RELAY_TAG.migration, Value: migrationId },
  { Key: RELAY_TAG.role, Value: role },
  { Key: "Name", Value: `svc-${role}-${migrationId.slice(0, 8)}` },
];
/** 지워도 되는 우리 자원인가: 두 태그가 다 있고 값이 맞아야 한다 */
export function ownedBy(tags: readonly Tag[] | undefined, migrationId: string): boolean {
  const v = (k: string) => tags?.find((t) => t.Key === k)?.Value;
  return v(RELAY_TAG.managedBy) === "platform" && v(RELAY_TAG.migration) === migrationId;
}

// ── 1. 순수 계획 ───────────────────────────────────────────────────────────────────

export interface RelaySource {
  identifier: string; endpoint: string; port: number; vpcId: string;
  /** RDS 에 붙은 보안 그룹 (활성만, 이름순). 첫 번째에 "중계 사설 IP 로 나가기" 규칙을 단다 */
  securityGroupIds: string[];
  masterUsername: string | null; dbName: string | null;
  /** RDS 가 관리하는 마스터 비밀(rds!…)의 ARN. 있으면 출발 줄 password_ref = aws-sm:<ARN> (relay-step sourcePasswordRef, relay/source-secret.ts) */
  masterSecretArn: string | null;
}
export interface RelayNetwork { vpcCidrs: string[]; subnetId: string }
export interface RelayAmi { imageId: string; rootDeviceName: string }
/** GCP 도착 Cloud SQL 의 공개 주소 둘 (terraform 출력 db_public_ip·db_outgoing_ip) */
export interface CloudSqlPeer { publicIp: string; outgoingIp: string }
interface RelayPlanBase { migrationId: string; rds: RelaySource; network: RelayNetwork; ami: RelayAmi; platformEgressCidrs: string[] }
export interface OnpremRelayPlanInput extends RelayPlanBase {
  kind: "aws-onprem" | "onprem-aws";
  onpremEgressIp: string;
  /** 터널 계정 authorized_keys 한 줄 (migration-secrets deriveSshKeypair().publicKeyLine) */
  tunnelPublicKey: string;
  /** 중계기 sshd 호스트 키 (migration-secrets deriveSshHostKey). null = 중계기가 스스로 만들고 공개 키만 콘솔 출력으로 알린다
   *  (보안 12번: 개인 키가 EC2 user-data 에 평문으로 남지 않는다. 고객 연결 템플릿에 ec2:GetConsoleOutput 이 있어야 한다, RelayReadOwnConsole) */
  hostKey: SshKeypair | null;
}
export interface GcpRelayPlanInput extends RelayPlanBase { kind: "aws-gcp"; cloudSql: CloudSqlPeer }
/** GCP 출발 → AWS 도착: rds = 도착 RDS (terraform 이 만든 것), cloudSql = 출발 Cloud SQL 의 공개·나가는 IP (gcloud sql instances describe) */
export interface GcpAwsRelayPlanInput extends RelayPlanBase { kind: "gcp-aws"; cloudSql: CloudSqlPeer }
export type RelayPlanInput = OnpremRelayPlanInput | GcpRelayPlanInput | GcpAwsRelayPlanInput;
export interface SgRule { direction: "ingress" | "egress"; port: number; cidr: string; description: string }
export interface RelayPlan {
  kind: RelayKind;
  migrationId: string; vpcId: string;
  sgName: string; sgDescription: string; sgTags: Tag[];
  rules: SgRule[];
  instance: { imageId: string; instanceType: string; subnetId: string; rootDeviceName: string; tags: Tag[] };
  userData: string;
  /** RDS 보안 그룹에 달 나가기 규칙 (대상 = 중계 사설 IP/32, 사설 IP 를 안 뒤에 정해진다).
   *  groupIds = RDS 의 활성 보안 그룹 전부: 이미 나가기가 열려 있는지는 합집합으로 본다. 규칙을 달 때는 groupId(첫 번째) 하나에만.
   *  peerIp = 대상이 중계기가 아닐 때 그 IP (gcp-aws: 출발 Cloud SQL 공개 IP, NAT 로 나가는 정방향 구독). null 이면 중계 사설 IP */
  dbEgress: { groupId: string; groupIds: string[]; port: number; tags: Tag[]; peerIp: string | null };
  /** RDS 보안 그룹에 달 들어오기 규칙 (출처 = 중계 보안 그룹 참조: EC2 를 다시 만들어도 그대로). 모양은 dbEgress 와 같다 */
  dbIngress: { groupId: string; groupIds: string[]; port: number; tags: Tag[] };
  /** 온프레 중계기 sshd 호스트 공개 키 (GCP 중계기는 SSH 가 없어 null, 콘솔 방식이면 띄운 뒤에 안다 = null) */
  hostPublicKey: string | null;
  /** true = 띄운 뒤 콘솔 출력(RELAY_HOSTKEY_MARK 줄)에서 호스트 공개 키를 읽는다 (provisionRelay → RelayResources.hostPublicKey) */
  hostKeyFromConsole: boolean;
  /** user-data 에 고정한 목적지 (EC2 태그 svc:reverse-target 과 같다). aws-gcp = Cloud SQL 공개 IP(역방향 입구), gcp-aws = 도착 RDS 엔드포인트(입구).
   *  다시 돌 때 태그와 다르면 그 EC2 는 못 고친다 → 지우고 새로 만든다. 온프레는 null */
  reverseTarget: string | null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const NAME = /^[A-Za-z0-9.-]{1,253}$/;
export const isIpv4 = (s: string) => IPV4.test(s);
function cidr(s: string, minPrefix: number): string | null {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(s.trim());
  if (!m || !IPV4.test(m[1]!) || Number(m[2]) > 32 || Number(m[2]) < minPrefix) return null;
  return `${m[1]}/${Number(m[2])}`;
}
const SSH_PUB = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^\r\n']*)?$/;

// DRAFT(ai): 플랫폼 워커 나가는 대역은 /24 보다 좁게 (demo-relay extra_pg_cidrs_json 검사와 같은 선)
export const PLATFORM_EGRESS_MIN_PREFIX = 24;
/** PLATFORM_EGRESS_CIDRS (쉼표 목록) → CIDR 목록. 비었거나 하나라도 틀리면 RELAY_CONFIG_MISSING */
export function platformEgressCidrs(raw: string | undefined): string[] {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new RelayError("RELAY_CONFIG_MISSING", "PLATFORM_EGRESS_CIDRS 가 없다: 워커가 중계 5432 로 도착 CNPG 에 붙을 나가는 IP 대역(쉼표 목록)을 워커 env 에 준다");
  return parts.map((p) => {
    const c = cidr(p, PLATFORM_EGRESS_MIN_PREFIX);
    if (!c) throw new RelayError("RELAY_CONFIG_MISSING", `PLATFORM_EGRESS_CIDRS 의 ${p.slice(0, 40)} 는 IPv4 CIDR(/${PLATFORM_EGRESS_MIN_PREFIX} 이상 좁게)가 아니다`);
    return c;
  });
}

/** 출발 입구 forwarder (python3 표준 라이브러리만: AL2023 기본 이미지에 있고, 중계기는 나가는 인터넷이 없어 패키지를 못 받는다).
 *  TCP 바이트를 그대로 넘긴다 (TLS 를 풀지 않는다 → 중계기는 DB 내용·비밀번호를 못 본다). 목적지는 실행 인자 하나로 고정 */
export const RELAY_FORWARDER_PY = [
  "import asyncio, sys",
  "UP_HOST, UP_PORT, LISTEN = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])",
  "async def pipe(r, w):",
  "    try:",
  "        while True:",
  "            b = await r.read(65536)",
  "            if not b:",
  "                break",
  "            w.write(b)",
  "            await w.drain()",
  "    except Exception:",
  "        pass",
  "    finally:",
  "        try:",
  "            w.close()",
  "        except Exception:",
  "            pass",
  "async def handle(cr, cw):",
  "    try:",
  "        ur, uw = await asyncio.wait_for(asyncio.open_connection(UP_HOST, UP_PORT), 10)",
  "    except Exception:",
  "        cw.close()",
  "        return",
  "    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))",
  "async def main():",
  "    s = await asyncio.start_server(handle, '0.0.0.0', LISTEN)",
  "    async with s:",
  "        await s.serve_forever()",
  "asyncio.run(main())",
].join("\n");

/** 중계기 user-data (bash). 호스트 키를 넣고 다른 종류 호스트 키는 지우고, tunnel 계정은 포트 전달 두 칸만 (demo-relay 모듈과 같은 sshd 모양).
 *  그리고 워커용 출발 입구 forwarder(RELAY_SOURCE_PORT → RDS:5432)를 systemd 로 띄운다 (sshd 다음: 실패해도 터널은 산다).
 *  ec2-user 키는 없다 (관리 SSH 없음). 바깥 패키지 설치가 없어 나가는 인터넷이 필요 없다 */
export function relayUserData(i: { migrationId: string; rdsEndpoint: string; tunnelPublicKey: string; hostKey: SshKeypair | null }): string {
  if (!NAME.test(i.rdsEndpoint)) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "RDS 엔드포인트는 이름(영숫자·.·-)만");
  if (!SSH_PUB.test(i.tunnelPublicKey.trim())) throw new RelayError("RELAY_PROVISION_FAILED", "터널 공개 키가 ssh-ed25519 한 줄이 아니다");
  let hostKeyLines: string[];
  if (i.hostKey) {
    if (!SSH_PUB.test(i.hostKey.publicKeyLine.trim())) throw new RelayError("RELAY_PROVISION_FAILED", "호스트 공개 키가 ssh-ed25519 한 줄이 아니다");
    const priv = i.hostKey.privateKeyOpenssh.trim();
    if (!new RegExp(`^-----BEGIN ${OPENSSH_PEM}-----\\n[A-Za-z0-9+/=\\n]+\\n-----END ${OPENSSH_PEM}-----$`).test(priv))
      throw new RelayError("RELAY_PROVISION_FAILED", "호스트 개인 키가 OpenSSH 형식이 아니다");
    hostKeyLines = [
      "cat > /etc/ssh/ssh_host_ed25519_key <<'SVC_HOST_KEY'",
      priv,
      "SVC_HOST_KEY",
      "chown root:root /etc/ssh/ssh_host_ed25519_key",
      "chmod 600 /etc/ssh/ssh_host_ed25519_key",
      `printf '%s\\n' '${i.hostKey.publicKeyLine.trim()}' > /etc/ssh/ssh_host_ed25519_key.pub`,
      "chmod 644 /etc/ssh/ssh_host_ed25519_key.pub",
    ];
  } else {
    // 보안 12번: 중계기가 자기 ed25519 키를 만든다 (개인 키는 이 EC2 밖으로 안 나간다). 공개 키는 아래 svc-relay-hostkey 단위가 부팅마다 콘솔에 찍는다
    hostKeyLines = [
      "test -s /etc/ssh/ssh_host_ed25519_key || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key",
      "chown root:root /etc/ssh/ssh_host_ed25519_key",
      "chmod 600 /etc/ssh/ssh_host_ed25519_key",
    ];
  }
  return [
    "#!/bin/bash",
    `# svc relay (managed-by=platform) for migration ${i.migrationId}`,
    "set -euo pipefail",
    "umask 077",
    // 호스트 키: ed25519 하나만. 처음 부팅에 만들어진 다른 종류 키는 지우고 다시 안 만들게 막는다
    "rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub",
    ...hostKeyLines,
    "systemctl mask sshd-keygen@rsa.service sshd-keygen@ecdsa.service || true",
    // 본 설정 파일의 HostKey 줄은 막는다 → 아래 HostKey 한 줄만 남는다
    "sed -i -E 's/^[[:space:]]*HostKey[[:space:]]/#&/' /etc/ssh/sshd_config",
    // 앞 번호 파일이 먼저 정해진다 (sshd 는 처음 얻은 값을 쓴다). HostKey 는 여러 줄이 쌓이는 칸이라 여기 하나만 둔다
    "cat > /etc/ssh/sshd_config.d/05-svc-relay.conf <<'SVC_RELAY'",
    "HostKey /etc/ssh/ssh_host_ed25519_key",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
    "GatewayPorts clientspecified",
    "ClientAliveInterval 15",
    "SVC_RELAY",
    "id tunnel >/dev/null 2>&1 || useradd -m -s /sbin/nologin tunnel",
    "install -d -m 700 -o tunnel -g tunnel /home/tunnel/.ssh",
    `printf '%s\\n' '${i.tunnelPublicKey.trim()}' > /home/tunnel/.ssh/authorized_keys`,
    "chown tunnel:tunnel /home/tunnel/.ssh/authorized_keys",
    "chmod 600 /home/tunnel/.ssh/authorized_keys",
    // tunnel: 정방향 -L 은 RDS:5432 하나, 역방향 -R 은 0.0.0.0:5432 하나. 셸·tty·에이전트·X11 없음
    "cat > /etc/ssh/sshd_config.d/91-tunnel.conf <<'SVC_TUNNEL'",
    "Match User tunnel",
    "  AllowTcpForwarding yes",
    `  PermitOpen ${i.rdsEndpoint}:${PG_PORT}`,
    `  PermitListen 0.0.0.0:${PG_PORT}`,
    "  PermitTTY no",
    "  X11Forwarding no",
    "  AllowAgentForwarding no",
    "  AllowStreamLocalForwarding no",
    "  PermitTunnel no",
    "  ForceCommand /bin/false",
    "Match all",
    "SVC_TUNNEL",
    "sshd -t",
    "systemctl restart sshd",
    ...(i.hostKey ? [] : hostKeyConsoleUnit()),
    // 출발 입구: 워커 → 중계 :15432 → RDS:5432. 보안 그룹이 플랫폼 나가는 대역만 받는다. root 아닌 일회용 계정(DynamicUser)으로 돈다
    ...forwarderScript(),
    ...forwarderUnit("svc-relay-fwd", "svc relay source entry (platform worker to source RDS, TCP passthrough)", i.rdsEndpoint, RELAY_SOURCE_PORT),
    "",
  ].join("\n");
}

/** 호스트 공개 키를 콘솔(시리얼)에 찍는 단위. 부팅마다 다시 찍어 EC2 를 다시 켜도 워커가 읽을 수 있다 (get-console-output --latest) */
export const RELAY_HOSTKEY_MARK = "SVC_RELAY_HOSTKEY";
// ExecStart 에 직접 쓰면 systemd 가 %s·$ 를 자기 문법(지정자·환경 변수)으로 바꾼다 → 스크립트 파일로 뺀다
const hostKeyConsoleUnit = () => [
  "cat > /usr/local/bin/svc-relay-hostkey.sh <<'SVC_HK'",
  "#!/bin/sh",
  `printf '%s %s\\n' ${RELAY_HOSTKEY_MARK} "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > /dev/ttyS0`,
  "SVC_HK",
  "chmod 755 /usr/local/bin/svc-relay-hostkey.sh",
  "cat > /etc/systemd/system/svc-relay-hostkey.service <<'SVC_UNIT'",
  "[Unit]",
  "Description=svc relay: print sshd ed25519 host public key to the serial console",
  "After=sshd.service",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/usr/local/bin/svc-relay-hostkey.sh",
  "[Install]",
  "WantedBy=multi-user.target",
  "SVC_UNIT",
  "systemctl daemon-reload",
  "systemctl enable --now svc-relay-hostkey.service",
];

/** 콘솔 출력에서 호스트 공개 키 한 줄 (가장 마지막 표시 줄). 없으면 null */
export function hostKeyFromConsole(output: string): string | null {
  const find = (t: string) => [...t.matchAll(new RegExp(`${RELAY_HOSTKEY_MARK} (ssh-ed25519 [A-Za-z0-9+/]+={0,3})`, "g"))].at(-1)?.[1] ?? null;
  // AWS CLI v2 는 Output 을 풀어서 준다. 혹시 base64 그대로면 풀어서 한 번 더 본다
  return find(output) ?? (/^[A-Za-z0-9+/=\s]+$/.test(output) ? find(Buffer.from(output, "base64").toString("utf8")) : null);
}

const forwarderScript = () => ["cat > /usr/local/bin/svc-relay-fwd.py <<'SVC_FWD'", RELAY_FORWARDER_PY, "SVC_FWD", "chmod 644 /usr/local/bin/svc-relay-fwd.py"];
/** forwarder systemd 단위 하나 (upHost:5432 ← listen). root 아닌 일회용 계정(DynamicUser), 죽으면 2초 뒤 다시 */
function forwarderUnit(name: string, description: string, upHost: string, listen: number): string[] {
  return [
    `cat > /etc/systemd/system/${name}.service <<'SVC_UNIT'`,
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "[Service]",
    `ExecStart=/usr/bin/python3 /usr/local/bin/svc-relay-fwd.py ${upHost} ${PG_PORT} ${listen}`,
    "DynamicUser=yes",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "Restart=always",
    "RestartSec=2",
    "[Install]",
    "WantedBy=multi-user.target",
    "SVC_UNIT",
    // umask 077 로 만들어진 파일을 일회용 계정이 읽게
    `chmod 644 /etc/systemd/system/${name}.service`,
    "systemctl daemon-reload",
    `systemctl enable --now ${name}.service`,
  ];
}

/** GCP 도착 중계기 user-data: SSH 설정 없음 (보안 그룹에 22 가 없다). 입구 둘:
 *  출발 입구 15432 → RDS:5432 (워커·Cloud SQL 정방향 구독), 역방향 입구 5432 → Cloud SQL 공개 IP:5432 (롤백 창 RDS 역방향 구독) */
export function gcpRelayUserData(i: { migrationId: string; rdsEndpoint: string; cloudSqlIp: string }): string {
  if (!NAME.test(i.rdsEndpoint)) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "RDS 엔드포인트는 이름(영숫자·.·-)만");
  if (!IPV4.test(i.cloudSqlIp)) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "Cloud SQL 공개 IP 가 IPv4 가 아니다");
  return [
    "#!/bin/bash",
    `# svc relay (managed-by=platform) for migration ${i.migrationId} (aws-gcp)`,
    "set -euo pipefail",
    "umask 077",
    ...forwarderScript(),
    ...forwarderUnit("svc-relay-fwd", "svc relay source entry (platform worker and Cloud SQL to source RDS, TCP passthrough)", i.rdsEndpoint, RELAY_SOURCE_PORT),
    ...forwarderUnit("svc-relay-rev", "svc relay reverse entry (source RDS to Cloud SQL public IP, TCP passthrough)", i.cloudSqlIp, PG_PORT),
    "",
  ].join("\n");
}

/** GCP 출발 → AWS 도착 중계기 user-data: SSH 없음. 입구 하나 15432 → 도착 RDS:5432 (워커 접속 + 롤백 창 Cloud SQL 역방향 구독) */
export function gcpAwsRelayUserData(i: { migrationId: string; rdsEndpoint: string }): string {
  if (!NAME.test(i.rdsEndpoint)) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "도착 RDS 엔드포인트는 이름(영숫자·.·-)만");
  return [
    "#!/bin/bash",
    `# svc relay (managed-by=platform) for migration ${i.migrationId} (gcp-aws)`,
    "set -euo pipefail",
    "umask 077",
    ...forwarderScript(),
    ...forwarderUnit("svc-relay-fwd", "svc relay target entry (platform worker and source Cloud SQL to target RDS, TCP passthrough)", i.rdsEndpoint, RELAY_SOURCE_PORT),
    "",
  ].join("\n");
}

/** 보안 그룹 규칙 (demo-relay 와 같은 모양):
 *  들어오기 22 = 온프레 나가는 IP/32 만, 5432 = VPC 대역(RDS 역방향 구독) + 플랫폼 워커 나가는 대역,
 *  15432(출발 입구) = 플랫폼 워커 나가는 대역만. 나가기 5432 = VPC 안만 */
export function relayRules(i: { onpremEgressIp: string; vpcCidrs: string[]; platformEgressCidrs: string[] }): SgRule[] {
  if (!IPV4.test(i.onpremEgressIp)) throw new RelayError("RELAY_PROVISION_FAILED", "온프레 나가는 IP 가 IPv4 가 아니다");
  const vpc = i.vpcCidrs.map((c) => cidr(c, 8));
  if (!vpc.length || vpc.some((c) => !c)) throw new RelayError("RELAY_PROVISION_FAILED", "VPC 대역이 IPv4 CIDR 가 아니다");
  const plat = i.platformEgressCidrs.map((c) => cidr(c, PLATFORM_EGRESS_MIN_PREFIX));
  if (!plat.length || plat.some((c) => !c)) throw new RelayError("RELAY_CONFIG_MISSING", "플랫폼 나가는 대역이 비었거나 틀렸다");
  const uniq = (xs: (string | null)[]) => [...new Set(xs as string[])].sort();
  return [
    { direction: "ingress", port: 22, cidr: `${i.onpremEgressIp}/32`, description: "SSH tunnel from on-prem cluster egress" },
    ...uniq(vpc).map((c): SgRule => ({ direction: "ingress", port: PG_PORT, cidr: c, description: "Postgres from source VPC (RDS reverse subscription)" })),
    ...uniq(plat).filter((c) => !vpc.includes(c)).map((c): SgRule => ({ direction: "ingress", port: PG_PORT, cidr: c, description: "Postgres from platform worker egress" })),
    ...uniq(plat).map((c): SgRule => ({ direction: "ingress", port: RELAY_SOURCE_PORT, cidr: c, description: "Source DB entry for platform worker (TCP passthrough to RDS)" })),
    ...uniq(vpc).map((c): SgRule => ({ direction: "egress", port: PG_PORT, cidr: c, description: "Postgres to RDS inside the VPC" })),
  ];
}

/** GCP 도착 중계기 보안 그룹 규칙: 22 없음.
 *  들어오기 15432(출발 입구) = 플랫폼 나가는 대역 + Cloud SQL 나가는 IP/32, 5432(역방향 입구) = VPC 대역(RDS 역방향 구독)만.
 *  나가기 5432 = VPC 안(RDS) + Cloud SQL 공개 IP/32 */
export function gcpRelayRules(i: { vpcCidrs: string[]; platformEgressCidrs: string[]; cloudSql: CloudSqlPeer }): SgRule[] {
  if (!IPV4.test(i.cloudSql.publicIp) || !IPV4.test(i.cloudSql.outgoingIp))
    throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "Cloud SQL 공개·나가는 IP 가 IPv4 가 아니다");
  const vpc = i.vpcCidrs.map((c) => cidr(c, 8));
  if (!vpc.length || vpc.some((c) => !c)) throw new RelayError("RELAY_PROVISION_FAILED", "VPC 대역이 IPv4 CIDR 가 아니다");
  const plat = i.platformEgressCidrs.map((c) => cidr(c, PLATFORM_EGRESS_MIN_PREFIX));
  if (!plat.length || plat.some((c) => !c)) throw new RelayError("RELAY_CONFIG_MISSING", "플랫폼 나가는 대역이 비었거나 틀렸다");
  const uniq = (xs: (string | null)[]) => [...new Set(xs as string[])].sort();
  const sqlOut = `${i.cloudSql.outgoingIp}/32`;
  return [
    ...uniq(vpc).map((c): SgRule => ({ direction: "ingress", port: PG_PORT, cidr: c, description: "Postgres from source VPC (RDS reverse subscription to Cloud SQL)" })),
    ...uniq(plat).map((c): SgRule => ({ direction: "ingress", port: RELAY_SOURCE_PORT, cidr: c, description: "Source DB entry for platform worker (TCP passthrough to RDS)" })),
    ...(plat.includes(sqlOut) ? [] : [{ direction: "ingress" as const, port: RELAY_SOURCE_PORT, cidr: sqlOut, description: "Source DB entry for Cloud SQL subscription (TCP passthrough to RDS)" }]),
    ...uniq(vpc).map((c): SgRule => ({ direction: "egress", port: PG_PORT, cidr: c, description: "Postgres to RDS inside the VPC" })),
    { direction: "egress", port: PG_PORT, cidr: `${i.cloudSql.publicIp}/32`, description: "Postgres to Cloud SQL public IP (reverse subscription)" },
  ];
}

/** GCP 출발 → AWS 도착 중계기 보안 그룹 규칙: 22·5432 들어오기 없음.
 *  들어오기 15432(입구) = 플랫폼 나가는 대역(L1 워커) + 출발 Cloud SQL 나가는 IP/32(L4 롤백 창 역방향 구독). 나가기 5432 = VPC 안(도착 RDS)만 */
export function gcpAwsRelayRules(i: { vpcCidrs: string[]; platformEgressCidrs: string[]; cloudSql: CloudSqlPeer }): SgRule[] {
  if (!IPV4.test(i.cloudSql.publicIp) || !IPV4.test(i.cloudSql.outgoingIp))
    throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "출발 Cloud SQL 공개·나가는 IP 가 IPv4 가 아니다");
  const vpc = i.vpcCidrs.map((c) => cidr(c, 8));
  if (!vpc.length || vpc.some((c) => !c)) throw new RelayError("RELAY_PROVISION_FAILED", "VPC 대역이 IPv4 CIDR 가 아니다");
  const plat = i.platformEgressCidrs.map((c) => cidr(c, PLATFORM_EGRESS_MIN_PREFIX));
  if (!plat.length || plat.some((c) => !c)) throw new RelayError("RELAY_CONFIG_MISSING", "플랫폼 나가는 대역이 비었거나 틀렸다");
  const uniq = (xs: (string | null)[]) => [...new Set(xs as string[])].sort();
  const sqlOut = `${i.cloudSql.outgoingIp}/32`;
  return [
    ...uniq(plat).map((c): SgRule => ({ direction: "ingress", port: RELAY_SOURCE_PORT, cidr: c, description: "Target DB entry for platform worker (TCP passthrough to RDS)" })),
    ...(plat.includes(sqlOut) ? [] : [{ direction: "ingress" as const, port: RELAY_SOURCE_PORT, cidr: sqlOut, description: "Target DB entry for source Cloud SQL reverse subscription (TCP passthrough to RDS)" }]),
    ...uniq(vpc).map((c): SgRule => ({ direction: "egress", port: PG_PORT, cidr: c, description: "Postgres to RDS inside the VPC" })),
  ];
}

export function buildRelayPlan(i: RelayPlanInput): RelayPlan {
  if (!/^[0-9a-f-]{36}$/.test(i.migrationId)) throw new RelayError("RELAY_PROVISION_FAILED", "이전 번호가 uuid 가 아니다");
  if (i.rds.port !== PG_PORT)
    throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 RDS 포트가 ${i.rds.port} 다: 터널 차트·중계 PermitOpen 은 ${PG_PORT} 만 받는다`);
  const groupId = i.rds.securityGroupIds[0];
  if (!groupId) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "출발 RDS 에 활성 보안 그룹이 없다 (나가기 규칙을 달 곳이 없음)");
  if (!/^ami-[0-9a-f]+$/.test(i.ami.imageId)) throw new RelayError("RELAY_PROVISION_FAILED", "AMI 번호 모양이 틀렸다");
  if (!/^subnet-[0-9a-f]+$/.test(i.network.subnetId)) throw new RelayError("RELAY_PROVISION_FAILED", "서브넷 번호 모양이 틀렸다");
  // gcp-aws: user-data 목적지 = 도착 RDS 엔드포인트 (RDS 를 다시 만들어 이름이 바뀌면 EC2 를 새로). 나가기 규칙 대상 = Cloud SQL 공개 IP (NAT 로 나가는 정방향 구독)
  const reverseTarget = i.kind === "aws-gcp" ? i.cloudSql.publicIp : i.kind === "gcp-aws" ? i.rds.endpoint : null;
  if (i.kind === "gcp-aws" && !IPV4.test(i.cloudSql.publicIp)) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "출발 Cloud SQL 공개 IP 가 IPv4 가 아니다");
  return {
    kind: i.kind,
    migrationId: i.migrationId, vpcId: i.rds.vpcId,
    sgName: `svc-relay-${i.migrationId}`,
    sgDescription: `svc relay for migration ${i.migrationId} (managed-by platform)`,
    sgTags: relayTags(i.migrationId, RELAY_ROLE),
    rules: i.kind === "aws-gcp" ? gcpRelayRules({ vpcCidrs: i.network.vpcCidrs, platformEgressCidrs: i.platformEgressCidrs, cloudSql: i.cloudSql })
      : i.kind === "gcp-aws" ? gcpAwsRelayRules({ vpcCidrs: i.network.vpcCidrs, platformEgressCidrs: i.platformEgressCidrs, cloudSql: i.cloudSql })
      : relayRules({ onpremEgressIp: i.onpremEgressIp, vpcCidrs: i.network.vpcCidrs, platformEgressCidrs: i.platformEgressCidrs }),
    instance: { imageId: i.ami.imageId, instanceType: RELAY_INSTANCE_TYPE, subnetId: i.network.subnetId,
                rootDeviceName: i.ami.rootDeviceName,
                tags: [...relayTags(i.migrationId, RELAY_ROLE), ...(reverseTarget ? [{ Key: RELAY_REVERSE_TAG, Value: reverseTarget }] : [])] },
    userData: i.kind === "aws-gcp" ? gcpRelayUserData({ migrationId: i.migrationId, rdsEndpoint: i.rds.endpoint, cloudSqlIp: i.cloudSql.publicIp })
      : i.kind === "gcp-aws" ? gcpAwsRelayUserData({ migrationId: i.migrationId, rdsEndpoint: i.rds.endpoint })
      : relayUserData({ migrationId: i.migrationId, rdsEndpoint: i.rds.endpoint, tunnelPublicKey: i.tunnelPublicKey, hostKey: i.hostKey }),
    dbEgress: { groupId, groupIds: [...new Set(i.rds.securityGroupIds)], port: PG_PORT, tags: relayTags(i.migrationId, RELAY_DB_EGRESS_ROLE),
                peerIp: i.kind === "gcp-aws" ? i.cloudSql.publicIp : null },
    dbIngress: { groupId, groupIds: [...new Set(i.rds.securityGroupIds)], port: PG_PORT, tags: relayTags(i.migrationId, RELAY_DB_INGRESS_ROLE) },
    hostPublicKey: (i.kind === "aws-onprem" || i.kind === "onprem-aws") && i.hostKey ? i.hostKey.publicKeyLine.trim() : null,
    hostKeyFromConsole: (i.kind === "aws-onprem" || i.kind === "onprem-aws") && !i.hostKey,
    reverseTarget,
  };
}

interface RouteTable { Associations?: { SubnetId?: string; Main?: boolean }[]; Routes?: { DestinationCidrBlock?: string; GatewayId?: string; State?: string }[] }
interface Subnet { SubnetId?: string; VpcId?: string }
/** 공개 서브넷 고르기: 그 서브넷의 경로표(명시 연결, 없으면 VPC 기본 경로표)에 0.0.0.0/0 → igw-* 가 있으면 공개. 여럿이면 번호순 첫 번째 */
export function pickPublicSubnet(subnets: Subnet[], routeTables: RouteTable[]): string | null {
  const main = routeTables.find((t) => t.Associations?.some((a) => a.Main));
  const isPublic = (t: RouteTable | undefined) => !!t?.Routes?.some((r) =>
    r.DestinationCidrBlock === "0.0.0.0/0" && (r.GatewayId ?? "").startsWith("igw-") && r.State !== "blackhole");
  const ids = subnets.map((s) => s.SubnetId).filter((s): s is string => !!s).sort();
  return ids.find((id) => isPublic(routeTables.find((t) => t.Associations?.some((a) => a.SubnetId === id)) ?? main)) ?? null;
}

// ── 2. 실행기 ─────────────────────────────────────────────────────────────────────

export interface RelayAwsDeps {
  /** 빌린 출발 실행 자격 env (envFor 로 워커 자기 자격을 지운 것). 시험은 아무 값이나 */
  env: NodeJS.ProcessEnv;
  region: string;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
  // DRAFT(ai): 5초 × 60번 = 5분 (t4g.nano 는 보통 1분 안에 running) 【추정】
  pollMs?: number; pollTries?: number;
  callTimeoutMs?: number;
  signal?: AbortSignal;
}

const AWS_CODE = /An error occurred \(([A-Za-z0-9.]+)\)/;
class AwsCli {
  constructor(private readonly d: RelayAwsDeps) {}
  async call<T = Record<string, unknown>>(args: string[], what: string, code: RelayErrorCode): Promise<T> {
    const r: ExecResult = await (this.d.exec ?? spawnExec)("aws", [...args, "--region", this.d.region, "--output", "json"],
      { cwd: tmpdir(), env: this.d.env, timeoutMs: this.d.callTimeoutMs ?? 60_000, ...(this.d.signal ? { signal: this.d.signal } : {}) });
    if (r.code !== 0) {
      const awsCode = AWS_CODE.exec(r.stderr)?.[1];
      // 메시지에 키 값은 없다 (aws CLI 는 자격을 찍지 않는다). 길이만 자른다
      const msg = r.code === 127 ? "aws CLI 가 없다 (워커 이미지 확인)" : r.stderr.replace(/\s+/g, " ").trim().slice(0, 300);
      throw new RelayError(code, `${what}: ${msg}`, awsCode);
    }
    return (r.stdout.trim() ? JSON.parse(r.stdout) : {}) as T;
  }
}
const j = (v: unknown) => JSON.stringify(v);
const tagFilters = (migrationId: string, role: string) => [
  { Name: `tag:${RELAY_TAG.managedBy}`, Values: ["platform"] },
  { Name: `tag:${RELAY_TAG.migration}`, Values: [migrationId] },
  { Name: `tag:${RELAY_TAG.role}`, Values: [role] },
];
const tagSpec = (type: string, tags: Tag[]) => ({ ResourceType: type, Tags: tags });

interface DbInstance {
  DBInstanceIdentifier?: string; Engine?: string; MasterUsername?: string; DBName?: string;
  Endpoint?: { Address?: string; Port?: number }; DBSubnetGroup?: { VpcId?: string };
  VpcSecurityGroups?: { VpcSecurityGroupId?: string; Status?: string }[]; MasterUserSecret?: { SecretArn?: string };
}
/** 출발 RDS 의 주소·VPC·보안 그룹 (명세에는 없다 → describe-db-instances) */
export async function discoverRelaySource(d: RelayAwsDeps, identifier: string): Promise<RelaySource> {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(identifier)) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "RDS 인스턴스 이름 모양이 틀렸다");
  const aws = new AwsCli(d);
  const r = await aws.call<{ DBInstances?: DbInstance[] }>(["rds", "describe-db-instances", "--db-instance-identifier", identifier],
    `출발 RDS ${identifier} 읽기`, "RELAY_SOURCE_DB_UNKNOWN");
  const db = r.DBInstances?.[0];
  const endpoint = db?.Endpoint?.Address, vpcId = db?.DBSubnetGroup?.VpcId;
  if (!db || db.Engine !== "postgres" || !endpoint || !vpcId)
    throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 RDS ${identifier}: postgres 엔진·엔드포인트·VPC 를 못 읽었다 (Aurora 는 아직 안 받는다)`);
  return {
    identifier, endpoint, port: db.Endpoint?.Port ?? PG_PORT, vpcId,
    securityGroupIds: (db.VpcSecurityGroups ?? []).filter((g) => g.Status === "active" && g.VpcSecurityGroupId)
      .map((g) => g.VpcSecurityGroupId!).sort(),
    masterUsername: db.MasterUsername ?? null, dbName: db.DBName ?? null,
    masterSecretArn: db.MasterUserSecret?.SecretArn ?? null,
  };
}

/** VPC 대역(연결된 IPv4 전부) + 공개 서브넷 하나 */
export async function discoverRelayNetwork(d: RelayAwsDeps, vpcId: string): Promise<RelayNetwork> {
  const aws = new AwsCli(d);
  const vf = j([{ Name: "vpc-id", Values: [vpcId] }]);
  const [v, s, t] = await Promise.all([
    aws.call<{ Vpcs?: { CidrBlock?: string; CidrBlockAssociationSet?: { CidrBlock?: string; CidrBlockState?: { State?: string } }[] }[] }>(
      ["ec2", "describe-vpcs", "--vpc-ids", vpcId], "VPC 읽기", "RELAY_PROVISION_FAILED"),
    aws.call<{ Subnets?: Subnet[] }>(["ec2", "describe-subnets", "--filters", vf], "서브넷 읽기", "RELAY_PROVISION_FAILED"),
    aws.call<{ RouteTables?: RouteTable[] }>(["ec2", "describe-route-tables", "--filters", vf], "경로표 읽기", "RELAY_PROVISION_FAILED"),
  ]);
  const vpc = v.Vpcs?.[0];
  const assoc = (vpc?.CidrBlockAssociationSet ?? []).filter((a) => a.CidrBlockState?.State === "associated" && a.CidrBlock).map((a) => a.CidrBlock!);
  const vpcCidrs = [...new Set(assoc.length ? assoc : vpc?.CidrBlock ? [vpc.CidrBlock] : [])].sort();
  const subnetId = pickPublicSubnet(s.Subnets ?? [], t.RouteTables ?? []);
  if (!vpcCidrs.length) throw new RelayError("RELAY_PROVISION_FAILED", `VPC ${vpcId} 대역을 못 읽었다`);
  if (!subnetId) throw new RelayError("RELAY_PROVISION_FAILED", `VPC ${vpcId} 에 공개 서브넷(0.0.0.0/0 → igw-*)이 없다: 중계기는 공개 서브넷에 둔다`);
  return { vpcCidrs, subnetId };
}

/** AL2023 arm64 최신 AMI (AWS 공개 SSM 값) + Amazon 소유·arm64 인지 한 번 더 본다 */
export async function resolveRelayAmi(d: RelayAwsDeps): Promise<RelayAmi> {
  const aws = new AwsCli(d);
  const p = await aws.call<{ Parameter?: { Value?: string } }>(["ssm", "get-parameter", "--name", RELAY_AMI_PARAM], "AMI 값 읽기", "RELAY_PROVISION_FAILED");
  const imageId = p.Parameter?.Value ?? "";
  if (!/^ami-[0-9a-f]+$/.test(imageId)) throw new RelayError("RELAY_PROVISION_FAILED", "SSM AMI 값 모양이 틀렸다");
  const im = await aws.call<{ Images?: { ImageOwnerAlias?: string; Architecture?: string; RootDeviceName?: string }[] }>(
    ["ec2", "describe-images", "--image-ids", imageId], "AMI 읽기", "RELAY_PROVISION_FAILED");
  const img = im.Images?.[0];
  if (img?.ImageOwnerAlias !== "amazon" || img.Architecture !== "arm64" || !img.RootDeviceName)
    throw new RelayError("RELAY_PROVISION_FAILED", `AMI ${imageId} 가 Amazon 소유 arm64 가 아니다`);
  return { imageId, rootDeviceName: img.RootDeviceName };
}

export interface SgRuleRow { SecurityGroupRuleId?: string; GroupId?: string; IsEgress?: boolean; IpProtocol?: string; FromPort?: number; ToPort?: number;
  CidrIpv4?: string; CidrIpv6?: string; ReferencedGroupInfo?: { GroupId?: string }; PrefixListId?: string; Tags?: Tag[] }
interface InstanceRow { InstanceId?: string; State?: { Name?: string }; PublicIpAddress?: string; PrivateIpAddress?: string; Tags?: Tag[] }
const ruleKey = (dir: "ingress" | "egress", proto: string, port: number | undefined, cidrS: string) => `${dir}|${proto}|${port ?? ""}|${cidrS}`;
const rowKey = (r: SgRuleRow) => ruleKey(r.IsEgress ? "egress" : "ingress", r.IpProtocol ?? "", r.FromPort === r.ToPort ? r.FromPort : -2,
  r.CidrIpv4 ?? r.CidrIpv6 ?? r.ReferencedGroupInfo?.GroupId ?? r.PrefixListId ?? "");
const LIVE_STATES = ["pending", "running", "stopping", "stopped"];

const ip4n = (s: string) => s.split(".").reduce((a, x) => a * 256 + Number(x), 0);
function cidrHas(c: string, ip: string): boolean {
  const [base, pre] = c.split("/"); const n = Number(pre);
  if (!base || !IPV4.test(base) || !IPV4.test(ip) || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const size = 2 ** (32 - n);
  return Math.floor(ip4n(base) / size) === Math.floor(ip4n(ip) / size);
}
/** RDS 보안 그룹들(합집합)의 나가기 규칙이 이미 중계 사설 IP:port(TCP)를 허용하면 그 규칙 번호. 없으면 undefined.
 *  콘솔·API 로 만든 보안 그룹은 기본 "나가기 전부 허용"이 있어 대개 이미 열려 있다. Terraform 처럼 나가기 규칙이 없을 때만 우리가 단다.
 *  플랫폼이 단 나가기 규칙(svc:role=relay-db-egress, 다른 이전 것 포함)은 그 이전이 끝나면 빠지므로 허용으로 치지 않는다.
 *  접두 목록(prefix list)·IPv6 는 내용을 안 읽으므로 허용으로 치지 않는다 (그때는 규칙을 단다) */
export function existingDbEgressCover(rows: SgRuleRow[], privateIp: string, port: number, relaySgId: string): string | undefined {
  return rows.find((r) => {
    if (!r.IsEgress || !r.SecurityGroupRuleId) return false;
    if ((r.Tags ?? []).some((t) => t.Key === RELAY_TAG.role && t.Value === RELAY_DB_EGRESS_ROLE)) return false;
    const proto = r.IpProtocol === "-1" || ((r.IpProtocol === "tcp" || r.IpProtocol === "6") && (r.FromPort ?? -1) <= port && port <= (r.ToPort ?? -1));
    const dest = (r.CidrIpv4 !== undefined && cidrHas(r.CidrIpv4, privateIp)) || (!!relaySgId && r.ReferencedGroupInfo?.GroupId === relaySgId);
    return proto && dest;
  })?.SecurityGroupRuleId;
}

/** RDS 보안 그룹들(합집합)의 들어오기 규칙이 이미 중계기(사설 IP 또는 중계 보안 그룹)에서 port(TCP)를 허용하면 그 규칙 번호.
 *  existingDbEgressCover 와 같은 기준: 플랫폼이 단 규칙(svc:role=relay-db-ingress, 다른 이전 것 포함)·접두 목록·IPv6 는 허용으로 치지 않는다 */
export function existingDbIngressCover(rows: SgRuleRow[], privateIp: string, port: number, relaySgId: string): string | undefined {
  return rows.find((r) => {
    if (r.IsEgress || !r.SecurityGroupRuleId) return false;
    if ((r.Tags ?? []).some((t) => t.Key === RELAY_TAG.role && t.Value === RELAY_DB_INGRESS_ROLE)) return false;
    const proto = r.IpProtocol === "-1" || ((r.IpProtocol === "tcp" || r.IpProtocol === "6") && (r.FromPort ?? -1) <= port && port <= (r.ToPort ?? -1));
    const src = (r.CidrIpv4 !== undefined && cidrHas(r.CidrIpv4, privateIp)) || (!!relaySgId && r.ReferencedGroupInfo?.GroupId === relaySgId);
    return proto && src;
  })?.SecurityGroupRuleId;
}

export interface RelayResources {
  securityGroupId: string; instanceId: string; publicIp: string; privateIp: string;
  /** 우리가 단 RDS 나가기 규칙 번호. 이미 열려 있어 안 달았으면 "" (그때 dbEgressCoveredBy = 이미 허용하던 규칙 번호) */
  dbEgressRuleId: string; dbEgressCoveredBy?: string;
  /** 우리가 단 RDS 들어오기 규칙 번호 (중계 보안 그룹 → RDS:5432). 이미 허용돼 있어 안 달았으면 "" (그때 dbIngressCoveredBy) */
  dbIngressRuleId: string; dbIngressCoveredBy?: string;
  /** 이번에 새로 만든 것 / 이미 있어 그대로 쓴 것 (감사 detail 용, 번호만) */
  created: string[]; reused: string[];
  /** 콘솔 방식(plan.hostKeyFromConsole)일 때 중계기가 알린 호스트 공개 키 */
  hostPublicKey?: string;
}

async function instancesByTag(aws: AwsCli, migrationId: string, states: string[], code: RelayErrorCode): Promise<InstanceRow[]> {
  const r = await aws.call<{ Reservations?: { Instances?: InstanceRow[] }[] }>(["ec2", "describe-instances", "--filters",
    j([...tagFilters(migrationId, RELAY_ROLE), { Name: "instance-state-name", Values: states }])], "중계 EC2 찾기", code);
  return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).filter((x) => ownedBy(x.Tags, migrationId));
}

/** 계획대로 만든다. 이미 있으면(태그) 그대로 쓰고, 보안 그룹 규칙은 계획과 같아지게 더하고 뺀다 (기본 나가기 전부 허용 규칙도 뺀다) */
export async function provisionRelay(d: RelayAwsDeps, plan: RelayPlan): Promise<RelayResources> {
  const aws = new AwsCli(d);
  const P = "RELAY_PROVISION_FAILED" as const;
  const created: string[] = [], reused: string[] = [];
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = d.pollTries ?? 60, every = d.pollMs ?? 5000;

  // ① 보안 그룹
  const sgs = await aws.call<{ SecurityGroups?: { GroupId?: string; Tags?: Tag[] }[] }>(["ec2", "describe-security-groups", "--filters",
    j([{ Name: "vpc-id", Values: [plan.vpcId] }, ...tagFilters(plan.migrationId, RELAY_ROLE)])], "중계 보안 그룹 찾기", P);
  const mine = (sgs.SecurityGroups ?? []).filter((g) => g.GroupId && ownedBy(g.Tags, plan.migrationId));
  if (mine.length > 1) throw new RelayError(P, `이 이전의 중계 보안 그룹이 ${mine.length}개다 (사람이 하나만 남긴다)`);
  let sgId = mine[0]?.GroupId;
  if (sgId) reused.push(sgId);
  else {
    const c = await aws.call<{ GroupId?: string }>(["ec2", "create-security-group", "--group-name", plan.sgName, "--description", plan.sgDescription,
      "--vpc-id", plan.vpcId, "--tag-specifications", j([tagSpec("security-group", plan.sgTags)])], "중계 보안 그룹 만들기", P);
    if (!c.GroupId) throw new RelayError(P, "create-security-group 이 GroupId 를 안 돌려줬다");
    sgId = c.GroupId; created.push(sgId);
  }

  // ② 규칙: 계획과 같게 (없는 것 더하기 → 남는 것 빼기). 더하기 먼저라 중간에 멈춰도 필요한 길은 열려 있다
  const rows = (await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
    j([{ Name: "group-id", Values: [sgId] }])], "중계 보안 그룹 규칙 읽기", P)).SecurityGroupRules ?? [];
  const want = new Map(plan.rules.map((r) => [ruleKey(r.direction, "tcp", r.port, r.cidr), r]));
  const have = new Set(rows.map(rowKey));
  for (const [k, r] of want) {
    if (have.has(k)) continue;
    const verb = r.direction === "ingress" ? "authorize-security-group-ingress" : "authorize-security-group-egress";
    try {
      await aws.call(["ec2", verb, "--group-id", sgId, "--ip-permissions",
        j([{ IpProtocol: "tcp", FromPort: r.port, ToPort: r.port, IpRanges: [{ CidrIp: r.cidr, Description: r.description }] }]),
        "--tag-specifications", j([tagSpec("security-group-rule", plan.sgTags)])], `중계 규칙 ${r.direction} ${r.port} 열기`, P);
    } catch (e) { if (!(e instanceof RelayError && e.awsCode === "InvalidPermission.Duplicate")) throw e; }
  }
  for (const dir of ["ingress", "egress"] as const) {
    const extra = rows.filter((r) => (r.IsEgress ? "egress" : "ingress") === dir && r.SecurityGroupRuleId && !want.has(rowKey(r))).map((r) => r.SecurityGroupRuleId!);
    if (!extra.length) continue;
    try {
      await aws.call(["ec2", `revoke-security-group-${dir}`, "--group-id", sgId, "--security-group-rule-ids", ...extra.sort()], `중계 규칙 ${dir} 정리`, P);
    } catch (e) { if (!(e instanceof RelayError && e.awsCode === "InvalidPermission.NotFound")) throw e; }
  }

  // ③ EC2
  const live = await instancesByTag(aws, plan.migrationId, [...LIVE_STATES], P);
  if (live.length > 1) throw new RelayError(P, `이 이전의 중계 EC2 가 ${live.length}대다 (사람이 하나만 남긴다)`);
  let inst = live[0];
  if (inst?.State?.Name === "stopped" || inst?.State?.Name === "stopping")
    throw new RelayError(P, `중계 EC2 ${inst.InstanceId} 가 멈춰 있다 (${inst.State.Name}). 사람이 켜거나 지운 뒤 재개`);
  // GCP 중계기: user-data 의 역방향 목적지(Cloud SQL 공개 IP)가 지금과 다르면(Cloud SQL 을 다시 만듦) 그 EC2 는 못 고친다 → 지우고 새로 만든다
  if (inst?.InstanceId && plan.reverseTarget && inst.Tags?.find((t) => t.Key === RELAY_REVERSE_TAG)?.Value !== plan.reverseTarget) {
    await aws.call(["ec2", "terminate-instances", "--instance-ids", inst.InstanceId], "옛 목적지 중계 EC2 종료", P);
    await waitTerminated(aws, [inst.InstanceId], tries, every, sleep, P);
    inst = undefined;
  }
  let instanceId = inst?.InstanceId;
  if (instanceId) reused.push(instanceId);
  else instanceId = await runInstance(aws, plan, sgId);
  if (!reused.includes(instanceId)) created.push(instanceId);
  for (let n = 0; ; n++) {
    const r = await aws.call<{ Reservations?: { Instances?: InstanceRow[] }[] }>(["ec2", "describe-instances", "--instance-ids", instanceId], "중계 EC2 상태", P);
    inst = r.Reservations?.[0]?.Instances?.[0];
    if (inst?.State?.Name === "running" && inst.PublicIpAddress && inst.PrivateIpAddress) break;
    if (inst?.State?.Name && !["pending", "running"].includes(inst.State.Name))
      throw new RelayError(P, `중계 EC2 ${instanceId} 가 ${inst.State.Name} 가 됐다`);
    if (n + 1 >= tries) throw new RelayError(P, `중계 EC2 ${instanceId} 가 ${tries}번 기다려도 running·공개 IP 가 아니다`);
    await sleep(every);
  }
  const publicIp = inst.PublicIpAddress!, privateIp = inst.PrivateIpAddress!;
  // 보안 12번: 중계기가 스스로 만든 호스트 키의 공개 키를 콘솔 출력에서 읽는다 (부팅·sshd 뒤에 찍힌다, 수십 초~몇 분)
  let hostPublicKey: string | undefined;
  if (plan.hostKeyFromConsole) {
    for (let n = 0; ; n++) {
      const c = await aws.call<{ Output?: string }>(["ec2", "get-console-output", "--instance-id", instanceId, "--latest"], "중계 EC2 콘솔 출력(호스트 공개 키)", P);
      const k = c.Output ? hostKeyFromConsole(c.Output) : null;
      if (k) { hostPublicKey = k; break; }
      if (n + 1 >= tries) throw new RelayError(P, `중계 EC2 ${instanceId} 의 콘솔 출력에 호스트 공개 키(${RELAY_HOSTKEY_MARK})가 ${tries}번 기다려도 없다`);
      await sleep(every);
    }
  }

  // ④ RDS 보안 그룹 나가기 → 중계 사설 IP/32:5432 (롤백 창 역방향 구독). 사설 IP 가 바뀌었으면(EC2 다시 만듦) 옛 규칙을 뺀다
  //   gcp-aws: 대상 = 출발 Cloud SQL 공개 IP/32 (도착 RDS 의 정방향 구독이 VPC NAT 로 나간다). Cloud SQL 을 다시 만들어 IP 가 바뀌면 옛 규칙을 뺀다
  const dbRules = ((await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
    j([{ Name: "group-id", Values: [plan.dbEgress.groupId] }, ...tagFilters(plan.migrationId, RELAY_DB_EGRESS_ROLE)])], "RDS 나가기 규칙 찾기", P))
    .SecurityGroupRules ?? []).filter((r) => r.SecurityGroupRuleId && ownedBy(r.Tags, plan.migrationId));
  const egressIp = plan.dbEgress.peerIp ?? privateIp;
  const target = `${egressIp}/32`;
  const gcpSource = plan.kind === "gcp-aws";
  const keep = dbRules.find((r) => r.IsEgress && r.CidrIpv4 === target && r.FromPort === plan.dbEgress.port && r.ToPort === plan.dbEgress.port);
  const stale = dbRules.filter((r) => r !== keep).map((r) => r.SecurityGroupRuleId!);
  if (stale.length) await aws.call(["ec2", "revoke-security-group-egress", "--group-id", plan.dbEgress.groupId, "--security-group-rule-ids", ...stale.sort()],
    "RDS 옛 나가기 규칙 빼기", P);
  let dbEgressRuleId = keep?.SecurityGroupRuleId;
  let dbEgressCoveredBy: string | undefined;
  if (dbEgressRuleId) reused.push(dbEgressRuleId);
  else {
    // 이미 열려 있으면 고객 보안 그룹을 고치지 않는다 (연결 스택의 SourceDbSecurityGroupId 를 비운 고객은 이 권한이 없다)
    const all = (await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
      j([{ Name: "group-id", Values: plan.dbEgress.groupIds.length ? plan.dbEgress.groupIds : [plan.dbEgress.groupId] }])], "RDS 나가기 규칙 읽기", P)).SecurityGroupRules ?? [];
    // 중계 보안 그룹 참조로 열려 있는 것은 대상이 중계기일 때만 허용으로 친다
    dbEgressCoveredBy = existingDbEgressCover(all, egressIp, plan.dbEgress.port, gcpSource ? "" : sgId);
    if (!dbEgressCoveredBy) {
      let a: { SecurityGroupRules?: SgRuleRow[] };
      try {
        a = await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "authorize-security-group-egress", "--group-id", plan.dbEgress.groupId,
          "--ip-permissions", j([{ IpProtocol: "tcp", FromPort: plan.dbEgress.port, ToPort: plan.dbEgress.port,
            IpRanges: [{ CidrIp: target, Description: gcpSource ? "Postgres from target RDS to source Cloud SQL public IP via NAT (forward subscription)"
              : "Postgres from source DB to svc relay (rollback window reverse subscription)" }] }]),
          "--tag-specifications", j([tagSpec("security-group-rule", plan.dbEgress.tags)])], "RDS 나가기 규칙 열기", P);
      } catch (e) {
        if (e instanceof RelayError && /^(UnauthorizedOperation|AccessDenied)/.test(e.awsCode ?? ""))
          throw new RelayError("RELAY_DB_EGRESS_DENIED", gcpSource
            ? `도착 RDS 보안 그룹 ${plan.dbEgress.groupId} 에 나가기 규칙(→ 출발 Cloud SQL ${target}:${plan.dbEgress.port})이 없고, 열 권한도 없다. `
              + "정방향 복제(도착 RDS 가 출발 Cloud SQL 을 구독)에 필요하다. 도착 AWS 연결 스택을 새 템플릿으로 업데이트해 svc-operate 의 relay 정책에 "
              + "TargetDbRulesForRelay(플랫폼이 만든 보안 그룹의 규칙 더하기·빼기)를 붙인 뒤 다시 승인한다"
            : `출발 RDS 보안 그룹 ${plan.dbEgress.groupId} 에 나가기 규칙(→ 중계 ${target}:${plan.dbEgress.port})이 없고, 열 권한도 없다. `
              + `롤백 창 역복제(출발 RDS → 중계기)에 필요하다. 연결 스택 입력값 SourceDbSecurityGroupId 에 ${plan.dbEgress.groupId} 를 넣어 스택을 업데이트하거나, `
              + `고객이 그 보안 그룹에 나가기 TCP ${plan.dbEgress.port} → ${target} 를 직접 연 뒤 다시 승인한다`, e.awsCode);
        throw e;
      }
      dbEgressRuleId = a.SecurityGroupRules?.[0]?.SecurityGroupRuleId;
      if (!dbEgressRuleId) throw new RelayError(P, "authorize-security-group-egress 가 규칙 번호를 안 돌려줬다");
      created.push(dbEgressRuleId);
    }
  }

  // ⑤ RDS 보안 그룹 들어오기 ← 중계 보안 그룹:5432 (출발 입구 forwarder 와 온프레 정방향 터널이 RDS 에 붙는 길).
  //   출처를 보안 그룹 참조로 둬서 EC2 를 다시 만들어도 규칙은 그대로다. 이미 허용돼 있으면 고객 보안 그룹을 고치지 않는다
  const inRules = ((await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
    j([{ Name: "group-id", Values: [plan.dbIngress.groupId] }, ...tagFilters(plan.migrationId, RELAY_DB_INGRESS_ROLE)])], "RDS 들어오기 규칙 찾기", P))
    .SecurityGroupRules ?? []).filter((r) => r.SecurityGroupRuleId && ownedBy(r.Tags, plan.migrationId));
  const inKeep = inRules.find((r) => !r.IsEgress && r.ReferencedGroupInfo?.GroupId === sgId && r.FromPort === plan.dbIngress.port && r.ToPort === plan.dbIngress.port);
  const inStale = inRules.filter((r) => r !== inKeep).map((r) => r.SecurityGroupRuleId!);
  if (inStale.length) await aws.call(["ec2", "revoke-security-group-ingress", "--group-id", plan.dbIngress.groupId, "--security-group-rule-ids", ...inStale.sort()],
    "RDS 옛 들어오기 규칙 빼기", P);
  let dbIngressRuleId = inKeep?.SecurityGroupRuleId;
  let dbIngressCoveredBy: string | undefined;
  if (dbIngressRuleId) reused.push(dbIngressRuleId);
  else {
    const all = (await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
      j([{ Name: "group-id", Values: plan.dbIngress.groupIds.length ? plan.dbIngress.groupIds : [plan.dbIngress.groupId] }])], "RDS 들어오기 규칙 읽기", P)).SecurityGroupRules ?? [];
    dbIngressCoveredBy = existingDbIngressCover(all, privateIp, plan.dbIngress.port, sgId);
    if (!dbIngressCoveredBy) {
      let a: { SecurityGroupRules?: SgRuleRow[] };
      try {
        a = await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "authorize-security-group-ingress", "--group-id", plan.dbIngress.groupId,
          "--ip-permissions", j([{ IpProtocol: "tcp", FromPort: plan.dbIngress.port, ToPort: plan.dbIngress.port,
            UserIdGroupPairs: [{ GroupId: sgId, Description: "Postgres from svc relay (platform worker entry and on-prem tunnel)" }] }]),
          "--tag-specifications", j([tagSpec("security-group-rule", plan.dbIngress.tags)])], "RDS 들어오기 규칙 열기", P);
      } catch (e) {
        if (e instanceof RelayError && /^(UnauthorizedOperation|AccessDenied)/.test(e.awsCode ?? "") && gcpSource)
          throw new RelayError("RELAY_DB_INGRESS_DENIED", `도착 RDS 보안 그룹 ${plan.dbIngress.groupId} 이 중계기(보안 그룹 ${sgId})에서 들어오는 TCP ${plan.dbIngress.port} 를 받지 않고, 열 권한도 없다. `
            + "워커의 도착 DB 접속과 롤백 창 역방향 구독(출발 Cloud SQL → 중계기 → 도착 RDS)에 필요하다. 도착 AWS 연결 스택을 새 템플릿으로 업데이트해 "
            + "svc-operate 의 relay 정책에 TargetDbRulesForRelay 를 붙인 뒤 다시 승인한다", e.awsCode);
        if (e instanceof RelayError && /^(UnauthorizedOperation|AccessDenied)/.test(e.awsCode ?? ""))
          throw new RelayError("RELAY_DB_INGRESS_DENIED", `출발 RDS 보안 그룹 ${plan.dbIngress.groupId} 이 중계기(보안 그룹 ${sgId})에서 들어오는 TCP ${plan.dbIngress.port} 를 받지 않고, 열 권한도 없다. `
            + `워커의 출발 DB 접속과 온프레 정방향 터널에 필요하다. 연결 스택을 새 템플릿으로 업데이트하고(SourceDbSecurityGroupId=${plan.dbIngress.groupId}) 다시 승인하거나, `
            // 고객이 직접 열 때는 VPC 대역으로 안내한다: 중계 보안 그룹을 참조하는 고객 규칙(우리 태그 없음)이 남으면 정리 때 중계 보안 그룹을 못 지운다
            + `고객이 그 보안 그룹에 들어오기 TCP ${plan.dbIngress.port} ← 중계기가 있는 VPC 대역(중계 보안 그룹 참조는 쓰지 않는다)을 직접 연 뒤 다시 승인한다`, e.awsCode);
        throw e;
      }
      dbIngressRuleId = a.SecurityGroupRules?.[0]?.SecurityGroupRuleId;
      if (!dbIngressRuleId) throw new RelayError(P, "authorize-security-group-ingress 가 규칙 번호를 안 돌려줬다");
      created.push(dbIngressRuleId);
    }
  }
  return { securityGroupId: sgId, instanceId, publicIp, privateIp, dbEgressRuleId: dbEgressRuleId ?? "", ...(dbEgressCoveredBy ? { dbEgressCoveredBy } : {}),
    dbIngressRuleId: dbIngressRuleId ?? "", ...(dbIngressCoveredBy ? { dbIngressCoveredBy } : {}), created, reused, ...(hostPublicKey ? { hostPublicKey } : {}) };
}

// user-data 에 호스트 개인 키가 들어 있다 → argv(ps 에 보임) 대신 0600 임시 파일(0700 폴더)로 넘기고 바로 지운다
async function runInstance(aws: AwsCli, plan: RelayPlan, sgId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "svc-relay-"));
  try {
    await chmod(dir, 0o700);
    const file = join(dir, "user-data.sh");
    await writeFile(file, plan.userData, { mode: 0o600 });
    const r = await aws.call<{ Instances?: InstanceRow[] }>(["ec2", "run-instances",
      "--image-id", plan.instance.imageId, "--instance-type", plan.instance.instanceType, "--count", "1",
      "--network-interfaces", j([{ DeviceIndex: 0, SubnetId: plan.instance.subnetId, Groups: [sgId], AssociatePublicIpAddress: true, DeleteOnTermination: true }]),
      "--metadata-options", j({ HttpTokens: "required", HttpEndpoint: "enabled", HttpPutResponseHopLimit: 1 }),
      "--block-device-mappings", j([{ DeviceName: plan.instance.rootDeviceName, Ebs: { Encrypted: true, VolumeType: "gp3", DeleteOnTermination: true } }]),
      // DRAFT(ai): CPU 크레딧 standard (unlimited 요금이 붙지 않게)
      "--credit-specification", j({ CpuCredits: "standard" }),
      "--user-data", `file://${file}`,
      "--tag-specifications", j([tagSpec("instance", plan.instance.tags), tagSpec("volume", plan.instance.tags), tagSpec("network-interface", plan.instance.tags)])],
      "중계 EC2 만들기", "RELAY_PROVISION_FAILED");
    const id = r.Instances?.[0]?.InstanceId;
    if (!id) throw new RelayError("RELAY_PROVISION_FAILED", "run-instances 가 InstanceId 를 안 돌려줬다");
    return id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitTerminated(aws: AwsCli, ids: string[], tries: number, every: number, sleep: (ms: number) => Promise<void>, code: RelayErrorCode) {
  for (let n = 0; ids.length; n++) {
    let left: InstanceRow[];
    try {
      const r = await aws.call<{ Reservations?: { Instances?: InstanceRow[] }[] }>(["ec2", "describe-instances", "--instance-ids", ...ids], "중계 EC2 종료 기다리기", code);
      left = (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).filter((x) => x.State?.Name !== "terminated");
    } catch (e) { if (e instanceof RelayError && e.awsCode === "InvalidInstanceID.NotFound") left = []; else throw e; }
    if (!left.length) return;
    if (n + 1 >= tries) throw new RelayError(code, `중계 EC2 ${left.map((x) => x.InstanceId).join(",")} 가 ${tries}번 기다려도 terminated 가 아니다`);
    await sleep(every);
  }
}

/** 정리: RDS 들어오기 규칙(중계 보안 그룹 참조 → 이게 남으면 보안 그룹을 못 지운다) → RDS 나가기 규칙 → EC2 종료(terminated 까지 기다림) → 중계 보안 그룹.
 *  두 태그가 응답에서 다시 확인된 것만 지운다. 여러 번 불러도 된다 */
export async function teardownRelay(d: RelayAwsDeps, migrationId: string): Promise<{ removed: string[] }> {
  const aws = new AwsCli(d);
  const T = "RELAY_TEARDOWN_FAILED" as const;
  const removed: string[] = [];
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = d.pollTries ?? 60, every = d.pollMs ?? 5000;

  const inRules = ((await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
    j(tagFilters(migrationId, RELAY_DB_INGRESS_ROLE))], "RDS 들어오기 규칙 찾기", T)).SecurityGroupRules ?? [])
    .filter((r) => r.SecurityGroupRuleId && r.GroupId && ownedBy(r.Tags, migrationId));
  for (const r of inRules) {
    try {
      await aws.call(["ec2", "revoke-security-group-ingress", "--group-id", r.GroupId!, "--security-group-rule-ids", r.SecurityGroupRuleId!], "RDS 들어오기 규칙 빼기", T);
    } catch (e) { if (!(e instanceof RelayError && e.awsCode === "InvalidPermission.NotFound")) throw e; }
    removed.push(r.SecurityGroupRuleId!);
  }

  const rules = ((await aws.call<{ SecurityGroupRules?: SgRuleRow[] }>(["ec2", "describe-security-group-rules", "--filters",
    j(tagFilters(migrationId, RELAY_DB_EGRESS_ROLE))], "RDS 나가기 규칙 찾기", T)).SecurityGroupRules ?? [])
    .filter((r) => r.SecurityGroupRuleId && r.GroupId && ownedBy(r.Tags, migrationId));
  for (const r of rules) {
    try {
      await aws.call(["ec2", "revoke-security-group-egress", "--group-id", r.GroupId!, "--security-group-rule-ids", r.SecurityGroupRuleId!], "RDS 나가기 규칙 빼기", T);
    } catch (e) { if (!(e instanceof RelayError && e.awsCode === "InvalidPermission.NotFound")) throw e; }
    removed.push(r.SecurityGroupRuleId!);
  }

  const insts = await instancesByTag(aws, migrationId, [...LIVE_STATES, "shutting-down"], T);
  const ids = insts.map((x) => x.InstanceId!).filter(Boolean).sort();
  const toStop = insts.filter((x) => x.State?.Name !== "shutting-down").map((x) => x.InstanceId!).sort();
  if (toStop.length) await aws.call(["ec2", "terminate-instances", "--instance-ids", ...toStop], "중계 EC2 종료", T);
  await waitTerminated(aws, ids, tries, every, sleep, T);
  removed.push(...ids);

  const sgs = ((await aws.call<{ SecurityGroups?: { GroupId?: string; Tags?: Tag[] }[] }>(["ec2", "describe-security-groups", "--filters",
    j(tagFilters(migrationId, RELAY_ROLE))], "중계 보안 그룹 찾기", T)).SecurityGroups ?? []).filter((g) => g.GroupId && ownedBy(g.Tags, migrationId));
  for (const g of sgs) {
    // EC2 가 terminated 가 돼도 네트워크 인터페이스가 풀릴 때까지 DependencyViolation 이 잠깐 난다 → 기다렸다 다시
    for (let n = 0; ; n++) {
      try { await aws.call(["ec2", "delete-security-group", "--group-id", g.GroupId!], "중계 보안 그룹 지우기", T); break; }
      catch (e) {
        if (e instanceof RelayError && e.awsCode === "InvalidGroup.NotFound") break;
        if (!(e instanceof RelayError && e.awsCode === "DependencyViolation") || n + 1 >= tries) throw e;
        await sleep(every);
      }
    }
    removed.push(g.GroupId!);
  }
  return { removed };
}
