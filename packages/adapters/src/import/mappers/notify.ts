import type { RawGcsBucket, RawS3Bucket, S3NotifyRule } from "../raw-data.js";
import type { MetaTuple } from "../types.js";

// B-1b: 버킷 이벤트 알림 → objectStore.props.notifications. 대상 id(to)는 파이프라인이 notifyRefs(ARN·토픽 전체 이름)로 채운다
//   DRAFT(ai): 필터는 접두어·접미어만 (S3 FilterRules prefix·suffix, GCS object_name_prefix). 다른 꼴은 못 담음 → 검토
export interface NotifyItem { target: "queue" | "topic" | "function" | "eventbus"; events: string[]; prefix?: string; suffix?: string; to?: string }
export interface NotifyRef { index: number; uid: string }
export interface NotifyOut { items: NotifyItem[]; refs: NotifyRef[]; meta?: MetaTuple }

const keyFilter = (r: S3NotifyRule) => {
  const fr = r.Filter?.Key?.FilterRules ?? [];
  const get = (n: string) => fr.find((x) => String(x.Name).toLowerCase() === n)?.Value;
  return { ...(get("prefix") ? { prefix: get("prefix")! } : {}), ...(get("suffix") ? { suffix: get("suffix")! } : {}) };
};

export function s3Notifications(b: RawS3Bucket, src: string): NotifyOut | null {
  if (b.Notification === undefined) return null;   // 옛 원본 (안 읽음)
  if (b.Notification === null) return { items: [], refs: [], meta: [src, 0.6, "이벤트 알림 설정을 못 읽음 (관찰 권한 s3:GetBucketNotification 확인) → 버킷 → 큐 알림이 빠졌을 수 있음"] };
  const n = b.Notification, items: NotifyItem[] = [], refs: NotifyRef[] = [];
  const push = (target: NotifyItem["target"], r: S3NotifyRule, uid?: string) => {
    if (uid) refs.push({ index: items.length, uid });
    items.push({ target, events: [...(r.Events ?? [])].sort(), ...keyFilter(r) });
  };
  for (const r of n.QueueConfigurations ?? []) push("queue", r, r.QueueArn);
  for (const r of n.TopicConfigurations ?? []) push("topic", r, r.TopicArn);
  for (const r of n.LambdaFunctionConfigurations ?? []) push("function", r);
  if (n.EventBridgeConfiguration) items.push({ target: "eventbus", events: ["*"] });
  const outside = items.filter((x) => x.target === "function" || x.target === "eventbus").length;
  return { items, refs, ...(items.length ? { meta: outside
    ? [src, 0.6, `알림 ${items.length}개 중 ${outside}개는 함수·EventBridge(IR 밖) → 도착에서 사람이 정함`] as MetaTuple
    : [src, 1] as MetaTuple } : {}) };
}

export function gcsNotifications(b: RawGcsBucket, src: string): NotifyOut | null {
  if (b.notifications === undefined) return null;
  if (b.notifications === null) return { items: [], refs: [], meta: [src, 0.6, "이벤트 알림 설정을 못 읽음 (관찰 권한 storage.buckets.get 확인) → 버킷 → 토픽 알림이 빠졌을 수 있음"] };
  const items: NotifyItem[] = [], refs: NotifyRef[] = [];
  for (const x of b.notifications) {
    const uid = String(x.topic ?? "").replace(/^\/\/pubsub\.googleapis\.com\//, "");
    if (uid) refs.push({ index: items.length, uid });
    items.push({ target: "topic", events: [...(x.event_types ?? [])].sort(), ...(x.object_name_prefix ? { prefix: x.object_name_prefix } : {}) });
  }
  return { items, refs, ...(items.length ? { meta: [src, 1] as MetaTuple } : {}) };
}
