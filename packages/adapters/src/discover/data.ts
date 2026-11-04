import { arr, classifyCliError, CliError, get, runJson, str, type CliDeps } from "../common/cli.js";
import { DATA_RAW_KINDS, type RawS3Bucket } from "../import/raw-data.js";
import { unreadItem, unreadOrThrow } from "../common/unread.js";

// I6: 관리형 데이터 자원 읽기 (S3·SQS·ElastiCache / GCS·Pub/Sub·Memorystore). list·describe·get 만 부른다 (쓰기 0, 비밀 값 안 읽음).
//   각 호출이 실패해도(권한 없음·설정 없음) 그 칸만 null/빈 값으로 두고 나머지는 계속한다. 이유는 notes 에 한 줄.
//   "설정이 없어서 나는 오류"(NoSuchLifecycleConfiguration 등)는 못 읽은 게 아니라 "없음"이라 빈 값. 값을 지어내지 않는다.
//   【미확인】 gcloud storage buckets list JSON 칸 이름(snake_case/camelCase 혼재)·ElastiCache ReplicationGroup 의 Engine 칸: 둘 다 두 모양을 받는다. 첫 실측으로 확인

type Obj = Record<string, unknown>;
// OBSROLE: 이 파일이 부르는 읽기 명령에 필요한 권한 (관찰 역할 템플릿·GCP 연결 스크립트·가져오기 장부 목록이 모두 여기서 가져간다).
//   메타데이터 읽기만. 객체 내용(s3:GetObject·storage.objects.*)·큐 메시지(sqs:ReceiveMessage)·버킷 정책 본문(s3:GetBucketPolicy)·
//   캐시 인증 토큰은 읽지 않는다. 명령을 바꾸면 이 목록도 바꾼다 (obsrole-data-permissions.test.ts 가 소스와 대조)
export const AWS_DATA_READ_ACTIONS = [
  "s3:ListAllMyBuckets", "s3:GetBucketVersioning", "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicyStatus", "s3:GetBucketAcl",
  "s3:GetLifecycleConfiguration", "s3:GetBucketCORS", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics",
  "sqs:ListQueues", "sqs:GetQueueAttributes",
  "elasticache:DescribeReplicationGroups", "elasticache:DescribeCacheClusters",
] as const;
// B-1b·B-2 TODO(human): 아래 읽기 권한은 고객 관찰 역할 템플릿(infra/onboarding)에 아직 없다. 템플릿에 더할지 사람이 정한다.
//   없으면 실계정에서 거부 → 버킷 알림은 "못 읽음" 검토 줄, SNS 는 unread.SNS 검토 줄로 남는다 (가져오기는 계속)
export const AWS_DATA_READ_PENDING = ["s3:GetBucketNotification", "sns:ListTopics", "sns:ListSubscriptionsByTopic"] as const;
export const GCP_DATA_READ_PENDING = ["storage.buckets.get"] as const;
export const GCP_DATA_READ_PERMISSIONS = [
  "storage.buckets.list", "storage.buckets.getIamPolicy",
  "pubsub.topics.list", "pubsub.subscriptions.list",
  "redis.instances.list",
] as const;

// DRAFT(ai): 버킷은 이름순 앞 50개만 자세히 읽는다 (호출 수 제한).
// B-3: 앱 원본(env 값·ConfigMap 값·IAM 정책 리소스 등, refs)에 이름이 나오는 버킷은 상한과 상관없이 읽고,
//   그래도 잘린 버킷이 있으면 검토 줄(check.unread.s3.truncated) — 앱이 비밀 안 주소로만 쓰는 버킷이 뒤쪽이면 경계에서 빠질 수 있어서
export const MAX_BUCKETS = 50;
/** B-3: 앱 원본 글자에 버킷 이름이 낱말로 나오나 (앞뒤가 이름 글자가 아님) */
const mentioned = (refs: string, name: string) => !!refs && new RegExp(`(^|[^a-z0-9.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9.-])`, "i").test(refs);
/** 이름순 앞 max 개 + 앱이 가리키는 것. 잘린 개수도 */
export function bucketsToRead(all: string[], refs: string, max = MAX_BUCKETS): { read: string[]; skipped: number } {
  const head = all.slice(0, max), extra = all.slice(max).filter((n) => mentioned(refs, n));
  return { read: [...head, ...extra], skipped: all.length - head.length - extra.length };
}

const stderrOf = (e: unknown) => (e instanceof CliError ? e.stderr : "");
const isMissing = (e: unknown, code: string) => stderrOf(e).includes(code);
async function each<T, R>(xs: T[], f: (x: T) => Promise<R>, width = 5): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += width) out.push(...(await Promise.all(xs.slice(i, i + width).map(f))));
  return out;
}
const cause = (e: unknown) => (e as Error).message.slice(0, 120);

export async function readAwsData(d: CliDeps, region: string, notes: string[], now = new Date(), refs = ""): Promise<Obj[]> {
  const r = ["--region", region, "--output", "json"];
  const items: Obj[] = [];

  // S3
  try {
    const all = arr(get(await runJson(d, "aws", ["s3api", "list-buckets", "--output", "json"]), "Buckets")).map((b) => String(b.Name)).sort();
    const pickS3 = bucketsToRead(all, refs);
    if (pickS3.skipped) {
      const why = `S3 버킷 ${all.length}개 중 이름순 앞 ${MAX_BUCKETS}개 + 앱이 이름을 적은 ${pickS3.read.length - MAX_BUCKETS}개만 읽음 (${pickS3.skipped}개 안 읽음)`;
      notes.push(why);
      items.push(unreadItem("s3.truncated", `${why}. 앱이 비밀 안 주소로만 쓰는 버킷이면 명세에서 빠짐`));
    }
    items.push(...await each(pickS3.read, async (name): Promise<Obj> => {
      const b = ["--bucket", name, "--output", "json"];
      // DM-2·RF-2: 칸을 못 읽은 것("설정 없음" 오류가 아닌 실패)은 Unread 에 칸 이름을 남긴다 → 매퍼가 null·생략 + 신뢰도 0.6 (없음/꺼짐으로 확신하지 않음).
      //   일시 오류(스로틀링 등)는 던져 가져오기를 다시 한다 (RF-1)
      const unread: NonNullable<RawS3Bucket["Unread"]> = [];
      const safe = async <T>(label: string, key: NonNullable<RawS3Bucket["Unread"]>[number], f: () => Promise<T>, onMissing?: [string, T]): Promise<T | null> => {
        try { return await f(); }
        catch (e) {
          if (onMissing && isMissing(e, onMissing[0])) return onMissing[1];
          unreadOrThrow(e, `s3.${name}.${key}`, `S3 ${name} ${label}`);
          notes.push(`S3 ${name} ${label} 못 읽음: ${cause(e)}`); unread.push(key); return null;
        }
      };
      const ver = await safe("버전 관리", "Versioning", async () => str(get(await runJson(d, "aws", ["s3api", "get-bucket-versioning", ...b]), "Status")));
      const pab = await safe("퍼블릭 액세스 차단", "PublicAccessBlock", async () => (get(await runJson(d, "aws", ["s3api", "get-public-access-block", ...b]), "PublicAccessBlockConfiguration") ?? null) as Obj | null,
        ["NoSuchPublicAccessBlockConfiguration", null]);
      const pol = await safe("정책 공개 여부", "PolicyStatus", async () => get(await runJson(d, "aws", ["s3api", "get-bucket-policy-status", ...b]), "PolicyStatus", "IsPublic") as boolean | null,
        ["NoSuchBucketPolicy", false]);
      const acl = await safe("ACL", "Acl", async () => arr(get(await runJson(d, "aws", ["s3api", "get-bucket-acl", ...b]), "Grants"))
        .some((g) => /AllUsers|AuthenticatedUsers/.test(String(get(g, "Grantee", "URI") ?? ""))));
      const life = await safe("수명 주기", "Lifecycle", async () => arr(get(await runJson(d, "aws", ["s3api", "get-bucket-lifecycle-configuration", ...b]), "Rules")),
        ["NoSuchLifecycleConfiguration", []]);
      const cors = await safe("CORS", "Cors", async () => arr(get(await runJson(d, "aws", ["s3api", "get-bucket-cors", ...b]), "CORSRules")),
        ["NoSuchCORSConfiguration", []]);
      // DM-8 DRAFT(ai): 크기는 저장 등급마다 따로 쌓인다 (StandardStorage·StandardIAStorage·Glacier… ). list-metrics 로 이 버킷에 있는 등급을 찾아 합친다.
      //   list-metrics 를 못 쓰면(cloudwatch:ListMetrics 없는 옛 관찰 역할) StandardStorage 만 세고 SizeStorageTypes = null → 매퍼가 검토 표시
      let sizeTypes: string[] | null = null;
      const size = await safe("크기", "SizeBytes", async () => {
        const start = new Date(now.getTime() - 3 * 86400_000).toISOString(), end = now.toISOString();
        sizeTypes = await runJson(d, "aws", ["cloudwatch", "list-metrics", "--namespace", "AWS/S3", "--metric-name", "BucketSizeBytes", "--dimensions", `Name=BucketName,Value=${name}`, ...r])
          .then((m) => [...new Set(arr(get(m, "Metrics")).flatMap((x) => arr(x.Dimensions)).filter((x) => x.Name === "StorageType").map((x) => String(x.Value)))].sort())
          .catch((e) => { if (e instanceof CliError && classifyCliError(e) !== "transient") return null; throw e; });
        let total: number | null = null;
        for (const st of sizeTypes ?? ["StandardStorage"]) {
          const pts = arr(get(await runJson(d, "aws", ["cloudwatch", "get-metric-statistics", "--namespace", "AWS/S3", "--metric-name", "BucketSizeBytes",
            "--dimensions", `Name=BucketName,Value=${name}`, `Name=StorageType,Value=${st}`, "--start-time", start, "--end-time", end,
            "--period", "86400", "--statistics", "Average", ...r]), "Datapoints"));
          const last = pts.sort((x, y) => String(x.Timestamp).localeCompare(String(y.Timestamp))).pop();
          if (typeof last?.Average === "number") total = (total ?? 0) + last.Average;
        }
        return total;   // 등급 목록이 비면(아직 지표 없음) null = 못 셈
      });
      // B-1b: 버킷 이벤트 알림 (S3 → SQS·SNS·Lambda·EventBridge). 못 읽으면 null (= 못 읽음, 매퍼가 검토 줄)
      let notif: Obj | null;
      try { notif = ((await runJson(d, "aws", ["s3api", "get-bucket-notification-configuration", ...b])) ?? {}) as Obj; }
      catch (e) { if (!(e instanceof CliError)) throw e; notes.push(`버킷 ${name} 이벤트 알림 못 읽음: ${cause(e)}`); notif = null; }
      return { kind: DATA_RAW_KINDS.s3, Name: name, Versioning: ver === "Enabled" || ver === "Suspended" ? ver : null,
        PublicAccessBlock: pab, PolicyStatusIsPublic: pol, AclPublic: acl, SizeBytes: size, SizeStorageTypes: sizeTypes, Lifecycle: life, Cors: cors, Arn: `arn:aws:s3:::${name}`,
        ...(unread.length ? { Unread: unread } : {}), Notification: notif };
    }));
  } catch (e) { notes.push(`S3 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "s3", "S3 버킷 목록")); }

  // SQS
  try {
    const urls = arr(get(await runJson(d, "aws", ["sqs", "list-queues", ...r]), "QueueUrls") ?? []).map(String).sort();
    items.push(...(await each(urls, async (url): Promise<Obj | null> => {
      try {
        const a = get(await runJson(d, "aws", ["sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "All", ...r]), "Attributes") as Obj | undefined;
        return { kind: DATA_RAW_KINDS.sqs, QueueUrl: url, Attributes: a ?? {} };
      } catch (e) { notes.push(`SQS ${url.split("/").pop()} 속성 못 읽음: ${cause(e)}`); return unreadOrThrow(e, `sqs.${url.split("/").pop()}`, `SQS 큐 ${url.split("/").pop()} 속성`) as unknown as Obj; }
    })).filter((x): x is Obj => x !== null));
  } catch (e) { notes.push(`SQS 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "sqs", "SQS 큐 목록")); }

  // SNS (B-2): 토픽 + 토픽별 구독. 목록을 못 읽으면 unread(SNS) 검토 줄, 구독을 못 읽으면 그 토픽 Subscriptions=null
  try {
    const topics = arr(get(await runJson(d, "aws", ["sns", "list-topics", ...r]), "Topics")).map((t) => String(t.TopicArn)).filter(Boolean).sort();
    items.push(...await each(topics, async (arn): Promise<Obj> => {
      try {
        const subs = arr(get(await runJson(d, "aws", ["sns", "list-subscriptions-by-topic", "--topic-arn", arn, ...r]), "Subscriptions"))
          .map((s) => ({ Protocol: str(s.Protocol) ?? "", Endpoint: str(s.Endpoint) ?? "" }))
          .sort((x, y) => `${x.Protocol}${x.Endpoint}`.localeCompare(`${y.Protocol}${y.Endpoint}`));
        return { kind: DATA_RAW_KINDS.sns, TopicArn: arn, Subscriptions: subs };
      } catch (e) { unreadOrThrow(e, "sns", `SNS ${arn.split(":").pop()} 구독`); notes.push(`SNS ${arn.split(":").pop()} 구독 못 읽음: ${cause(e)}`); return { kind: DATA_RAW_KINDS.sns, TopicArn: arn, Subscriptions: null }; }   // PF-A2: 일시 오류는 재시도
    }));
  } catch (e) {
    unreadOrThrow(e, "sns", "SNS 토픽 목록");   // PF-A2: 일시 오류는 SOURCE_TRANSIENT 로 던져 재시도 (거부 등은 아래 검토 줄)
    notes.push(`SNS 못 읽음: ${cause(e)}`);
    items.push({ kind: "k8s.unread", resource: "SNS", reason: cause(e), source: "aws:sns" });
  }

  // ElastiCache Memcached (B-3): 복제 그룹이 없는 클러스터 (Memcached 는 복제 그룹을 안 씀). 같은 원본 모양으로 넘긴다
  try {
    const cls = arr(get(await runJson(d, "aws", ["elasticache", "describe-cache-clusters", ...r]), "CacheClusters"))
      .filter((c) => String(c.Engine ?? "").toLowerCase() === "memcached" && !c.ReplicationGroupId)
      .sort((x, y) => String(x.CacheClusterId).localeCompare(String(y.CacheClusterId)));
    for (const c of cls) items.push({ kind: DATA_RAW_KINDS.elasticache, ReplicationGroupId: c.CacheClusterId, Engine: "memcached", EngineVersion: str(c.EngineVersion),
      CacheNodeType: c.CacheNodeType ?? null, ClusterEnabled: null, NodeGroups: typeof c.NumCacheNodes === "number" ? c.NumCacheNodes : null,
      TransitEncryptionEnabled: typeof c.TransitEncryptionEnabled === "boolean" ? c.TransitEncryptionEnabled : null, AuthTokenEnabled: false,
      MultiAZ: null, PrimaryEndpoint: null, ConfigurationEndpoint: str(get(c, "ConfigurationEndpoint", "Address")), ARN: c.ARN ?? null });
  } catch (e) { notes.push(`ElastiCache Memcached 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "elasticache.memcached", "ElastiCache Memcached 클러스터 목록")); }   // PF-A3

  // ElastiCache
  try {
    const groups = arr(get(await runJson(d, "aws", ["elasticache", "describe-replication-groups", ...r]), "ReplicationGroups"));
    for (const g of groups.sort((x, y) => String(x.ReplicationGroupId).localeCompare(String(y.ReplicationGroupId)))) {
      let engine = str(g.Engine), version = str(g.EngineVersion);
      if (!engine) {   // 복제 그룹 응답에 엔진 칸이 없으면 구성원 클러스터 하나에서 읽는다
        const m = arr(g.MemberClusters).map(String).sort()[0];
        if (m) try {
          const c = arr(get(await runJson(d, "aws", ["elasticache", "describe-cache-clusters", "--cache-cluster-id", m, ...r]), "CacheClusters"))[0];
          engine = str(c?.Engine); version = str(c?.EngineVersion);
        } catch (e) { notes.push(`ElastiCache ${String(g.ReplicationGroupId)} 엔진 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, `elasticache.${String(g.ReplicationGroupId)}.engine`, `ElastiCache ${String(g.ReplicationGroupId)} 엔진`)); }
      }
      const ng = arr(g.NodeGroups);
      items.push({ kind: DATA_RAW_KINDS.elasticache, ReplicationGroupId: g.ReplicationGroupId, Engine: engine, EngineVersion: version,
        CacheNodeType: g.CacheNodeType ?? null,
        ClusterEnabled: typeof g.ClusterEnabled === "boolean" ? g.ClusterEnabled : null, NodeGroups: ng.length || null,
        TransitEncryptionEnabled: typeof g.TransitEncryptionEnabled === "boolean" ? g.TransitEncryptionEnabled : null,
        AuthTokenEnabled: typeof g.AuthTokenEnabled === "boolean" ? g.AuthTokenEnabled : null,
        MultiAZ: g.MultiAZ ?? null,
        PrimaryEndpoint: str(get(ng[0], "PrimaryEndpoint", "Address")), ConfigurationEndpoint: str(get(g, "ConfigurationEndpoint", "Address")),
        ReaderEndpoint: str(get(ng[0], "ReaderEndpoint", "Address")), ARN: g.ARN ?? null,
        Port: get(ng[0], "PrimaryEndpoint", "Port") ?? get(g, "ConfigurationEndpoint", "Port") ?? null });   // DM-7
    }
  } catch (e) { notes.push(`ElastiCache 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "elasticache", "ElastiCache 복제 그룹 목록")); }
  return items;
}

export async function readGcpData(d: CliDeps, project: string, notes: string[], refs = ""): Promise<Obj[]> {
  const p = ["--project", project, "--format", "json"];
  const items: Obj[] = [];

  try {
    const buckets = arr(await runJson(d, "gcloud", ["storage", "buckets", "list", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const pickGcs = bucketsToRead(buckets.map((b) => String(b.name ?? "")), refs);
    if (pickGcs.skipped) {
      const why = `Cloud Storage 버킷 ${buckets.length}개 중 이름순 앞 ${MAX_BUCKETS}개 + 앱이 이름을 적은 ${pickGcs.read.length - MAX_BUCKETS}개만 읽음 (${pickGcs.skipped}개 안 읽음)`;
      notes.push(why);
      items.push(unreadItem("gcs.truncated", `${why}. 앱이 비밀 안 주소로만 쓰는 버킷이면 명세에서 빠짐`));
    }
    const wanted = new Set(pickGcs.read);
    items.push(...await each(buckets.filter((b) => wanted.has(String(b.name ?? ""))), async (b): Promise<Obj> => {
      const name = String(b.name ?? "");
      let all: boolean | null = null;
      try {
        const pol = await runJson(d, "gcloud", ["storage", "buckets", "get-iam-policy", `gs://${name}`, "--format", "json"]);
        all = arr(get(pol, "bindings")).some((x) => (Array.isArray(x.members) ? (x.members as unknown[]) : []).some((m) => m === "allUsers" || m === "allAuthenticatedUsers"));
      } catch (e) { notes.push(`GCS ${name} IAM 정책 못 읽음: ${cause(e)}`); }
      const versioning = (b.versioning_enabled ?? get(b, "versioning", "enabled")) as boolean | undefined;
      // B-1b: 버킷 → Pub/Sub 알림. 못 읽으면 null (매퍼가 검토 줄)
      let notifications: Obj[] | null = null;
      try { notifications = arr(await runJson(d, "gcloud", ["storage", "buckets", "notifications", "list", `gs://${name}`, "--format", "json"])); }
      catch (e) { notes.push(`GCS ${name} 이벤트 알림 못 읽음: ${cause(e)}`); }
      const lifecycle = (get(b, "lifecycle_config", "rule") ?? get(b, "lifecycle", "rule")) as unknown;
      return { kind: DATA_RAW_KINDS.gcs, name, versioning: typeof versioning === "boolean" ? versioning : null,
        publicAccessPrevention: str(b.public_access_prevention ?? get(b, "iamConfiguration", "publicAccessPrevention")),
        allUsersBinding: all, lifecycleRules: Array.isArray(lifecycle) ? lifecycle : null,
        cors: Array.isArray(b.cors_config ?? b.cors) ? (b.cors_config ?? b.cors) : null, selfLink: str(b.selfLink ?? b.url), notifications };
    }));
  } catch (e) { notes.push(`Cloud Storage 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "gcs", "Cloud Storage 버킷 목록")); }

  try {
    const topics = arr(await runJson(d, "gcloud", ["pubsub", "topics", "list", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    let subs: Obj[] = [];
    let subsOk = true;
    try { subs = arr(await runJson(d, "gcloud", ["pubsub", "subscriptions", "list", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name))); }
    catch (e) { subsOk = false; notes.push(`Pub/Sub 구독 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "pubsub.subscriptions", "Pub/Sub 구독 목록")); }
    // PS-1·DM-6·B-1: 토픽의 구독을 전부 넘긴다 (대표 하나가 아님). 보관·만료·필터·push 주소까지. 못 읽었으면 null (없음과 다름)
    for (const t of topics) {
      const mine = subs.filter((x) => x.topic === t.name).map((s) => ({ name: s.name, ackDeadlineSeconds: s.ackDeadlineSeconds, enableMessageOrdering: s.enableMessageOrdering,
        deadLetterPolicy: s.deadLetterPolicy, messageRetentionDuration: s.messageRetentionDuration, retainAckedMessages: s.retainAckedMessages,
        expirationPolicy: s.expirationPolicy, filter: s.filter, pushConfig: s.pushConfig ? { pushEndpoint: get(s.pushConfig, "pushEndpoint") } : null,
        bigqueryConfig: s.bigqueryConfig, cloudStorageConfig: s.cloudStorageConfig }));
      items.push({ kind: DATA_RAW_KINDS.pubsub, name: t.name, messageRetentionDuration: str(t.messageRetentionDuration), subscriptions: subsOk ? mine : null });
    }
  } catch (e) { notes.push(`Pub/Sub 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "pubsub", "Pub/Sub 토픽 목록")); }

  try {
    for (const m of arr(await runJson(d, "gcloud", ["redis", "instances", "list", "--region", "-", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name))))
      items.push({ kind: DATA_RAW_KINDS.memorystore, name: m.name, redisVersion: str(m.redisVersion), memorySizeGb: m.memorySizeGb ?? null, tier: str(m.tier),
        transitEncryptionMode: str(m.transitEncryptionMode), authEnabled: typeof m.authEnabled === "boolean" ? m.authEnabled : null, host: str(m.host), port: m.port ?? null,
        readEndpoint: str(m.readEndpoint) });
  } catch (e) { notes.push(`Memorystore 못 읽음: ${cause(e)}`); items.push(unreadOrThrow(e, "memorystore", "Memorystore 인스턴스 목록")); }
  return items;
}
