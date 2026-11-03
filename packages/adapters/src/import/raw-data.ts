// I6: 관리형 데이터 자원(S3·SQS·ElastiCache·GCS·Pub/Sub·Memorystore)의 원본 모양. discover 가 list·describe 로 읽어 만든다.
//   값을 못 읽은 칸은 null (지어내지 않음). 모든 칸은 선택 — 깨진 원본도 매퍼가 skip 또는 null 로 받는다.
export const DATA_RAW_KINDS = {
  s3: "s3.bucket", sqs: "sqs.queue", elasticache: "elasticache.replicationGroup",
  gcs: "gcs.bucket", pubsub: "pubsub.topic", memorystore: "memorystore.instance",
} as const;

/** S3 버킷. 읽기 API 하나씩의 결과를 그대로 모은다 (Get* 응답의 해당 칸) */
export interface RawS3Bucket {
  kind: "s3.bucket";
  Name?: string;
  Versioning?: "Enabled" | "Suspended" | null;                 // GetBucketVersioning.Status (없으면 한 번도 안 켠 것 = null)
  PublicAccessBlock?: { BlockPublicAcls?: boolean; IgnorePublicAcls?: boolean; BlockPublicPolicy?: boolean; RestrictPublicBuckets?: boolean } | null;
  PolicyStatusIsPublic?: boolean | null;                       // GetBucketPolicyStatus.PolicyStatus.IsPublic
  AclPublic?: boolean | null;                                  // GetBucketAcl 의 Grants 에 AllUsers·AuthenticatedUsers 가 있나
  SizeBytes?: number | null;                                   // CloudWatch BucketSizeBytes (못 읽으면 null)
  Lifecycle?: Array<{ ID?: string; Status?: string; Filter?: { Prefix?: string; Tag?: unknown; And?: unknown }; Prefix?: string;
    Expiration?: { Days?: number }; Transitions?: Array<{ Days?: number; StorageClass?: string }> }> | null;   // null = 설정 없음/못 읽음
  Cors?: Array<Record<string, unknown>> | null;
  Arn?: string | null;
}
/** SQS 큐. GetQueueAttributes(All) 결과 */
export interface RawSqsQueue {
  kind: "sqs.queue";
  QueueUrl?: string;
  Attributes?: { FifoQueue?: string; MessageRetentionPeriod?: string; VisibilityTimeout?: string; RedrivePolicy?: string; QueueArn?: string };
}
/** ElastiCache 복제 그룹 (DescribeReplicationGroups 한 줄) */
export interface RawElastiCache {
  kind: "elasticache.replicationGroup";
  ReplicationGroupId?: string;
  Engine?: string; EngineVersion?: string | null;
  CacheNodeType?: string | null;
  ClusterEnabled?: boolean | null;
  NodeGroups?: number | null;
  TransitEncryptionEnabled?: boolean | null;
  AuthTokenEnabled?: boolean | null;
  MultiAZ?: string | null;                                    // "enabled" | "disabled"
  PrimaryEndpoint?: string | null;
  ConfigurationEndpoint?: string | null;
  ARN?: string | null;
}
/** Cloud Storage 버킷 (gcloud storage buckets list --format json 한 줄에서 필요한 칸) */
export interface RawGcsBucket {
  kind: "gcs.bucket";
  name?: string;
  versioning?: boolean | null;
  publicAccessPrevention?: string | null;                     // "enforced" | "inherited"
  allUsersBinding?: boolean | null;                           // IAM 에 allUsers·allAuthenticatedUsers 바인딩이 있나 (못 읽으면 null)
  lifecycleRules?: Array<{ action?: { type?: string }; condition?: { age?: number; matchesPrefix?: string[]; matchesStorageClass?: string[] } }> | null;
  cors?: Array<Record<string, unknown>> | null;
  selfLink?: string | null;
}
/** Pub/Sub 토픽 (+ 이 토픽을 보는 구독 중 대표 하나의 설정) */
export interface RawPubsubTopic {
  kind: "pubsub.topic";
  name?: string;                                              // projects/<p>/topics/<이름>
  messageRetentionDuration?: string | null;                  // "86400s"
  subscription?: { ackDeadlineSeconds?: number; enableMessageOrdering?: boolean; deadLetterPolicy?: { deadLetterTopic?: string; maxDeliveryAttempts?: number } } | null;
}
/** Memorystore for Redis 인스턴스 */
export interface RawMemorystore {
  kind: "memorystore.instance";
  name?: string;                                              // projects/<p>/locations/<l>/instances/<이름>
  redisVersion?: string | null;                               // REDIS_7_0
  memorySizeGb?: number | null;
  tier?: string | null;                                       // BASIC | STANDARD_HA
  transitEncryptionMode?: string | null;
  authEnabled?: boolean | null;
  host?: string | null;
  port?: number | null;
}
