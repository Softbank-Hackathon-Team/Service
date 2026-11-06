import { arr, CliError, get, runJson, scrubAccountIds, str as s, awsRegion, type CliDeps } from "../common/cli.js";
import { EKS_CLUSTER_NAME_RE } from "../verify/aws.js";

// AWS 도착 사실: 고객이 연결 때 적은 EKS 클러스터(environments.cluster_name)를 관찰 역할로 읽어 aws/root 자리표시(<env:키>)를 채울 값을 만든다.
//   부르는 곳: worker inventory-refresh (실자원 읽기와 같은 빌린 자격). 결과는 environment_inventory 에 같이 두고 계획·apply 가 읽는다
//   읽기 두 번: eks describe-cluster (상태·VPC·서브넷) → ec2 describe-subnets (영역·공개 여부)
// DRAFT(ai): DB 서브넷 = 클러스터 서브넷 중 사설(공개 IP 자동 배정 끔 + 공개 ELB 표시 없음), 공개 서브넷 = 나머지. 둘 다 두 영역(AZ) 이상일 때만
//   (RDS 서브넷 그룹 규칙). 클러스터에 붙지 않은 VPC 서브넷은 보지 않는다

/** aws/root 자리표시 중 도착 환경이 정하는 값 (TF_FACT_* 와 같은 이름) */
export const AWS_TARGET_FACT_KEYS = ["clusterName", "vpcId", "dbSubnetIdsJson", "dbPublicSubnetIdsJson"] as const;

export type AwsTargetFactsRead =
  | { ok: true; cluster: string; region: string; facts: Record<string, string> }
  | { ok: false; cluster: string | null; region: string; reason: string };

const SUBNET_RE = /^subnet-[0-9a-f]{8,17}$/;
const isPublic = (x: Record<string, unknown>) =>
  x.MapPublicIpOnLaunch === true || arr(x.Tags).some((t) => t.Key === "kubernetes.io/role/elb" && t.Value === "1");

/** 순수 함수: describe-cluster·describe-subnets 응답 → 사실. 못 만들면 이유 */
export function awsTargetFactsOf(cluster: string, region: string, described: unknown, subnets: unknown): AwsTargetFactsRead {
  const no = (reason: string): AwsTargetFactsRead => ({ ok: false, cluster, region, reason });
  const status = s(get(described, "cluster", "status"));
  if (status !== "ACTIVE") return no(`클러스터 ${cluster} 상태가 ${status ?? "알 수 없음"} (ACTIVE 일 때만 쓴다)`);
  const vpcId = s(get(described, "cluster", "resourcesVpcConfig", "vpcId"));
  if (!vpcId) return no(`클러스터 ${cluster} 의 VPC 를 못 읽음`);
  const rows = arr(get(subnets, "Subnets"))
    .map((x) => ({ id: s(x.SubnetId) ?? "", az: s(x.AvailabilityZone) ?? "", vpc: s(x.VpcId), pub: isPublic(x) }))
    .filter((r) => SUBNET_RE.test(r.id) && r.az && r.vpc === vpcId);
  const azs = (xs: typeof rows) => new Set(xs.map((r) => r.az)).size;
  const ids = (xs: typeof rows) => JSON.stringify(xs.map((r) => r.id).sort());
  const priv = rows.filter((r) => !r.pub), pub = rows.filter((r) => r.pub);
  if (azs(priv) < 2)
    return no(`클러스터 ${cluster} 의 사설 서브넷이 두 영역(AZ) 이상에 없다 (사설 ${priv.length}개·${azs(priv)}개 영역). 도착 DB 서브넷 그룹을 만들 수 없다`);
  return { ok: true, cluster, region, facts: {
    clusterName: cluster, vpcId, dbSubnetIdsJson: ids(priv),
    // 공개 DB(데모 DB_PUBLIC)만 쓴다. 없으면 키를 빼서 그때만 TF_FACTS_MISSING
    ...(azs(pub) >= 2 ? { dbPublicSubnetIdsJson: ids(pub) } : {}),
  } };
}

/** 빌린 관찰 자격(d.env)으로 읽는다. 던지지 않고 이유를 돌려준다 (실자원 읽기와 같은 규칙) */
export async function readAwsTargetFacts(cluster: string | null, d: CliDeps = {}): Promise<AwsTargetFactsRead> {
  const region = awsRegion(d.env ?? process.env);
  if (!cluster) return { ok: false, cluster: null, region, reason: "환경에 EKS 클러스터 이름이 없다 (연결 때 EksClusterName)" };
  if (!EKS_CLUSTER_NAME_RE.test(cluster)) return { ok: false, cluster, region, reason: "EKS 클러스터 이름 모양이 아니다" };
  const r = ["--region", region, "--output", "json"];
  try {
    const described = await runJson(d, "aws", ["eks", "describe-cluster", "--name", cluster, ...r]);
    const subnetIds = (get(described, "cluster", "resourcesVpcConfig", "subnetIds") as unknown[] | undefined ?? [])
      .filter((x): x is string => typeof x === "string" && SUBNET_RE.test(x));
    if (!subnetIds.length) return { ok: false, cluster, region, reason: `클러스터 ${cluster} 의 서브넷을 못 읽음` };
    const subnets = await runJson(d, "aws", ["ec2", "describe-subnets", "--subnet-ids", ...subnetIds, ...r]);
    return awsTargetFactsOf(cluster, region, described, subnets);
  } catch (e) {
    const why = e instanceof CliError ? e.message : scrubAccountIds((e as Error).message).slice(0, 200);
    return { ok: false, cluster, region, reason: `읽기 실패: ${why}` };
  }
}
