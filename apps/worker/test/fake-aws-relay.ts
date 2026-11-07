// 시험 전용 가짜 aws (중계기 실행기 relay/aws-relay.ts 가 부르는 명령만). 작은 EC2 흉내: 태그 필터·보안 그룹 규칙·EC2 상태
//   relay-aws.test.ts · relay-step.db.test.ts 가 같이 쓴다. 진짜 AWS 는 부르지 않는다
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ExecResult } from "@svc/adapters";
import { ownedBy, type Tag } from "../src/relay/aws-relay.js";

export interface Rule { id: string; group: string; egress: boolean; proto: string; from: number; to: number; cidr: string; tags: Tag[] }
export class FakeAws {
  consoleOutput = ""; consoleDelay = 0; consoleCalls = 0;
  constructor(readonly rds: string, readonly migrationId: string) {}
  calls: string[][] = [];
  sgs = new Map<string, { vpc: string; tags: Tag[] }>([["sg-0rds", { vpc: "vpc-0a1", tags: [] }]]);
  rules: Rule[] = [{ id: "sgr-rds-default", group: "sg-0rds", egress: false, proto: "tcp", from: 5432, to: 5432, cidr: "10.0.0.0/16", tags: [] }];
  insts = new Map<string, { state: string; tags: Tag[]; describes: number }>();
  /** 남이 만든(우리 태그가 아닌) 자원 */
  foreign() {
    this.sgs.set("sg-foreign", { vpc: "vpc-0a1", tags: [{ Key: "managed-by", Value: "platform" }, { Key: "svc:migration", Value: "other" }, { Key: "svc:role", Value: "relay" }] });
    this.insts.set("i-foreign", { state: "running", tags: [{ Key: "managed-by", Value: "platform" }, { Key: "svc:role", Value: "relay" }], describes: 0 });
  }
  n = 0;
  userData = "";
  failOn?: string;
  /** 이 보안 그룹에 나가기 규칙을 열려 하면 권한 없음 (연결 스택 SourceDbSecurityGroupId 를 비운 고객) */
  denyEgressGroup?: string;
  /** 이 보안 그룹에 들어오기 규칙을 열려 하면 권한 없음 (옛 연결 템플릿: 출발 RDS 보안 그룹에 나가기만 허용) */
  denyIngressGroup?: string;
  exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    assert.equal(cmd, "aws");
    this.calls.push(args);
    const op = `${args[0]} ${args[1]}`;
    const val = (f: string) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };
    const vals = (f: string) => { const i = args.indexOf(f); const out: string[] = []; if (i < 0) return out; for (let k = i + 1; k < args.length && !args[k]!.startsWith("--"); k++) out.push(args[k]!); return out; };
    const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "", ms: 1 });
    const err = (c: string) => ({ code: 254, stdout: "", stderr: `\nAn error occurred (${c}) when calling the X operation: no`, ms: 1 });
    if (this.failOn === op) return err("UnauthorizedOperation");
    if (op === "ec2 authorize-security-group-egress" && this.denyEgressGroup && val("--group-id") === this.denyEgressGroup) return err("UnauthorizedOperation");
    if (op === "ec2 authorize-security-group-ingress" && this.denyIngressGroup && val("--group-id") === this.denyIngressGroup) return err("UnauthorizedOperation");
    const filters = JSON.parse(val("--filters") ?? "[]") as { Name: string; Values: string[] }[];
    const tagOk = (tags: Tag[]) => filters.filter((f) => f.Name.startsWith("tag:")).every((f) => f.Values.includes(tags.find((t) => t.Key === f.Name.slice(4))?.Value ?? "\u0000"));
    const fv = (n: string) => filters.find((f) => f.Name === n)?.Values;
    // cidr 이 "sg:<id>" 면 보안 그룹 참조 규칙 (ReferencedGroupInfo)
    const ruleRow = (r: Rule) => ({ SecurityGroupRuleId: r.id, GroupId: r.group, IsEgress: r.egress, IpProtocol: r.proto, FromPort: r.from, ToPort: r.to,
      ...(r.cidr.startsWith("sg:") ? { ReferencedGroupInfo: { GroupId: r.cidr.slice(3) } } : { CidrIpv4: r.cidr }), Tags: r.tags });
    const instRow = (id: string) => { const x = this.insts.get(id)!; return { InstanceId: id, State: { Name: x.state }, Tags: x.tags,
      ...(x.state === "running" ? { PublicIpAddress: "203.0.113.50", PrivateIpAddress: "10.0.1.20" } : {}) }; };
    const tagsOf = (type: string) => (JSON.parse(val("--tag-specifications") ?? "[]") as { ResourceType: string; Tags: Tag[] }[]).find((s) => s.ResourceType === type)?.Tags ?? [];
    switch (op) {
      case "rds describe-db-instances":
        return ok({ DBInstances: [{ DBInstanceIdentifier: val("--db-instance-identifier"), Engine: "postgres", MasterUsername: "postgres", DBName: "shop",
          Endpoint: { Address: this.rds, Port: 5432 }, DBSubnetGroup: { VpcId: "vpc-0a1" }, VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-0rds", Status: "active" }],
          MasterUserSecret: { SecretArn: "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-x" } }] });
      case "ec2 describe-vpcs": return ok({ Vpcs: [{ CidrBlock: "10.0.0.0/16", CidrBlockAssociationSet: [{ CidrBlock: "10.0.0.0/16", CidrBlockState: { State: "associated" } }] }] });
      case "ec2 describe-subnets": return ok({ Subnets: [{ SubnetId: "subnet-0a0a" }, { SubnetId: "subnet-0b0b" }] });
      case "ec2 describe-route-tables": return ok({ RouteTables: [{ Associations: [{ Main: true }], Routes: [] },
        { Associations: [{ SubnetId: "subnet-0b0b" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-0" }] }] });
      case "ssm get-parameter": return ok({ Parameter: { Value: "ami-0abc" } });
      case "ec2 describe-images": return ok({ Images: [{ ImageOwnerAlias: "amazon", Architecture: "arm64", RootDeviceName: "/dev/xvda" }] });
      case "ec2 describe-security-groups":
        return ok({ SecurityGroups: [...this.sgs].filter(([, g]) => tagOk(g.tags) && (!fv("vpc-id") || fv("vpc-id")!.includes(g.vpc))).map(([id, g]) => ({ GroupId: id, Tags: g.tags })) });
      case "ec2 create-security-group": {
        const id = `sg-new${++this.n}`;
        this.sgs.set(id, { vpc: val("--vpc-id")!, tags: tagsOf("security-group") });
        this.rules.push({ id: `sgr-default-${id}`, group: id, egress: true, proto: "-1", from: -1, to: -1, cidr: "0.0.0.0/0", tags: [] });
        return ok({ GroupId: id });
      }
      case "ec2 describe-security-group-rules":
        return ok({ SecurityGroupRules: this.rules.filter((r) => tagOk(r.tags) && (!fv("group-id") || fv("group-id")!.includes(r.group))).map(ruleRow) });
      case "ec2 authorize-security-group-ingress": case "ec2 authorize-security-group-egress": {
        const p = JSON.parse(val("--ip-permissions")!)[0];
        const r: Rule = { id: `sgr-${++this.n}`, group: val("--group-id")!, egress: args[1]!.endsWith("egress"), proto: p.IpProtocol, from: p.FromPort, to: p.ToPort,
          cidr: p.IpRanges?.[0]?.CidrIp ?? `sg:${p.UserIdGroupPairs[0].GroupId}`, tags: tagsOf("security-group-rule") };
        if (this.rules.some((x) => x.group === r.group && x.egress === r.egress && x.from === r.from && x.cidr === r.cidr)) return err("InvalidPermission.Duplicate");
        this.rules.push(r);
        return ok({ Return: true, SecurityGroupRules: [ruleRow(r)] });
      }
      case "ec2 revoke-security-group-ingress": case "ec2 revoke-security-group-egress": {
        const ids = vals("--security-group-rule-ids");
        this.rules = this.rules.filter((r) => !(ids.includes(r.id) && r.group === val("--group-id")));
        return ok({ Return: true });
      }
      case "ec2 describe-instances": {
        const ids = vals("--instance-ids");
        if (ids.length) {
          for (const id of ids) { const x = this.insts.get(id); if (x) { x.describes++; if (x.state === "pending" && x.describes > 1) x.state = "running"; if (x.state === "shutting-down") x.state = "terminated"; } }
          return ok({ Reservations: [{ Instances: ids.filter((id) => this.insts.has(id)).map(instRow) }] });
        }
        return ok({ Reservations: [{ Instances: [...this.insts.keys()].filter((id) => tagOk(this.insts.get(id)!.tags) && fv("instance-state-name")!.includes(this.insts.get(id)!.state)).map(instRow) }] });
      }
      case "ec2 run-instances": {
        this.userData = readFileSync(val("--user-data")!.replace(/^file:\/\//, ""), "utf8");
        const id = `i-new${++this.n}`;
        this.insts.set(id, { state: "pending", tags: tagsOf("instance"), describes: 0 });
        return ok({ Instances: [{ InstanceId: id }] });
      }
      // 보안 12번 콘솔 방식: 중계기가 찍은 호스트 공개 키 줄 (consoleOutput 을 시험이 정한다. 처음 몇 번은 아직 안 찍힌 것처럼 빈 값)
      case "ec2 get-console-output": {
        this.consoleCalls++;
        return ok({ InstanceId: val("--instance-id"), Output: this.consoleCalls > this.consoleDelay ? this.consoleOutput : "" });
      }
      case "ec2 terminate-instances": for (const id of vals("--instance-ids")) this.insts.get(id)!.state = "shutting-down"; return ok({});
      case "ec2 delete-security-group": {
        const id = val("--group-id")!;
        if ([...this.insts.values()].some((x) => x.state !== "terminated" && ownedBy(x.tags, this.migrationId))) return err("DependencyViolation");
        this.sgs.delete(id); this.rules = this.rules.filter((r) => r.group !== id);
        return ok({});
      }
    }
    throw new Error(`fake aws: ${op}`);
  };
  ops = () => this.calls.map((a) => `${a[0]} ${a[1]}`);
}
export const fakeDeps = (f: FakeAws) => ({ env: {}, region: "ap-northeast-2", exec: f.exec, sleep: async () => {}, pollMs: 0, pollTries: 5 });
