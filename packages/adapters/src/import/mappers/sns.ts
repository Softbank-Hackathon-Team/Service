import { DATA_RAW_KINDS, type RawSnsTopic } from "../raw-data.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// B-2 DRAFT(ai): AWS SNS 토픽 → queue(model=topic) (Pub/Sub 토픽과 같은 자리). id = 토픽 이름. .fifo = ordered
//   구독: sqs 는 IR 큐로 잇고(파이프라인이 큐 ARN 으로 id 를 채움), 나머지(http·lambda·email…)는 종류만 (대상 주소·함수 ARN 은 안 담음)
//   앱 env 의 토픽 ARN·이름도 의존성 근거 (ARN = 근거만 + 검토, 이름 = name 출력)
const PROTOCOLS = new Set(["sqs", "http", "https", "lambda", "email", "email-json", "sms", "application", "firehose"]);

export const snsMapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.sns],
  kind: "queue",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const t = item as unknown as RawSnsTopic;
    if (!t.TopicArn) return { skip: "TopicArn 없음 (깨진 원본)", grade: "C" };
    const name = t.TopicArn.split(":").pop() ?? "";
    if (!name) return { skip: "토픽 이름을 ARN 에서 못 뽑음", grade: "C" };
    const src = (k: string) => `sns:${name}.${k}`;
    const props: Record<string, unknown> = { model: "topic" };
    const meta: Record<string, MetaTuple> = { model: [`sns:${name}`, 1] };
    if (name.endsWith(".fifo")) { props.ordered = true; meta.ordered = [src("FifoTopic"), 1]; }
    const refs: NonNullable<MappedComponent["notifyRefs"]> = [];
    if (t.Subscriptions === null) meta.topicSubscriptions = [src("Subscriptions"), 0.6, "구독을 못 읽음 (관찰 권한 sns:ListSubscriptionsByTopic 확인) → 토픽 → 큐 연결이 빠졌을 수 있음"];
    else if (t.Subscriptions?.length) {
      const subs: Array<{ protocol: string; to?: string }> = [];
      let odd = 0;
      for (const s of t.Subscriptions) {
        const protocol = String(s.Protocol ?? "").toLowerCase();
        if (!PROTOCOLS.has(protocol)) { odd++; continue; }
        if (protocol === "sqs" && s.Endpoint) refs.push({ field: "topicSubscriptions", index: subs.length, uid: s.Endpoint });
        subs.push({ protocol });
      }
      props.topicSubscriptions = subs;
      const outside = subs.filter((x) => x.protocol !== "sqs").length;
      meta.topicSubscriptions = outside || odd
        ? [src("Subscriptions"), 0.6, `구독 ${t.Subscriptions.length}개 중 ${outside + odd}개는 IR 밖 대상(http·함수·메일 등) → 도착에서 사람이 정함`]
        : [src("Subscriptions"), 1];
    }
    const arnKey = t.TopicArn.toLowerCase();
    return { name, kind: "queue",
      native: { type: DATA_RAW_KINDS.sns, name, endpoint: t.TopicArn, aliases: [name], aliasOutputs: { [arnKey]: null, [name.toLowerCase()]: "name" }, uid: t.TopicArn },
      props, meta, ...(refs.length ? { notifyRefs: refs } : {}) };
  },
};
