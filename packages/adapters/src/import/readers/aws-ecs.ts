import { arr, get, incomplete, runJson, str, type CliDeps } from "../../common/cli.js";
import { ECS_RAW_KIND, type RawEcsService } from "../raw-ecs.js";
import { pickItem, unreadItem, unreadOrThrow } from "../../common/unread.js";

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

type AlbRoute = { host: string; path: string | null; priority: number | null; listenerPort: number | null; listenerProtocol: string | null; hostUnknown?: true };
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

async function soft<T>(label: string, notes: string[], f: () => Promise<T>, dflt: T): Promise<T> {
  try { return await f(); } catch (e) { notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return dflt; }
}

/** ALB 규칙 → 대상 그룹 ARN 별 (host, path, priority) 목록 */
async function routesByTargetGroup(d: CliDeps, r: string[], tgArns: string[], notes: string[]): Promise<{ health: Map<string, string | null>; routes: Map<string, AlbRoute[]> }> {
  const health = new Map<string, string | null>();
  const routes = new Map<string, AlbRoute[]>();
  if (!tgArns.length) return { health, routes };
  const tgs = await soft("ALB 대상 그룹", notes, async () => arr(get(await runJson(d, "aws", ["elbv2", "describe-target-groups", "--target-group-arns", ...tgArns, ...r]), "TargetGroups")), []);
  const lbArns = new Set<string>();
  for (const tg of tgs) {
    health.set(String(tg.TargetGroupArn), str(tg.HealthCheckPath));
    for (const a of strs(tg.LoadBalancerArns)) lbArns.add(a);
  }
  // EA-1: 호스트 조건 없는 규칙의 임시 호스트 = ALB DNS 이름 (못 읽으면 "alb-<이름>").
  //   elasticloadbalancing:DescribeLoadBalancers 는 기본 관찰 목록(입구 재료 읽기)에 이미 있어 ECS_OBSERVE_ACTIONS 에 다시 안 적는다
  const lbDns = new Map<string, string>();
  if (lbArns.size) for (const lb of await soft("ALB", notes, async () => arr(get(await runJson(d, "aws", ["elbv2", "describe-load-balancers", "--load-balancer-arns", ...[...lbArns].sort(), ...r]), "LoadBalancers")), []))
    if (str(lb.LoadBalancerArn) && str(lb.DNSName)) lbDns.set(String(lb.LoadBalancerArn), String(lb.DNSName).toLowerCase());
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
        // EA-1 DRAFT(ai): 호스트 조건 없는 규칙(기본 규칙 포함) = 어떤 호스트든 받음 → ALB DNS 이름을 임시 호스트로 담고 hostUnknown (검토 줄).
        //   예전엔 라우팅에서 빼서 기본 규칙만 쓰는 ALB 의 공개 서비스가 입구 없이 만들어졌다
        const listener = { listenerPort: num(l.Port), listenerProtocol: str(l.Protocol) };
        const hostList = hosts.length ? hosts : [lbDns.get(lb) ?? `alb-${nameOfArn(lb.replace(/\/[^/]+$/, ""))}`];
        if (!hosts.length && targets.some((t) => tgArns.includes(t))) notes.push(`ALB 규칙 ${String(rule.RuleArn ?? prio)} 은 호스트 조건 없음 → ALB 주소 ${hostList[0]} 를 임시 호스트로 (사람이 도착 호스트를 정함)`);
        for (const t of new Set(targets))
          for (const h of hostList)
            for (const p of paths.length ? paths : [null])
              routes.set(t, [...(routes.get(t) ?? []), { host: h, path: p, priority: Number.isFinite(prio) ? prio : null, ...listener, ...(hosts.length ? {} : { hostUnknown: true }) }]);
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
    // K-1: 지정한 클러스터가 없으면 "ECS 없음"이 아니다 → 부르는 쪽이 검토 줄로 (discover/index.ts)
    if (want) throw incomplete(`ECS 클러스터 ${want} 없음 (출발 범위 확인)`);
    return { items: [], counts: {}, notes };
  }
  const picked: Obj[] = [];
  if (!want && names.length > 1) {
    notes.push(`ECS 클러스터 ${names.length}개 중 ${cluster} 를 골랐다`);
    picked.push(pickItem("ecs-cluster", `ECS 클러스터 ${names.length}개(${names.slice(0, 5).join(", ")}${names.length > 5 ? " …" : ""}) 중 이름순 첫 번째 ${cluster}`));   // K-1
  }
  const svcArns = strs(get(await runJson(d, "aws", ["ecs", "list-services", "--cluster", cluster, ...r]), "serviceArns"));
  const services: Obj[] = [];
  for (const part of chunks([...svcArns].sort(), 10))
    services.push(...arr(get(await runJson(d, "aws", ["ecs", "describe-services", "--cluster", cluster, "--services", ...part, ...r]), "services")));
  const live = services.filter((s) => s.status !== "INACTIVE").sort((a, b) => String(a.serviceName).localeCompare(String(b.serviceName)));
  const tgArns = [...new Set(live.flatMap((s) => arr(s.loadBalancers).map((l) => str(l.targetGroupArn)).filter((x): x is string => !!x)))].sort();
  const alb = await routesByTargetGroup(d, r, tgArns, notes);

  const items: Obj[] = [...picked];
  for (const s of live) {
    const name = String(s.serviceName);
    const tdArn = String(s.taskDefinition);
    // RF-1: 서비스 하나의 작업 정의를 못 읽어도 ECS 갈래 통째로 빠지지 않게. 일시 오류면 던져 재시도, 아니면 그 서비스만 "못 읽음" 검토 줄
    let td: Obj | undefined;
    try { td = get(await runJson(d, "aws", ["ecs", "describe-task-definition", "--task-definition", tdArn, ...r]), "taskDefinition") as Obj | undefined; }
    catch (e) { items.push(unreadOrThrow(e, `ecs.${name}`, `ECS 서비스 ${name} 의 작업 정의 ${nameOfArn(tdArn)}`)); notes.push(`${name}: 작업 정의 ${nameOfArn(tdArn)} 못 읽음 → 검토 줄`); continue; }
    if (!td) { items.push(unreadItem(`ecs.${name}`, `ECS 서비스 ${name} 의 작업 정의 ${nameOfArn(tdArn)} 가 빈 응답`)); notes.push(`${name}: 작업 정의 ${nameOfArn(tdArn)} 못 읽음 → 검토 줄`); continue; }
    const defs = arr(td.containerDefinitions);
    const main = defs.find((c) => c.essential !== false) ?? defs[0];
    // 실행 중 작업의 주 컨테이너 digest (태그만 있는 이미지를 같은 이미지로 박으려고)
    // VI9: 롤링 배포 중엔 옛 판 작업도 RUNNING 이다 → 서비스가 가리키는 판(tdArn)의 작업만 본다 (예전: 목록 첫 작업 = 옛 판 digest 가능, 순서도 안 정해짐)
    //   같은 판인데 digest 가 둘 이상(같은 태그를 다시 올림)이면 고르지 않는다 → 매퍼가 unmapped B (사람이 확인)
    const digest = await soft(`${name} 실행 중 작업`, notes, async () => {
      const tasks = strs(get(await runJson(d, "aws", ["ecs", "list-tasks", "--cluster", cluster, "--service-name", name, "--desired-status", "RUNNING", ...r]), "taskArns")).sort();
      const ds = new Set<string>();
      for (const part of chunks(tasks, 100))
        for (const t of arr(get(await runJson(d, "aws", ["ecs", "describe-tasks", "--cluster", cluster, "--tasks", ...part, ...r]), "tasks"))) {
          if (str(t.taskDefinitionArn) !== tdArn) continue;
          const x = str(arr(t.containers).find((c) => c.name === main?.name)?.imageDigest);
          if (x) ds.add(x);
        }
      if (ds.size > 1) { notes.push(`${name}: 작업 정의 ${nameOfArn(tdArn)} 의 실행 중 작업 digest 가 ${ds.size}개 → 고르지 않음`); return null; }
      return [...ds][0] ?? null;
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
      ...(() => { const g = strs(get(s, "networkConfiguration", "awsvpcConfiguration", "securityGroups")).sort(); return g.length ? { securityGroups: g } : {}; })(),
    };
    items.push(raw as unknown as Obj);
  }
  items.push({ kind: "ecs.cluster", name: cluster });
  return { items, counts: { [ECS_RAW_KIND]: items.filter((i) => i.kind === ECS_RAW_KIND).length }, notes };
}
