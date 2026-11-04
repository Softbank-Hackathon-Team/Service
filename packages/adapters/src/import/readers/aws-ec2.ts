import { arr, get, runJson, str, type CliDeps } from "../../common/cli.js";
import { VM_RAW_KIND, type RawVmGroup, type RawVmIngress } from "../raw-vm.js";
import { groupNameOf, secretLooking } from "./vm-common.js";

// DRAFT(ai) VMIMPORT: AWS EC2 출발 읽기 (회의 11/2 D4: EKS → ECS → VM). 읽기 명령만, 인자 배열(셸 없음).
//   ec2 describe-instances(+ 태그 필터) → ec2 describe-security-groups(쓰는 것만) → ec2 describe-instance-types(크기)
//   안 읽는 것: user-data(describe-instance-attribute)·키 쌍 이름·콘솔 출력·IP 값. 태그는 Name(또는 묶음 태그) 말고 안 가져온다
//   묶음 고르기: IMPORT_AWS_VM_TAG="key=value" (그 태그 달린 VM 만) · IMPORT_AWS_VM_GROUP_TAG (묶는 태그 이름, 기본 Name 에서 끝 번호 뗌)
type Obj = Record<string, unknown>;
export const EC2_OBSERVE_ACTIONS = ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups", "ec2:DescribeInstanceTypes"];

const TAG_RE = /^([A-Za-z0-9_.:/+@-]{1,128})=(.{1,256})$/;
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const tagMap = (i: Obj): Record<string, string> => Object.fromEntries(arr(i.Tags).filter((t) => typeof t.Key === "string").map((t) => [String(t.Key), String(t.Value ?? "")]));
const nameOfArn = (a: string | null) => (a ? a.split("/").pop() ?? null : null);
const ADMIN_PORTS = new Set([22, 3389]);

export interface VmRead { items: Obj[]; counts: Record<string, number>; notes: string[] }

async function soft<T>(label: string, notes: string[], f: () => Promise<T>, dflt: T): Promise<T> {
  try { return await f(); } catch (e) { notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return dflt; }
}

export async function readEc2(d: CliDeps, region: string, env: NodeJS.ProcessEnv): Promise<VmRead> {
  const r = ["--region", region, "--output", "json"];
  const notes: string[] = [];
  const want = env.IMPORT_AWS_VM_TAG?.trim();
  const filt = want ? TAG_RE.exec(want) : null;
  if (want && !filt) notes.push(`IMPORT_AWS_VM_TAG "${want.slice(0, 40)}" 모양이 key=value 아님 → 필터 없이 읽음`);
  const filters = ["--filters", "Name=instance-state-name,Values=running", ...(filt ? [`Name=tag:${filt[1]},Values=${filt[2]}`] : [])];
  const reservations = arr(get(await runJson(d, "aws", ["ec2", "describe-instances", ...filters, ...r]), "Reservations"));
  const insts = reservations.flatMap((x) => arr(x.Instances)).filter((i) => get(i, "State", "Name") === "running");
  if (!insts.length) return { items: [], counts: {}, notes };
  const groupTag = env.IMPORT_AWS_VM_GROUP_TAG?.trim() || undefined;

  // 보안 그룹: 쓰는 것만
  const sgIds = [...new Set(insts.flatMap((i) => arr(i.SecurityGroups).map((g) => String(g.GroupId))))].sort();
  const sgs = new Map<string, Obj>();
  for (const part of chunks(sgIds, 50))
    for (const g of await soft("보안 그룹", notes, async () => arr(get(await runJson(d, "aws", ["ec2", "describe-security-groups", "--group-ids", ...part, ...r]), "SecurityGroups")), []))
      sgs.set(String(g.GroupId), g);

  // 크기: 쓰는 종류만
  const types = [...new Set(insts.map((i) => String(i.InstanceType)))].sort();
  const sizes = new Map<string, { cpuMilli: number; memMiB: number }>();
  for (const t of await soft("인스턴스 종류", notes, async () => arr(get(await runJson(d, "aws", ["ec2", "describe-instance-types", "--instance-types", ...types, ...r]), "InstanceTypes")), []))
    sizes.set(String(t.InstanceType), { cpuMilli: Number(get(t, "VCpuInfo", "DefaultVCpus")) * 1000, memMiB: Number(get(t, "MemoryInfo", "SizeInMiB")) });

  const groups = new Map<string, Obj[]>();
  let droppedTags = 0;
  for (const i of insts) {
    const tags = tagMap(i);
    droppedTags += Object.keys(tags).filter((k) => k !== "Name" && k !== groupTag && k !== "aws:autoscaling:groupName").length;
    // VM-1 DRAFT(ai): 묶는 열쇠 순서 = ASG 이름(aws:autoscaling:groupName, AWS 가 붙임) → 지정 태그 → Name(끝 번호 뗌) → 인스턴스 ID.
    //   ASG 인스턴스는 교체돼도 같은 묶음·같은 id 로 이어진다 (carry 가 열쇠로 찾음)
    const asg = tags["aws:autoscaling:groupName"];
    const raw = groupTag ? tags[groupTag] : tags.Name;
    const name = asg && !secretLooking(asg) ? groupNameOf(asg, true)
      : raw && !secretLooking(raw) ? groupNameOf(raw, !!groupTag) : String(i.InstanceId);
    groups.set(name, [...(groups.get(name) ?? []), i]);
  }
  if (droppedTags) notes.push(`VM 태그 ${droppedTags}개는 가져오지 않음 (묶는 이름 말고는 안 읽음 — 비밀이 태그에 있을 수 있음)`);

  const items: Obj[] = [];
  for (const [name, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const typesIn = [...new Set(list.map((i) => String(i.InstanceType)))].sort();
    const known = typesIn.map((t) => sizes.get(t)).filter((x): x is { cpuMilli: number; memMiB: number } => !!x && Number.isFinite(x.cpuMilli) && Number.isFinite(x.memMiB));
    const biggest = known.sort((a, b) => b.cpuMilli - a.cpuMilli || b.memMiB - a.memMiB)[0];
    const myGroups = [...new Set(list.flatMap((i) => arr(i.SecurityGroups).map((g) => String(g.GroupId))))].sort();
    const rules: RawVmIngress[] = [];
    let ingressKnown = myGroups.length > 0 && myGroups.every((g) => sgs.has(g));
    for (const g of myGroups) for (const p of arr(sgs.get(g)?.IpPermissions)) {
      const proto = str(p.IpProtocol);
      // FW-1: IPv6 대역·접두어 목록(pl-…: CloudFront·사내 대역)도 출발지. 예전엔 버려서 그 포트가 통째로 사라졌다
      const sources = [...arr(p.IpRanges).map((x) => String(x.CidrIp)), ...arr(p.Ipv6Ranges).map((x) => String(x.CidrIpv6)),
        ...arr(p.PrefixListIds).map((x) => `pl:${String(x.PrefixListId)}`), ...arr(p.UserIdGroupPairs).map((x) => `sg:${String(x.GroupId)}`)].sort();
      if (proto === "-1") { rules.push({ protocol: "tcp", fromPort: 0, toPort: 65535, sources }); continue; }
      if (proto !== "tcp" && proto !== "udp") continue;
      rules.push({ protocol: proto, fromPort: Number(p.FromPort), toPort: Number(p.ToPort), sources });
    }
    if (!ingressKnown) notes.push(`${name}: 보안 그룹을 다 못 읽음 → 들어오는 규칙 unknown`);
    const profiles = [...new Set(list.map((i) => nameOfArn(str(get(i, "IamInstanceProfile", "Arn")))).filter((x): x is string => !!x))].sort();
    if (profiles.length > 1) notes.push(`${name}: 인스턴스 프로파일이 ${profiles.length}종 → 첫째(${profiles[0]}) 만 씀`);
    const raw: RawVmGroup = {
      kind: VM_RAW_KIND, product: "ec2", name, scope: region, count: list.length,
      instances: list.map((i) => String(i.InstanceId)).sort(), instanceTypes: typesIn,
      zones: [...new Set(list.map((i) => str(get(i, "Placement", "AvailabilityZone"))).filter((x): x is string => !!x))].sort(),
      cpuMilli: biggest?.cpuMilli ?? null, memMiB: biggest?.memMiB ?? null, identity: profiles[0] ?? null,
      hasPublicIp: list.some((i) => !!str(i.PublicIpAddress)), ingress: ingressKnown ? rules : null,
      ...(myGroups.length ? { securityGroups: myGroups } : {}),   // FM-IR-C06
    };
    items.push(raw as unknown as Obj);
  }
  return { items, counts: { [VM_RAW_KIND]: items.length }, notes };
}
