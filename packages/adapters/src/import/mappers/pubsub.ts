import { DATA_RAW_KINDS, type RawPubsubTopic } from "../raw-data.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): Pub/Sub 토픽 → queue(model=topic) (설계 20번 6.7장). 토픽 하나 = 리소스 하나. 구독 설정(ack·순서·DLQ)은 읽은 대표 구독 하나의 값
//   DLQ 는 다른 토픽 → 파이프라인이 id 가 정해진 뒤 deadLetter.to 를 채운다 (deadLetterRef)
const secOf = (d: string | null | undefined): number | null => { const m = /^(\d+)(?:\.\d+)?s$/.exec(d ?? ""); return m ? Number(m[1]) : null; };
export const topicNameOf = (full: string) => full.split("/").pop() ?? "";

export const pubsubMapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.pubsub],
  kind: "queue",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const t = item as unknown as RawPubsubTopic;
    if (!t.name) return { skip: "토픽 이름 없음 (깨진 원본)", grade: "C" };
    const name = topicNameOf(t.name);
    if (!name) return { skip: "토픽 이름을 못 뽑음", grade: "C" };
    const src = (k: string) => `pubsub:${name}.${k}`;
    const props: Record<string, unknown> = { model: "topic" };
    const meta: Record<string, MetaTuple> = { model: [`pubsub:${name}`, 1] };
    const ret = secOf(t.messageRetentionDuration);
    if (ret !== null && ret >= 60 && ret <= 2678400) { props.retentionSec = ret; meta.retentionSec = [src("messageRetentionDuration"), 1]; }
    const sub = t.subscription;
    if (sub) {
      if (typeof sub.ackDeadlineSeconds === "number") { props.ackTimeoutSec = sub.ackDeadlineSeconds; meta.ackTimeoutSec = [src("subscription.ackDeadlineSeconds"), 1]; }
      if (typeof sub.enableMessageOrdering === "boolean") {
        props.ordered = sub.enableMessageOrdering;
        meta.ordered = sub.enableMessageOrdering ? [src("subscription.enableMessageOrdering"), 0.9, "Pub/Sub 순서 = 순서 키. SQS FIFO 의 중복 제거와 뜻이 다름"] : [src("subscription.enableMessageOrdering"), 1];
      }
    } else meta.ackTimeoutSec = [src("subscription"), 0.6, "구독을 못 읽어 ack 시간·순서·DLQ 를 모름"];
    let deadLetterRef: { arn: string; name: string } | undefined;
    const dl = sub?.deadLetterPolicy;
    if (dl?.deadLetterTopic) {
      deadLetterRef = { arn: dl.deadLetterTopic, name: topicNameOf(dl.deadLetterTopic) };
      props.deadLetter = { ...(typeof dl.maxDeliveryAttempts === "number" ? { maxReceive: dl.maxDeliveryAttempts } : {}) };
      meta.deadLetter = [src("subscription.deadLetterPolicy"), 1];
    }
    return { name, kind: "queue", native: { type: DATA_RAW_KINDS.pubsub, name, endpoint: name, uid: t.name }, props, meta, ...(deadLetterRef ? { deadLetterRef } : {}) };
  },
};
