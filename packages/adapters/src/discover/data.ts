import { arr, CliError, get, runJson, str, type CliDeps } from "../common/cli.js";
import { DATA_RAW_KINDS } from "../import/raw-data.js";

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
  "s3:GetLifecycleConfiguration", "s3:GetBucketCORS", "cloudwatch:GetMetricStatistics",
  "sqs:ListQueues", "sqs:GetQueueAttributes",
  "elasticache:DescribeReplicationGroups", "elasticache:DescribeCacheClusters",
] as const;
export const GCP_DATA_READ_PERMISSIONS = [
  "storage.buckets.list", "storage.buckets.getIamPolicy",
  "pubsub.topics.list", "pubsub.subscriptions.list",
  "redis.instances.list",
] as const;

// DRAFT(ai): 버킷은 이름순 앞 50개만 자세히 읽는다 (호출 수 제한). 넘으면 notes
export const MAX_BUCKETS = 50;

const stderrOf = (e: unknown) => (e instanceof CliError ? e.stderr : "");
const isMissing = (e: unknown, code: string) => stderrOf(e).includes(code);
async function each<T, R>(xs: T[], f: (x: T) => Promise<R>, width = 5): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += width) out.push(...(await Promise.all(xs.slice(i, i + width).map(f))));
  return out;
}
const cause = (e: unknown) => (e as Error).message.slice(0, 120);

export async function readAwsData(d: CliDeps, region: string, notes: string[], now = new Date()): Promise<Obj[]> {
  const r = ["--region", region, "--output", "json"];
  const items: Obj[] = [];

  // S3
  try {
    const all = arr(get(await runJson(d, "aws", ["s3api", "list-buckets", "--output", "json"]), "Buckets")).map((b) => String(b.Name)).sort();
    if (all.length > MAX_BUCKETS) notes.push(`S3 버킷 ${all.length}개 중 이름순 앞 ${MAX_BUCKETS}개만 읽음`);
    items.push(...await each(all.slice(0, MAX_BUCKETS), async (name): Promise<Obj> => {
      const b = ["--bucket", name, "--output", "json"];
      const safe = async <T>(label: string, f: () => Promise<T>, onMissing?: [string, T]): Promise<T | null> => {
        try { return await f(); }
        catch (e) {
          if (onMissing && isMissing(e, onMissing[0])) return onMissing[1];
          notes.push(`S3 ${name} ${label} 못 읽음: ${cause(e)}`); return null;
        }
      };
      const ver = await safe("버전 관리", async () => str(get(await runJson(d, "aws", ["s3api", "get-bucket-versioning", ...b]), "Status")));
      const pab = await safe("퍼블릭 액세스 차단", async () => (get(await runJson(d, "aws", ["s3api", "get-public-access-block", ...b]), "PublicAccessBlockConfiguration") ?? null) as Obj | null,
        ["NoSuchPublicAccessBlockConfiguration", null]);
      const pol = await safe("정책 공개 여부", async () => get(await runJson(d, "aws", ["s3api", "get-bucket-policy-status", ...b]), "PolicyStatus", "IsPublic") as boolean | null,
        ["NoSuchBucketPolicy", false]);
      const acl = await safe("ACL", async () => arr(get(await runJson(d, "aws", ["s3api", "get-bucket-acl", ...b]), "Grants"))
        .some((g) => /AllUsers|AuthenticatedUsers/.test(String(get(g, "Grantee", "URI") ?? ""))));
      const life = await safe("수명 주기", async () => arr(get(await runJson(d, "aws", ["s3api", "get-bucket-lifecycle-configuration", ...b]), "Rules")),
        ["NoSuchLifecycleConfiguration", []]);
      const cors = await safe("CORS", async () => arr(get(await runJson(d, "aws", ["s3api", "get-bucket-cors", ...b]), "CORSRules")),
        ["NoSuchCORSConfiguration", []]);
      const size = await safe("크기", async () => {
        const start = new Date(now.getTime() - 3 * 86400_000).toISOString(), end = now.toISOString();
        const pts = arr(get(await runJson(d, "aws", ["cloudwatch", "get-metric-statistics", "--namespace", "AWS/S3", "--metric-name", "BucketSizeBytes",
          "--dimensions", `Name=BucketName,Value=${name}`, "Name=StorageType,Value=StandardStorage", "--start-time", start, "--end-time", end,
          "--period", "86400", "--statistics", "Average", ...r]), "Datapoints"));
        const last = pts.sort((x, y) => String(x.Timestamp).localeCompare(String(y.Timestamp))).pop();
        return typeof last?.Average === "number" ? last.Average : null;
      });
      return { kind: DATA_RAW_KINDS.s3, Name: name, Versioning: ver === "Enabled" || ver === "Suspended" ? ver : null,
        PublicAccessBlock: pab, PolicyStatusIsPublic: pol, AclPublic: acl, SizeBytes: size, Lifecycle: life, Cors: cors, Arn: `arn:aws:s3:::${name}` };
    }));
  } catch (e) { notes.push(`S3 못 읽음: ${cause(e)}`); }

  // SQS
  try {
    const urls = arr(get(await runJson(d, "aws", ["sqs", "list-queues", ...r]), "QueueUrls") ?? []).map(String).sort();
    items.push(...(await each(urls, async (url): Promise<Obj | null> => {
      try {
        const a = get(await runJson(d, "aws", ["sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "All", ...r]), "Attributes") as Obj | undefined;
        return { kind: DATA_RAW_KINDS.sqs, QueueUrl: url, Attributes: a ?? {} };
      } catch (e) { notes.push(`SQS ${url.split("/").pop()} 속성 못 읽음: ${cause(e)}`); return null; }
    })).filter((x): x is Obj => x !== null));
  } catch (e) { notes.push(`SQS 못 읽음: ${cause(e)}`); }

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
        } catch (e) { notes.push(`ElastiCache ${String(g.ReplicationGroupId)} 엔진 못 읽음: ${cause(e)}`); }
      }
      const ng = arr(g.NodeGroups);
      items.push({ kind: DATA_RAW_KINDS.elasticache, ReplicationGroupId: g.ReplicationGroupId, Engine: engine, EngineVersion: version,
        CacheNodeType: g.CacheNodeType ?? null,
        ClusterEnabled: typeof g.ClusterEnabled === "boolean" ? g.ClusterEnabled : null, NodeGroups: ng.length || null,
        TransitEncryptionEnabled: typeof g.TransitEncryptionEnabled === "boolean" ? g.TransitEncryptionEnabled : null,
        AuthTokenEnabled: typeof g.AuthTokenEnabled === "boolean" ? g.AuthTokenEnabled : null,
        MultiAZ: g.MultiAZ ?? null,
        PrimaryEndpoint: str(get(ng[0], "PrimaryEndpoint", "Address")), ConfigurationEndpoint: str(get(g, "ConfigurationEndpoint", "Address")), ARN: g.ARN ?? null });
    }
  } catch (e) { notes.push(`ElastiCache 못 읽음: ${cause(e)}`); }
  return items;
}

export async function readGcpData(d: CliDeps, project: string, notes: string[]): Promise<Obj[]> {
  const p = ["--project", project, "--format", "json"];
  const items: Obj[] = [];

  try {
    const buckets = arr(await runJson(d, "gcloud", ["storage", "buckets", "list", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    if (buckets.length > MAX_BUCKETS) notes.push(`Cloud Storage 버킷 ${buckets.length}개 중 이름순 앞 ${MAX_BUCKETS}개만 읽음`);
    items.push(...await each(buckets.slice(0, MAX_BUCKETS), async (b): Promise<Obj> => {
      const name = String(b.name ?? "");
      let all: boolean | null = null;
      try {
        const pol = await runJson(d, "gcloud", ["storage", "buckets", "get-iam-policy", `gs://${name}`, "--format", "json"]);
        all = arr(get(pol, "bindings")).some((x) => (Array.isArray(x.members) ? (x.members as unknown[]) : []).some((m) => m === "allUsers" || m === "allAuthenticatedUsers"));
      } catch (e) { notes.push(`GCS ${name} IAM 정책 못 읽음: ${cause(e)}`); }
      const versioning = (b.versioning_enabled ?? get(b, "versioning", "enabled")) as boolean | undefined;
      const lifecycle = (get(b, "lifecycle_config", "rule") ?? get(b, "lifecycle", "rule")) as unknown;
      return { kind: DATA_RAW_KINDS.gcs, name, versioning: typeof versioning === "boolean" ? versioning : null,
        publicAccessPrevention: str(b.public_access_prevention ?? get(b, "iamConfiguration", "publicAccessPrevention")),
        allUsersBinding: all, lifecycleRules: Array.isArray(lifecycle) ? lifecycle : null,
        cors: Array.isArray(b.cors_config ?? b.cors) ? (b.cors_config ?? b.cors) : null, selfLink: str(b.selfLink ?? b.url) };
    }));
  } catch (e) { notes.push(`Cloud Storage 못 읽음: ${cause(e)}`); }

  try {
    const topics = arr(await runJson(d, "gcloud", ["pubsub", "topics", "list", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    let subs: Obj[] = [];
    try { subs = arr(await runJson(d, "gcloud", ["pubsub", "subscriptions", "list", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name))); }
    catch (e) { notes.push(`Pub/Sub 구독 못 읽음: ${cause(e)}`); }
    for (const t of topics) {
      const s = subs.find((x) => x.topic === t.name);
      items.push({ kind: DATA_RAW_KINDS.pubsub, name: t.name, messageRetentionDuration: str(t.messageRetentionDuration),
        subscription: s ? { ackDeadlineSeconds: s.ackDeadlineSeconds, enableMessageOrdering: s.enableMessageOrdering, deadLetterPolicy: s.deadLetterPolicy } : null });
    }
  } catch (e) { notes.push(`Pub/Sub 못 읽음: ${cause(e)}`); }

  try {
    for (const m of arr(await runJson(d, "gcloud", ["redis", "instances", "list", "--region", "-", ...p])).sort((x, y) => String(x.name).localeCompare(String(y.name))))
      items.push({ kind: DATA_RAW_KINDS.memorystore, name: m.name, redisVersion: str(m.redisVersion), memorySizeGb: m.memorySizeGb ?? null, tier: str(m.tier),
        transitEncryptionMode: str(m.transitEncryptionMode), authEnabled: typeof m.authEnabled === "boolean" ? m.authEnabled : null, host: str(m.host), port: m.port ?? null });
  } catch (e) { notes.push(`Memorystore 못 읽음: ${cause(e)}`); }
  return items;
}
