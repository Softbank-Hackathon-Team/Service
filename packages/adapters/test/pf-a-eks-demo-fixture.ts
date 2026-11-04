// PF-A: 실검증 EKS 출발과 같은 입력 (mac/real/sample-3tier-eks.yaml.tpl 그대로 + served-by 네임스페이스 + RDS 하나) 을 가짜 CLI 로 돌려준다.
//   kubectl get <종류> -n <ns> 는 매니페스트에서 그 종류·네임스페이스만 골라 돌려준다. 비밀 값은 넣지 않는다(이름·키만)
import type { Exec } from "../src/terraform/real-runner.js";
import { DIGEST } from "./fake-cli.js";

export const PF_NS = "real-app";
export const PF_RDS = "platform-demo-db.abcdefghij12.ap-northeast-2.rds.amazonaws.com";
const WEB = `nginx@${DIGEST("e")}`, API = `hashicorp/http-echo@${DIGEST("f")}`;
type Obj = Record<string, unknown>;
const md = (name: string, ns: string, extra: Obj = {}) => ({ name, namespace: ns, ...extra });

const sample = (ns: string): Array<{ kind: string; o: Obj }> => [
  { kind: "configmaps", o: { metadata: md("api-config", ns), data: { LOG_LEVEL: "m-import-cfg-value-7" } } },
  { kind: "serviceaccounts", o: { metadata: md("shop-api", ns) } },
  { kind: "serviceaccounts", o: { metadata: md("default", ns) } },
  { kind: "deployments", o: { metadata: md("shop-api", ns, { labels: { app: "shop-api" } }), spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } },
    template: { metadata: { labels: { app: "shop-api" } }, spec: { serviceAccountName: "shop-api", containers: [{ name: "api", image: API, args: ["-listen=:8080", "-text=ok"],
      ports: [{ name: "http", containerPort: 8080 }], resources: { requests: { cpu: "100m", memory: "64Mi" } }, readinessProbe: { httpGet: { path: "/", port: 8080 } },
      env: [{ name: "DB_HOST", value: PF_RDS }, { name: "DB_PORT", value: "5432" },
        { name: "LOG_LEVEL", valueFrom: { configMapKeyRef: { name: "api-config", key: "LOG_LEVEL" } } },
        { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: "api-secrets", key: "API_TOKEN" } } },
        { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db-app", key: "password" } } }] }] } } } } },
  { kind: "services", o: { metadata: md("shop-api", ns), spec: { selector: { app: "shop-api" }, ports: [{ name: "http", port: 80, targetPort: 8080 }] } } },
  { kind: "deployments", o: { metadata: md("shop-web", ns, { labels: { app: "shop-web" } }), spec: { replicas: 1, selector: { matchLabels: { app: "shop-web" } },
    template: { metadata: { labels: { app: "shop-web" } }, spec: { containers: [{ name: "web", image: WEB, ports: [{ name: "http", containerPort: 80 }],
      resources: { requests: { cpu: "50m", memory: "32Mi" } }, readinessProbe: { httpGet: { path: "/", port: 80 } },
      env: [{ name: "API_URL", value: `http://shop-api.${ns}.svc` }] }] } } } } },
  { kind: "services", o: { metadata: md("shop-web", ns), spec: { selector: { app: "shop-web" }, ports: [{ name: "http", port: 80, targetPort: 80 }] } } },
  { kind: "pods", o: { metadata: md("shop-api-1", ns, { labels: { app: "shop-api" } }), status: { containerStatuses: [{ name: "api", imageID: `docker.io/${API}` }] } } },
  { kind: "pods", o: { metadata: md("shop-web-1", ns, { labels: { app: "shop-web" } }), status: { containerStatuses: [{ name: "web", imageID: `docker.io/${WEB}` }] } } },
  { kind: "secrets", o: { metadata: md("api-secrets", ns), type: "Opaque", data: { API_TOKEN: "" } } },
  { kind: "secrets", o: { metadata: md("shop-db-app", ns), type: "Opaque", data: { password: "" } } },
];
// demo-day 의 served-by (deploy/cloud-demo/served-by.yaml): 네임스페이스 app-demo, 라벨 managed-by=platform
const servedBy: Array<{ kind: string; o: Obj }> = [
  { kind: "deployments", o: { metadata: md("served-by", "app-demo", { labels: { "app.kubernetes.io/name": "served-by" } }), spec: { replicas: 2, selector: { matchLabels: { "app.kubernetes.io/name": "served-by" } },
    template: { metadata: { labels: { "app.kubernetes.io/name": "served-by" } }, spec: { containers: [{ name: "nginx", image: "nginx:1.27-alpine", ports: [{ name: "http", containerPort: 8080 }] }] } } } } },
  { kind: "services", o: { metadata: md("served-by", "app-demo"), spec: { type: "LoadBalancer", selector: { "app.kubernetes.io/name": "served-by" }, ports: [{ name: "http", port: 80, targetPort: "http" }] } } },
  { kind: "pods", o: { metadata: md("served-by-1", "app-demo", { labels: { "app.kubernetes.io/name": "served-by" } }), status: { containerStatuses: [{ name: "nginx", imageID: `docker.io/library/nginx@${DIGEST("1")}` }] } } },
  { kind: "deployments", o: { metadata: md("coredns", "kube-system"), spec: { template: { spec: { containers: [{ name: "coredns", image: "coredns:1" }] } } } } },
];
const NAMESPACES: Record<string, Obj> = { [PF_NS]: { metadata: { name: PF_NS, labels: { "m-import": "1" } } }, "app-demo": { metadata: { name: "app-demo", labels: { "managed-by": "platform" } } } };

export interface PfOpts { drop?: string[]; extraObjs?: Array<{ kind: string; o: Obj }>; noRds?: boolean; extraDbs?: Obj[]; shuffle?: number; withServedBy?: boolean; fail?: (line: string) => { code: number; err: string } | null; namespaceObjs?: boolean; apiResources?: string[] }
export function pfExec(o: PfOpts = {}) {
  const objs = [...sample(PF_NS), ...(o.withServedBy === false ? [] : servedBy), ...(o.extraObjs ?? [])]
    .filter((x) => !(o.drop ?? []).includes(String((x.o.metadata as Obj).name)));   // 다른 앱 모양: 이름으로 빼기
  const calls: string[] = [], unmatched: string[] = [];
  const ok = (v: unknown) => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "", ms: 1 });
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const f = o.fail?.(line);
    if (f) return { code: f.code, stdout: "", stderr: f.err, ms: 1 };
    if (cmd === "kubectl") {
      if (args[0] === "api-resources") return ok((o.apiResources ?? []).join("\n"));
      if (args[0] === "get" && args[1] === "namespace") { const n = NAMESPACES[args[2]!]; return n ? ok(n) : { code: 1, stdout: "", stderr: `namespaces "${args[2]}" not found`, ms: 1 }; }
      if (args[0] === "get" && args[1] === "namespaces") {
        const li = args.indexOf("-l"), [lk, lv] = li >= 0 ? args[li + 1]!.split("=") : [];
        return ok({ items: Object.values(NAMESPACES).filter((n) => !lk || ((n.metadata as Obj).labels as Record<string, string>)[lk!] === lv) });
      }
      if (args[0] === "get") {
        const kind = args[1]!, ni = args.indexOf("-n"), ns = ni >= 0 ? args[ni + 1] : null;
        const items = objs.filter((x) => x.kind === kind && (ns === null || (x.o.metadata as Obj).namespace === ns)).map((x) => x.o);
        if (o.shuffle) items.reverse();   // 순서 꼬임: 목록 순서가 바뀌어도 같은 명세여야 함
        if (kind === "nodes") return ok({ items: [{ metadata: { name: "ip-10-0-1-1", labels: { "kubernetes.io/arch": "amd64" } }, status: { nodeInfo: { architecture: "amd64", kubeletVersion: "v1.31.5-eks" } } }] });
        return ok({ items });
      }
    }
    if (cmd === "aws") {
      const s = args.slice(0, 2).join(" ");
      if (s === "sts get-caller-identity") return ok({ Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/obs/x" });
      if (s === "eks list-clusters") return ok({ clusters: ["platform-target"] });
      if (s === "eks describe-cluster") return ok({ cluster: { name: "platform-target", version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1", clusterSecurityGroupId: "sg-0e0c5c1a2b3d4f506" } } });
      if (s === "eks update-kubeconfig") return ok("Added new context");
      if (s === "ecs list-clusters") return ok({ clusterArns: [] });
      if (s === "rds describe-db-instances" && o.noRds) return ok({ DBInstances: [...(o.extraDbs ?? [])] });
      if (s === "rds describe-db-instances") return ok({ DBInstances: [...(o.extraDbs ?? []), { DBInstanceIdentifier: "platform-demo-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20,
        DBInstanceClass: "db.t4g.micro", Endpoint: { Address: PF_RDS, Port: 5432 }, MultiAZ: false, PubliclyAccessible: false, StorageEncrypted: true, DBName: "shop", MasterUsername: "shop",
        BackupRetentionPeriod: 1, DBParameterGroups: [{ DBParameterGroupName: "platform-demo-pg16" }], VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-0a1b2c3d4e5f60718", Status: "active" }], DBInstanceArn: "arn:aws:rds:ap-northeast-2:111122223333:db:platform-demo-db" }] });
      // 실검증 RDS 와 같게: 보안 그룹 하나, 5432 를 EKS 클러스터 보안 그룹에서만 연다
      // FM-INT-14: SG id 는 실제 모양(sg- + 16진수). C08 이 모양 틀린 id 를 aws 인자로 안 넘겨 "sg-rds" 면 읽기 자체가 안 일어남
      if (s === "ec2 describe-security-groups") return ok({ SecurityGroups: [{ GroupId: "sg-0a1b2c3d4e5f60718", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432,
        UserIdGroupPairs: [{ GroupId: "sg-0e0c5c1a2b3d4f506" }], IpRanges: [], Ipv6Ranges: [], PrefixListIds: [] }] }] });
      if (s === "rds describe-db-parameters") return ok({ Parameters: [{ ParameterName: "rds.logical_replication", ParameterValue: "1" }] });
      if (s === "ec2 describe-vpcs") return ok({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16", IsDefault: false }] });
      if (s === "elbv2 describe-load-balancers") return ok({ LoadBalancers: [] });
      if (s === "ecr describe-repositories") return ok({ repositories: [] });
      if (s === "secretsmanager list-secrets") return ok({ SecretList: [] });
      if (s === "s3api list-buckets") return ok({ Buckets: [] });
      if (s === "sqs list-queues") return ok({});
      if (s === "elasticache describe-cache-clusters") return ok({ CacheClusters: [] });
      if (s === "elasticache describe-replication-groups") return ok({ ReplicationGroups: [] });
      if (s === "sns list-topics") return ok({ Topics: [] });
      if (s === "ec2 describe-nat-gateways") return ok({ NatGateways: [] });
      if (s === "ec2 describe-addresses") return ok({ Addresses: [] });
      if (s === "route53 list-hosted-zones-by-vpc") return ok({ HostedZoneSummaries: [] });
      if (s === "iam get-role") return ok({ Role: { RoleName: "x" } });
      if (s === "eks list-pod-identity-associations") return ok({ associations: [] });
    }
    unmatched.push(line);
    return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
  };
  return { exec, calls, unmatched };
}
