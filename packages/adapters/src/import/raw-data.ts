// I6: 관리형 데이터 자원(S3·SQS·ElastiCache·GCS·Pub/Sub·Memorystore)의 원본 모양. discover 가 list·describe 로 읽어 만든다.
//   값을 못 읽은 칸은 null (지어내지 않음). 모든 칸은 선택 — 깨진 원본도 매퍼가 skip 또는 null 로 받는다.
export const DATA_RAW_KINDS = {
  s3: "s3.bucket", sqs: "sqs.queue", elasticache: "elasticache.replicationGroup",
  gcs: "gcs.bucket", pubsub: "pubsub.topic", memorystore: "memorystore.instance", sns: "sns.topic",
} as const;

/** S3 버킷. 읽기 API 하나씩의 결과를 그대로 모은다 (Get* 응답의 해당 칸) */
export interface RawS3Bucket {
  kind: "s3.bucket";
  Name?: string;
  Versioning?: "Enabled" | "Suspended" | null;                 // GetBucketVersioning.Status (없으면 한 번도 안 켠 것 = null)
  PublicAccessBlock?: { BlockPublicAcls?: boolean; IgnorePublicAcls?: boolean; BlockPublicPolicy?: boolean; RestrictPublicBuckets?: boolean } | null;
  PolicyStatusIsPublic?: boolean | null;                       // GetBucketPolicyStatus.PolicyStatus.IsPublic
  AclPublic?: boolean | null;                                  // GetBucketAcl 의 Grants 에 AllUsers·AuthenticatedUsers 가 있나
  SizeBytes?: number | null;                                   // CloudWatch BucketSizeBytes (못 읽으면 null). DM-8: 저장 등급 전부 합
  SizeStorageTypes?: string[] | null;                          // DM-8: 합친 저장 등급. null = 등급 목록 못 읽음 → StandardStorage 만 셈
  Lifecycle?: Array<{ ID?: string; Status?: string; Filter?: { Prefix?: string; Tag?: unknown; And?: unknown }; Prefix?: string;
    Expiration?: { Days?: number; Date?: string; ExpiredObjectDeleteMarker?: boolean }; Transitions?: Array<{ Days?: number; Date?: string; StorageClass?: string }>;
    NoncurrentVersionExpiration?: unknown; NoncurrentVersionTransitions?: unknown; AbortIncompleteMultipartUpload?: unknown }> | null;   // null = 설정 없음/못 읽음
  Cors?: Array<Record<string, unknown>> | null;
  Arn?: string | null;
  /** DM-2·RF-2: 읽기가 실패한 칸 이름 ("설정 없음" 오류는 여기 안 들어감 = 진짜 없음). 여기 있는 칸의 null 은 "모름" */
  Unread?: Array<"Versioning" | "PublicAccessBlock" | "PolicyStatus" | "Acl" | "Lifecycle" | "Cors" | "SizeBytes">;
  /** B-1b: GetBucketNotificationConfiguration 응답 그대로. null = 못 읽음, 없으면 옛 원본(안 읽음) */
  Notification?: { QueueConfigurations?: S3NotifyRule[]; TopicConfigurations?: S3NotifyRule[]; LambdaFunctionConfigurations?: S3NotifyRule[];
    EventBridgeConfiguration?: unknown } | null;
}
export interface S3NotifyRule { QueueArn?: string; TopicArn?: string; LambdaFunctionArn?: string; Events?: string[];
  Filter?: { Key?: { FilterRules?: Array<{ Name?: string; Value?: string }> } } }
/** B-2: SNS 토픽 + 구독 (Subscriptions null = 못 읽음) */
export interface RawSnsTopic { kind: "sns.topic"; TopicArn?: string; Subscriptions?: Array<{ Protocol?: string; Endpoint?: string }> | null }
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
  ReaderEndpoint?: string | null;                             // G3b-4: 읽기 주소 (NodeGroups[0].ReaderEndpoint)
  ARN?: string | null;
  Port?: number | null;   // DM-7
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
  /** B-1b: notifications list 결과 (topic = //pubsub.googleapis.com/projects/<p>/topics/<t>). null = 못 읽음 */
  notifications?: Array<{ topic?: string; event_types?: string[]; object_name_prefix?: string }> | null;
}
/** Pub/Sub 구독 하나 (gcloud pubsub subscriptions list 한 줄에서 필요한 칸) */
export interface RawPubsubSubscription {
  name?: string;                                              // projects/<p>/subscriptions/<이름>
  ackDeadlineSeconds?: number; enableMessageOrdering?: boolean;
  deadLetterPolicy?: { deadLetterTopic?: string; maxDeliveryAttempts?: number };
  messageRetentionDuration?: string | null;                  // 구독 보관 (안 받은 메시지). 기본 7일
  retainAckedMessages?: boolean;
  expirationPolicy?: { ttl?: string } | null;                // {} = 만료 안 함, ttl 있음 = 안 쓰면 지움
  filter?: string;
  pushConfig?: { pushEndpoint?: string } | null;
  bigqueryConfig?: unknown; cloudStorageConfig?: unknown;     // 내보내기 구독 (못 옮김)
}
/** Pub/Sub 토픽 + 이 토픽의 구독 전부 (PS-1). subscription(단수) = 옛 가져오기 원본(대표 하나, 이름 없음) — 옛 판 그대로 읽으려고 둠 */
export interface RawPubsubTopic {
  kind: "pubsub.topic";
  name?: string;                                              // projects/<p>/topics/<이름>
  messageRetentionDuration?: string | null;                  // "86400s" 토픽 보관 (되감기용, 구독 보관과 다름)
  subscriptions?: RawPubsubSubscription[] | null;            // null = 구독 목록을 못 읽음
  subscription?: { name?: string; ackDeadlineSeconds?: number; enableMessageOrdering?: boolean; deadLetterPolicy?: { deadLetterTopic?: string; maxDeliveryAttempts?: number } } | null;
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
  readEndpoint?: string | null;                               // G3b-4: 읽기 복제본 주소 (STANDARD_HA + 읽기 복제본일 때)
  port?: number | null;
}
