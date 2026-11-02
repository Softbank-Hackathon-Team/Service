import { arr, get, runJson, str, type CliDeps } from "../../common/cli.js";
import { ECS_RAW_KIND, type RawEcsService } from "../raw-ecs.js";

// DRAFT(ai) I9: AWS ECS 출발 읽기 (설계 23번 2장 ② 갈래, 7장 권한 표). 읽기 명령만, 인자 배열(셸 없음).
//   ecs list-clusters → list-services → describe-services(10개씩) → describe-task-definition → list-tasks·describe-tasks(digest)
//   + elbv2 describe-target-groups·describe-listeners·describe-rules (호스트·경로) + application-autoscaling (min·max·CPU 목표)
//   비밀 값은 안 읽는다 (작업 정의 secrets 는 ARN 만). 둘레(ALB·Auto Scaling) 하나가 실패해도 서비스는 남기고 notes 에 이유
//   클러스터 고르기: IMPORT_AWS_ECS_CLUSTER → 없으면 이름순 첫 번째 (notes)

type Obj = Record<string, unknown>;
export const ECS_OBSERVE_ACTIONS = ["ecs:ListClusters", "ecs:ListServices", "ecs:DescribeServices", "ecs:DescribeTaskDefinition",
  "ecs:ListTasks", "ecs:DescribeTasks", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeListeners",
  "elasticloadbalancing:DescribeRules", "application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies"];

const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const nameOfArn = (a: string) => a.split("/").pop() ?? a;
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function soft<T>(label: string, notes: string[], f: () => Promise<T>, dflt: T): Promise<T> {
  try { return await f(); } catch (e) { notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return dflt; }
}

/** ALB 규칙 → 대상 그룹 ARN 별 (host, path, priority) 목록 */
async function routesByTargetGroup(d: CliDeps, r: string[], tgArns: string[], notes: string[]): Promise<{ health: Map<string, string | null>; routes: Map<string, Array<{ host: string; path: string | null; priority: number | null }>> }> {
  const health = new Map<string, string | null>();
  const routes = new Map<string, Array<{ host: string; path: string | null; priority: number | null }>>();
  if (!tgArns.length) return { health, routes };
  const tgs = await soft("ALB 대상 그룹", notes, async () => arr(get(await runJson(d, "aws", ["elbv2", "describe-target-groups", "--target-group-arns", ...tgArns, ...r]), "TargetGroups")), []);
  const lbArns = new Set<string>();
  for (const tg of tgs) {
    health.set(String(tg.TargetGroupArn), str(tg.HealthCheckPath));
    for (const a of strs(tg.LoadBalancerArns)) lbArns.add(a);
  }
  for (const lb of [...lbArns].sort()) {
    const listeners = await soft("ALB 리스너", notes, async () => arr(get(await runJson(d, "aws", ["elbv2", "describe-listeners", "--load-balancer-arn", lb, ...r]), "Listeners")), []);
    for (const l of listeners) {
      const rules = await soft("ALB 규칙", notes, async () => arr(get(await runJson(d, "aws", ["elbv2", "describe-rules", "--listener-arn", String(l.ListenerArn), ...r]), "Rules")), []);
      for (const rule of rules) {
        const conds = arr(rule.Conditions);
        const hosts = conds.filter((c) => c.Field === "host-header").flatMap((c) => strs(get(c, "HostHeaderConfig", "Values") ?? c.Values));
        const paths = conds.filter((c) => c.Field === "path-pattern").flatMap((c) => strs(get(c, "PathPatternConfig", "Values") ?? c.Values));
        const prio = rule.Priority === "default" ? null : Number(rule.Priority);
        const targets = arr(rule.Actions).filter((a) => a.Type === "forward").flatMap((a) =>
          [str(a.TargetGroupArn), ...arr(get(a, "ForwardConfig", "TargetGroups")).map((t) => str(t.TargetGroupArn))].filter((x): x is string => !!x));
        // DRAFT(ai): 호스트 조건 없는 규칙(기본 규칙 포함)은 호스트를 모름 → 라우팅에 안 넣고 notes (사람이 도착 호스트를 정함)
        if (!hosts.length) { if (targets.some((t) => tgArns.includes(t))) notes.push(`ALB 규칙 ${String(rule.RuleArn ?? prio)} 은 호스트 조건 없음 → 라우팅에서 뺌`); continue; }
        for (const t of new Set(targets))
          for (const h of hosts)
            for (const p of paths.length ? paths : [null])
              routes.set(t, [...(routes.get(t) ?? []), { host: h, path: p, priority: Number.isFinite(prio) ? prio : null }]);
      }
    }
  }
  return { health, routes };
}

export interface EcsRead { items: Obj[]; counts: Record<string, number>; notes: string[] }

/** 클러스터 하나의 서비스 전부 → ecs.service 원본 (RawEcsService 모양) + ecs.cluster 한 줄. 클러스터가 없으면 items 빈 목록 */
export async function readEcs(d: CliDeps, region: string, env: NodeJS.ProcessEnv): Promise<EcsRead> {
  const r = ["--region", region, "--output", "json"];
  const notes: string[] = [];
  const clusters = strs(get(await runJson(d, "aws", ["ecs", "list-clusters", ...r]), "clusterArns"));
  const names = clusters.map(nameOfArn).sort();
  const want = env.IMPORT_AWS_ECS_CLUSTER;
  const cluster = want ? names.find((n) => n === want) : names[0];
  if (!cluster) {
    if (want) notes.push(`ECS 클러스터 ${want} 없음`);
    return { items: [], counts: {}, notes };
  }
  if (!want && names.length > 1) notes.push(`ECS 클러스터 ${names.length}개 중 ${cluster} 를 골랐다`);
  const svcArns = strs(get(await runJson(d, "aws", ["ecs", "list-services", "--cluster", cluster, ...r]), "serviceArns"));
  const services: Obj[] = [];
  for (const part of chunks([...svcArns].sort(), 10))
    services.push(...arr(get(await runJson(d, "aws", ["ecs", "describe-services", "--cluster", cluster, "--services", ...part, ...r]), "services")));
  const live = services.filter((s) => s.status !== "INACTIVE").sort((a, b) => String(a.serviceName).localeCompare(String(b.serviceName)));
  const tgArns = [...new Set(live.flatMap((s) => arr(s.loadBalancers).map((l) => str(l.targetGroupArn)).filter((x): x is string => !!x)))].sort();
  const alb = await routesByTargetGroup(d, r, tgArns, notes);

  const items: Obj[] = [];
  for (const s of live) {
    const name = String(s.serviceName);
    const tdArn = String(s.taskDefinition);
    const td = get(await runJson(d, "aws", ["ecs", "describe-task-definition", "--task-definition", tdArn, ...r]), "taskDefinition") as Obj | undefined;
    if (!td) { notes.push(`${name}: 작업 정의 ${nameOfArn(tdArn)} 못 읽음 → 뺌`); continue; }
    const defs = arr(td.containerDefinitions);
    const main = defs.find((c) => c.essential !== false) ?? defs[0];
    // 실행 중 작업의 주 컨테이너 digest (태그만 있는 이미지를 같은 이미지로 박으려고)
    const digest = await soft(`${name} 실행 중 작업`, notes, async () => {
      const tasks = strs(get(await runJson(d, "aws", ["ecs", "list-tasks", "--cluster", cluster, "--service-name", name, "--desired-status", "RUNNING", ...r]), "taskArns"));
      if (!tasks.length) return null;
      const t = arr(get(await runJson(d, "aws", ["ecs", "describe-tasks", "--cluster", cluster, "--tasks", tasks[0]!, ...r]), "tasks"))[0];
      return str(arr(t?.containers).find((c) => c.name === main?.name)?.imageDigest);
    }, null);
    const resId = `service/${cluster}/${name}`;
    const autoscaling = await soft(`${name} Auto Scaling`, notes, async () => {
      const t = arr(get(await runJson(d, "aws", ["application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs", "--resource-ids", resId, ...r]), "ScalableTargets"))[0];
      if (!t) return null;
      const pol = arr(get(await runJson(d, "aws", ["application-autoscaling", "describe-scaling-policies", "--service-namespace", "ecs", "--resource-id", resId, ...r]), "ScalingPolicies"))
        .find((p) => get(p, "TargetTrackingScalingPolicyConfiguration", "PredefinedMetricSpecification", "PredefinedMetricType") === "ECSServiceAverageCPUUtilization");
      const cpu = Number(get(pol, "TargetTrackingScalingPolicyConfiguration", "TargetValue"));
      return { min: Number(t.MinCapacity), max: Number(t.MaxCapacity), targetCpuPct: Number.isFinite(cpu) ? Math.round(cpu) : null };
    }, null);
    const sc = arr(s.deployments).map((x) => get(x, "serviceConnectConfiguration") as Obj | undefined).find((x) => x?.enabled);
    const aliases = arr(sc?.services).flatMap((x) => [
      ...(str(x.discoveryName) ? [{ dnsName: String(x.discoveryName) }] : []),
      ...arr(x.clientAliases).map((a) => ({ dnsName: String(a.dnsName), ...(typeof a.port === "number" ? { port: a.port } : {}) })),
    ]);
    const lbs = arr(s.loadBalancers).map((l) => ({ containerName: str(l.containerName) ?? undefined, containerPort: Number(l.containerPort),
      healthCheckPath: alb.health.get(String(l.targetGroupArn)) ?? null }));
    const routes = arr(s.loadBalancers).flatMap((l) => alb.routes.get(String(l.targetGroupArn)) ?? []);
    const raw: RawEcsService = {
      kind: ECS_RAW_KIND, serviceName: name, serviceArn: str(s.serviceArn), clusterName: cluster,
      desiredCount: Number(s.desiredCount ?? 0), launchType: str(s.launchType), imageDigest: digest,
      taskDefinition: {
        family: str(td.family) ?? undefined, cpu: str(td.cpu) ?? undefined, memory: str(td.memory) ?? undefined, taskRoleArn: str(td.taskRoleArn),
        // 허용 목록: 컨테이너 칸 중 명세 재료만 (logConfiguration·mountPoints·dockerLabels 등은 안 넣음)
        containerDefinitions: defs.map((c) => ({
          name: str(c.name) ?? undefined, image: String(c.image), essential: c.essential !== false,
          ...(typeof c.cpu === "number" && c.cpu > 0 ? { cpu: c.cpu } : {}), ...(typeof c.memory === "number" ? { memory: c.memory } : {}),
          ...(typeof c.memoryReservation === "number" ? { memoryReservation: c.memoryReservation } : {}),
          ...(Array.isArray(c.entryPoint) ? { entryPoint: c.entryPoint as string[] } : {}), ...(Array.isArray(c.command) ? { command: c.command as string[] } : {}),
          portMappings: arr(c.portMappings).map((p) => ({ containerPort: Number(p.containerPort), ...(str(p.protocol) ? { protocol: String(p.protocol) } : {}), ...(str(p.name) ? { name: String(p.name) } : {}) })),
          environment: arr(c.environment).map((e) => ({ name: String(e.name), value: String(e.value ?? "") })),
          secrets: arr(c.secrets).map((e) => ({ name: String(e.name), valueFrom: String(e.valueFrom) })),
          ...(c.healthCheck ? { healthCheck: { command: get(c, "healthCheck", "command") as string[] | undefined, interval: get(c, "healthCheck", "interval") as number | undefined,
            retries: get(c, "healthCheck", "retries") as number | undefined, startPeriod: get(c, "healthCheck", "startPeriod") as number | undefined } } : {}),
        })),
      },
      serviceConnect: aliases.length ? { namespace: str(sc?.namespace), aliases } : null,
      loadBalancers: lbs, routes, autoscaling,
    };
    items.push(raw as unknown as Obj);
  }
  items.push({ kind: "ecs.cluster", name: cluster });
  return { items, counts: { [ECS_RAW_KIND]: items.length - 1 }, notes };
}
