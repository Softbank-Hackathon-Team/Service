import { arr, get, runJson, str, type CliDeps } from "../../common/cli.js";
import { actionsOfCommands } from "../../common/observe-permissions.js";
import { CLOUDRUN_RAW_KINDS, type RawCloudRunContainer, type RawCloudRunJob, type RawCloudRunProbe, type RawCloudRunService } from "../raw-cloudrun.js";

// DRAFT(ai) CRIMPORT: GCP Cloud Run 출발 읽기 (설계 23번 2장 ② 갈래, 24번 I9 후반, 27번 A7). ECS reader(aws-ecs.ts)와 같은 틀.
//   run services list → (서비스마다) run revisions describe(digest) · run services get-iam-policy(공개 여부)
//   + run domain-mappings list(사용자 도메인 → 라우팅) + run jobs list + scheduler jobs list(잡 일정)
//   읽기 명령만, 인자 배열(셸 없음). 비밀 값은 안 읽는다(secretKeyRef 는 이름·버전만). 둘레 하나가 실패해도 서비스는 남기고 notes 에 이유
//   지역: IMPORT_GCP_RUN_REGION → 없으면 모든 지역 (서비스 라벨 cloud.googleapis.com/location 으로 지역을 안다)
//   앱 묶기: IMPORT_GCP_RUN_LABEL="키=값" 이면 그 라벨이 붙은 서비스·잡만 (없으면 프로젝트의 전부 + notes)

type Obj = Record<string, unknown>;

/** 이 reader 가 부르는 gcloud 명령 키 (권한 표 common/observe-permissions.ts 와 대조) */
export const CLOUDRUN_COMMANDS = ["run services list", "run revisions describe", "run services get-iam-policy", "run domain-mappings list",
  "run jobs list", "scheduler jobs list"] as const;
/** 위 명령에 필요한 GCP 권한 (관찰 역할·가져오기 장부) */
export const CLOUDRUN_OBSERVE_PERMISSIONS = actionsOfCommands("gcp", CLOUDRUN_COMMANDS);

const LOCATION = "cloud.googleapis.com/location";
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const labelsOf = (o: unknown): Record<string, string> => {
  const l = get(o, "metadata", "labels");
  if (!l || typeof l !== "object") return {};
  return Object.fromEntries(Object.entries(l as Obj).filter(([, v]) => typeof v === "string").sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
};
const ann = (o: unknown, key: string) => str(get(o, "metadata", "annotations", key));
const num = (x: unknown): number | null => { const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN; return Number.isFinite(n) ? n : null; };
/** "600s" · 600 → 600 */
const secondsOf = (x: unknown): number | null => num(typeof x === "string" ? x.replace(/s$/, "") : x);

async function soft<T>(label: string, notes: string[], f: () => Promise<T>, dflt: T): Promise<T> {
  try { return await f(); } catch (e) { notes.push(`${label} 못 읽음: ${(e as Error).message.slice(0, 160)}`); return dflt; }
}

function probeOf(p: unknown): RawCloudRunProbe | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Obj;
  const pick = (k: string) => (o[k] && typeof o[k] === "object" ? o[k] as Obj : null);
  const h = pick("httpGet"), t = pick("tcpSocket"), g = pick("grpc");
  return {
    ...(h ? { httpGet: { path: str(h.path), port: num(h.port) } } : {}),
    ...(t ? { tcpSocket: { port: num(t.port) } } : {}),
    ...(g ? { grpc: { port: num(g.port) } } : {}),
    ...(num(o.periodSeconds) != null ? { periodSeconds: num(o.periodSeconds)! } : {}),
    ...(num(o.failureThreshold) != null ? { failureThreshold: num(o.failureThreshold)! } : {}),
    ...(num(o.initialDelaySeconds) != null ? { initialDelaySeconds: num(o.initialDelaySeconds)! } : {}),
    ...(num(o.timeoutSeconds) != null ? { timeoutSeconds: num(o.timeoutSeconds)! } : {}),
  };
}

/** 컨테이너 허용 목록 칸만 (volumeMounts·이름 없는 칸 등은 안 넣음). env 비밀은 이름·버전만 */
export function containersOf(spec: unknown): RawCloudRunContainer[] {
  return arr(get(spec, "containers")).map((c) => {
    const limits = get(c, "resources", "limits") as Obj | undefined;
    return {
      ...(str(c.name) ? { name: String(c.name) } : {}),
      image: String(c.image ?? ""),
      ...(Array.isArray(c.command) ? { command: strs(c.command) } : {}),
      ...(Array.isArray(c.args) ? { args: strs(c.args) } : {}),
      ports: arr(c.ports).map((p) => ({ containerPort: Number(p.containerPort), ...(str(p.name) ? { name: String(p.name) } : {}) })),
      env: arr(c.env).map((e) => {
        const ref = get(e, "valueFrom", "secretKeyRef") as Obj | undefined;
        return ref ? { name: String(e.name), secret: { name: String(ref.name), version: String(ref.key ?? "latest") } }
          : { name: String(e.name), value: String(e.value ?? "") };
      }),
      ...(limits && (str(limits.cpu) || str(limits.memory)) ? { limits: { ...(str(limits.cpu) ? { cpu: String(limits.cpu) } : {}), ...(str(limits.memory) ? { memory: String(limits.memory) } : {}) } } : {}),
      ...(probeOf(c.startupProbe) ? { startupProbe: probeOf(c.startupProbe) } : {}),
      ...(probeOf(c.livenessProbe) ? { livenessProbe: probeOf(c.livenessProbe) } : {}),
    };
  });
}

/** 라벨 고르기 "키=값" → 맞나. 깃발 없으면 늘 true */
export function labelFilter(want: string | undefined): (labels: Record<string, string>) => boolean {
  const m = want ? /^([^=]+)=(.*)$/.exec(want.trim()) : null;
  if (!m) return () => true;
  return (l) => l[m[1]!.trim()] === m[2]!.trim();
}

export interface CloudRunRead { items: Obj[]; counts: Record<string, number>; notes: string[] }

/** 프로젝트의 Cloud Run 서비스·잡 → cloudrun.service / cloudrun.job 원본. 없으면 items 빈 목록 */
export async function readCloudRun(d: CliDeps, project: string, env: NodeJS.ProcessEnv): Promise<CloudRunRead> {
  const p = ["--project", project, "--format", "json"];
  const notes: string[] = [];
  const region = env.IMPORT_GCP_RUN_REGION?.trim() || null;
  const rg = region ? ["--region", region] : [];
  const want = labelFilter(env.IMPORT_GCP_RUN_LABEL);
  const regionOf = (o: unknown) => labelsOf(o)[LOCATION] ?? region ?? "";

  const all = arr(await runJson(d, "gcloud", ["run", "services", "list", ...rg, ...p]));
  const services = all.filter((s) => want(labelsOf(s))).sort((a, b) => String(get(a, "metadata", "name")).localeCompare(String(get(b, "metadata", "name"))));
  if (env.IMPORT_GCP_RUN_LABEL) notes.push(`Cloud Run 라벨 ${env.IMPORT_GCP_RUN_LABEL} 로 서비스 ${services.length}/${all.length}개를 골랐다`);
  else if (services.length) notes.push(`Cloud Run 서비스 ${services.length}개를 모두 한 앱으로 읽었다 (IMPORT_GCP_RUN_LABEL 로 좁힐 수 있음)`);

  // 사용자 도메인: 지역마다 한 번 (서비스가 있는 지역만)
  const regions = [...new Set(services.map(regionOf).filter(Boolean))].sort();
  const domains = new Map<string, string[]>();
  for (const r of regions) {
    const maps = await soft(`Cloud Run 도메인 매핑(${r})`, notes, async () => arr(await runJson(d, "gcloud", ["run", "domain-mappings", "list", "--region", r, ...p])), []);
    for (const m of maps) {
      const route = str(get(m, "spec", "routeName")), host = str(get(m, "metadata", "name"));
      if (route && host) domains.set(`${r}/${route}`, [...(domains.get(`${r}/${route}`) ?? []), host].sort());
    }
  }

  const items: Obj[] = [];
  for (const s of services) {
    const name = String(get(s, "metadata", "name"));
    const r = regionOf(s);
    const tpl = get(s, "spec", "template");
    const containers = containersOf(get(tpl, "spec"));
    if (!containers.length) { notes.push(`${name}: 컨테이너 없음 → 뺌`); continue; }
    const rev = str(get(s, "status", "latestReadyRevisionName"));
    const digest = !rev ? null : await soft(`${name} 판(revision) ${rev}`, notes, async () =>
      str(get(await runJson(d, "gcloud", ["run", "revisions", "describe", rev, "--region", r, ...p]), "status", "imageDigest")), null);
    const invokerAllUsers = await soft(`${name} 호출 권한(IAM)`, notes, async () =>
      arr(get(await runJson(d, "gcloud", ["run", "services", "get-iam-policy", name, "--region", r, ...p]), "bindings"))
        .some((b) => b.role === "roles/run.invoker" && strs(b.members).some((m) => m === "allUsers" || m === "allAuthenticatedUsers")), null as boolean | null);
    const url = str(get(s, "status", "url"));
    const raw: RawCloudRunService = {
      kind: CLOUDRUN_RAW_KINDS.service, name, region: r, uid: str(get(s, "metadata", "uid")),
      labels: Object.fromEntries(Object.entries(labelsOf(s)).filter(([k]) => !k.startsWith("cloud.googleapis.com/") && !k.startsWith("run.googleapis.com/"))),
      urlHost: url ? url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null,
      ingress: ann(s, "run.googleapis.com/ingress"),
      invokerAllUsers,
      minScale: num(ann(tpl, "autoscaling.knative.dev/minScale")),
      maxScale: num(ann(tpl, "autoscaling.knative.dev/maxScale")),
      serviceAccount: str(get(tpl, "spec", "serviceAccountName")),
      imageDigest: digest,
      containers,
      domains: domains.get(`${r}/${name}`) ?? [],
    };
    items.push(raw as unknown as Obj);
  }

  // 잡 + 일정. 잡 목록·일정 하나가 실패해도 서비스는 남긴다
  const jobsAll = await soft("Cloud Run 잡", notes, async () => arr(await runJson(d, "gcloud", ["run", "jobs", "list", ...rg, ...p])), []);
  const jobs = jobsAll.filter((j) => want(labelsOf(j))).sort((a, b) => String(get(a, "metadata", "name")).localeCompare(String(get(b, "metadata", "name"))));
  const schedules = new Map<string, { cron: string; timeZone: string | null; paused: boolean }>();
  for (const r of [...new Set(jobs.map(regionOf).filter(Boolean))].sort()) {
    const list = await soft(`Cloud Scheduler(${r})`, notes, async () => arr(await runJson(d, "gcloud", ["scheduler", "jobs", "list", "--location", r, ...p])), []);
    for (const sj of [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const target = /\/jobs\/([^/:]+):run\b/.exec(String(get(sj, "httpTarget", "uri") ?? ""))?.[1];
      const cron = str(sj.schedule);
      if (!target || !cron) continue;
      const key = `${r}/${target}`;
      // DRAFT(ai): 한 잡을 부르는 일정이 여럿이면 이름순 첫 번째만 (명세 job 하나 = 일정 하나) + notes
      if (schedules.has(key)) { notes.push(`잡 ${target}: 일정이 둘 이상 → 이름순 첫 번째만`); continue; }
      schedules.set(key, { cron, timeZone: str(sj.timeZone), paused: sj.state === "PAUSED" });
    }
  }
  for (const j of jobs) {
    const name = String(get(j, "metadata", "name"));
    const r = regionOf(j);
    const exec = get(j, "spec", "template", "spec");          // 실행 틀 (taskCount·parallelism)
    const task = get(exec, "template", "spec");                // 작업 틀 (containers·maxRetries·timeout)
    const containers = containersOf(task);
    if (!containers.length) { notes.push(`잡 ${name}: 컨테이너 없음 → 뺌`); continue; }
    const img = containers[0]!.image;
    const raw: RawCloudRunJob = {
      kind: CLOUDRUN_RAW_KINDS.job, name, region: r, uid: str(get(j, "metadata", "uid")),
      labels: Object.fromEntries(Object.entries(labelsOf(j)).filter(([k]) => !k.startsWith("cloud.googleapis.com/") && !k.startsWith("run.googleapis.com/"))),
      serviceAccount: str(get(task, "serviceAccountName")),
      imageDigest: img.includes("@sha256:") ? img.slice(img.indexOf("@") + 1) : null,
      containers,
      taskCount: num(get(exec, "taskCount")), parallelism: num(get(exec, "parallelism")),
      maxRetries: num(get(task, "maxRetries")), timeoutSec: secondsOf(get(task, "timeoutSeconds")),
      schedule: schedules.get(`${r}/${name}`) ?? null,
    };
    items.push(raw as unknown as Obj);
  }
  const svcN = items.filter((i) => i.kind === CLOUDRUN_RAW_KINDS.service).length, jobN = items.length - svcN;
  return { items, counts: { ...(svcN ? { [CLOUDRUN_RAW_KINDS.service]: svcN } : {}), ...(jobN ? { [CLOUDRUN_RAW_KINDS.job]: jobN } : {}) }, notes };
}
