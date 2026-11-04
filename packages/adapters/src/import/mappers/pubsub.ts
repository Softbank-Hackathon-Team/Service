import { DATA_RAW_KINDS, type RawPubsubSubscription, type RawPubsubTopic } from "../raw-data.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): Pub/Sub 토픽 → queue (설계 20번 6.7장). 토픽 하나 = 리소스 하나.
//   PS-1: 구독을 전부 읽는다. 구독 0개 = model=topic, 1개 = model=queue(받는 칸 = 그 구독 값, 구독 이름은 별칭), 2개 이상 = model=topic + subscriptions 목록.
//   DM-6: retentionSec 은 구독 보관(안 받은 메시지)이다. 토픽 보관(되감기용)은 IR 에 칸이 없어 버리고 검토 표시
//   B-1: push 구독은 push.endpoint 로 담는다 (도착에서 그대로 보낼지·바꿀지는 v2Blockers)
//   옛 원본(subscription 단수 = 대표 구독 하나, 이름 없음)은 예전처럼 model=topic + 대표 값으로 읽는다
//   DLQ 는 다른 토픽 → 파이프라인이 id 가 정해진 뒤 deadLetter.to 를 채운다 (deadLetterRef)
const secOf = (d: string | null | undefined): number | null => { const m = /^(\d+)(?:\.\d+)?s$/.exec(d ?? ""); return m ? Number(m[1]) : null; };
export const topicNameOf = (full: string) => full.split("/").pop() ?? "";
const IR_RET = [60, 2678400] as const;   // IR retentionSec 범위 (contracts QueueV2)

/** 구독 하나 → IR 받는 칸 (ReceiveV2). 못 담는 값은 notes 에 이유 */
function receiveOf(s: RawPubsubSubscription, notes: string[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (typeof s.ackDeadlineSeconds === "number") r.ackTimeoutSec = s.ackDeadlineSeconds;
  if (typeof s.enableMessageOrdering === "boolean") r.ordered = s.enableMessageOrdering;
  const ret = secOf(s.messageRetentionDuration);
  if (ret !== null && ret >= IR_RET[0] && ret <= IR_RET[1]) r.retentionSec = ret;
  else if (s.messageRetentionDuration) notes.push(`구독 보관 ${s.messageRetentionDuration} 을 못 담음 (IR 범위 60~2678400초 밖이거나 형식이 다름) → 도착 상품 기본값`);
  if (s.retainAckedMessages === true) r.retainAcked = true;
  const ttl = s.expirationPolicy?.ttl;
  if (ttl) { const n = secOf(ttl); if (n !== null && n > 0) r.idleExpirySec = n; else notes.push(`구독 만료 ${ttl} 를 못 읽음 → 만료 안 함으로 둠`); }
  if (typeof s.filter === "string" && s.filter.length) r.filter = s.filter;
  if (s.pushConfig?.pushEndpoint) r.push = { endpoint: s.pushConfig.pushEndpoint };
  if (s.bigqueryConfig || s.cloudStorageConfig) notes.push(`${topicNameOf(s.name ?? "") || "구독"} 은 BigQuery·Cloud Storage 내보내기 구독 → 도착에 안 만듦`);
  return r;
}

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
    const aliases: string[] = [];
    let deadLetterRef: { arn: string; name: string } | undefined;
    const setDlq = (dl: { deadLetterTopic?: string; maxDeliveryAttempts?: number } | undefined, at: string) => {
      if (!dl?.deadLetterTopic) return;
      deadLetterRef = { arn: dl.deadLetterTopic, name: topicNameOf(dl.deadLetterTopic) };
      props.deadLetter = { ...(typeof dl.maxDeliveryAttempts === "number" ? { maxReceive: dl.maxDeliveryAttempts } : {}) };
      meta.deadLetter = [src(`${at}.deadLetterPolicy`), 1];
    };

    if (t.subscriptions !== undefined) {
      // DM-6: 토픽 보관은 구독 보관과 뜻이 달라 IR 에 안 넣는다 (되감기용). 켜져 있었으면 검토 표시
      const topicRet = secOf(t.messageRetentionDuration);
      const subs = (t.subscriptions ?? []).filter((s) => s && s.name).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (t.subscriptions === null) meta.ackTimeoutSec = [src("subscriptions"), 0.6, "구독 목록을 못 읽어 받는 쪽(구독) 설정을 모름 → 도착에 구독을 안 만듦"];
      else if (subs.length === 1) {
        // PS-1: 받는 구독이 하나 = 꺼내 읽는 큐 (GCP 도착 = 토픽 + 같은 설정의 구독 하나, AWS 도착 = SQS)
        const s = subs[0]!, sn = topicNameOf(s.name!), notes: string[] = [];
        props.model = "queue";
        Object.assign(props, receiveOf(s, notes));
        meta.model = [src(`subscriptions/${sn}`), 1, `구독 하나(${sn}) → 꺼내 읽는 queue`];
        meta.ackTimeoutSec = notes.length ? [src(`subscriptions/${sn}`), 0.6, notes.join("; ")] : [src(`subscriptions/${sn}`), 1];
        if (props.ordered === true) meta.ordered = [src(`subscriptions/${sn}.enableMessageOrdering`), 0.9, "Pub/Sub 순서 = 순서 키. SQS FIFO 의 중복 제거와 뜻이 다름"];
        if (!s.expirationPolicy?.ttl) meta.idleExpirySec = [src(`subscriptions/${sn}.expirationPolicy`), 1, "만료 안 함"];
        aliases.push(sn);
        setDlq(s.deadLetterPolicy, `subscriptions/${sn}`);
      } else if (subs.length > 1) {
        // PS-1: 구독 여럿 = 토픽 + 구독 목록 (각자 받음). 구독 목록 안 DLQ 는 아직 못 그림 → v2Blockers
        const notes: string[] = [];
        props.subscriptions = subs.map((s) => {
          const dl = s.deadLetterPolicy?.deadLetterTopic ? { deadLetter: { ...(typeof s.deadLetterPolicy.maxDeliveryAttempts === "number" ? { maxReceive: s.deadLetterPolicy.maxDeliveryAttempts } : {}) } } : {};
          return { name: topicNameOf(s.name!), ...receiveOf(s, notes), ...dl };
        });
        meta.subscriptions = notes.length ? [src("subscriptions"), 0.6, notes.join("; ")] : [src("subscriptions"), 1];
        // SUB-1: 구독 이름도 이 토픽의 주소 (env 에 구독 이름을 적은 워커 → 의존성·이름 다시 쓰기). env-rewrite 가 구독 이름이면 fromLink.subscription 으로
        for (const s of props.subscriptions as Array<{ name: string }>) aliases.push(s.name);
      } else meta.subscriptions = [src("subscriptions"), 1, "구독 없음 (보내기만 하는 토픽)"];
      if (topicRet !== null) meta.retentionSec = [src("messageRetentionDuration"), 0.6, `토픽 보관 ${topicRet}초(되감기용)는 IR 에 칸이 없어 안 옮김. retentionSec 은 구독 보관`];
    } else {
      // 옛 원본: 토픽 보관을 retentionSec 으로, 대표 구독 하나의 ack·순서·DLQ (모델은 topic)
      const ret = secOf(t.messageRetentionDuration);
      if (ret !== null && ret >= IR_RET[0] && ret <= IR_RET[1]) { props.retentionSec = ret; meta.retentionSec = [src("messageRetentionDuration"), 1]; }
      else if (t.messageRetentionDuration) meta.retentionSec = [src("messageRetentionDuration"), 0.6, `보관 ${t.messageRetentionDuration} 을 못 담음 → 도착 상품 기본값`];
      const sub = t.subscription;
      if (sub) {
        if (typeof sub.ackDeadlineSeconds === "number") { props.ackTimeoutSec = sub.ackDeadlineSeconds; meta.ackTimeoutSec = [src("subscription.ackDeadlineSeconds"), 1]; }
        if (typeof sub.enableMessageOrdering === "boolean") {
          props.ordered = sub.enableMessageOrdering;
          meta.ordered = sub.enableMessageOrdering ? [src("subscription.enableMessageOrdering"), 0.9, "Pub/Sub 순서 = 순서 키. SQS FIFO 의 중복 제거와 뜻이 다름"] : [src("subscription.enableMessageOrdering"), 1];
        }
      } else meta.ackTimeoutSec = [src("subscription"), 0.6, "구독을 못 읽어 ack 시간·순서·DLQ 를 모름"];
      setDlq(sub?.deadLetterPolicy, "subscription");
    }
    // G3b-4 (통합): 토픽 전체 이름(projects/p/topics/x)도 근거로. 구독 이름은 위(SUB-1)에서 이미 넣음
    if (typeof t.name === "string" && t.name !== name && !aliases.includes(t.name)) aliases.push(t.name);
    return { name, kind: "queue", native: { type: DATA_RAW_KINDS.pubsub, name, endpoint: name, ...(aliases.length ? { aliases } : {}), uid: t.name }, props, meta, ...(deadLetterRef ? { deadLetterRef } : {}) };
  },
};
