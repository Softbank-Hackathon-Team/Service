import { DATA_RAW_KINDS, type RawSqsQueue } from "../raw-data.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai): AWS SQS 큐 → queue (설계 20번 6.7장). id 는 큐 이름(URL 마지막 조각), native.endpoint = 큐 URL.
//   RedrivePolicy 의 DLQ 는 같은 계정의 다른 큐 ARN → 파이프라인이 id 가 정해진 뒤 deadLetter.to 를 채운다 (매퍼는 deadLetterRef 만)
//   FIFO 는 ordered=true + "중복 제거 없어짐" 경고 (도착이 SQS FIFO 가 아니면)
const num = (v: unknown): number | null => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : null; };
export const queueNameOf = (url: string) => url.replace(/\/+$/, "").split("/").pop() ?? "";

export const sqsMapper: KindMapper = {
  nativeTypes: [DATA_RAW_KINDS.sqs],
  kind: "queue",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const q = item as unknown as RawSqsQueue;
    if (!q.QueueUrl) return { skip: "QueueUrl 없음 (깨진 원본)", grade: "C" };
    const name = queueNameOf(q.QueueUrl);
    if (!name) return { skip: "큐 이름을 URL 에서 못 뽑음", grade: "C" };
    const a = q.Attributes ?? {};
    const fifo = a.FifoQueue === "true";
    const retention = num(a.MessageRetentionPeriod), vis = num(a.VisibilityTimeout);
    const props: Record<string, unknown> = { model: "queue" };
    const meta: Record<string, MetaTuple> = { model: [`sqs:${name}`, 1] };
    if (fifo) { props.ordered = true; meta.ordered = [`sqs:${name}.FifoQueue`, 0.9, "SQS FIFO = 순서 + 중복 제거. 도착이 다르면 중복 제거가 없어질 수 있음"]; }
    else if (a.FifoQueue !== undefined) props.ordered = false;
    if (retention !== null && retention >= 60 && retention <= 2678400) { props.retentionSec = Math.trunc(retention); meta.retentionSec = [`sqs:${name}.MessageRetentionPeriod`, 1]; }
    if (vis !== null && vis >= 0) { props.ackTimeoutSec = Math.trunc(vis); meta.ackTimeoutSec = [`sqs:${name}.VisibilityTimeout`, 1]; }
    // RedrivePolicy 는 JSON 문자열 (SQS 응답이 그렇다). 깨졌으면 DLQ 없음으로 두고 검토 표시
    let deadLetterRef: { arn: string; name: string } | undefined;
    let maxReceive: number | undefined;
    if (a.RedrivePolicy) {
      try {
        const rp = JSON.parse(a.RedrivePolicy) as { deadLetterTargetArn?: string; maxReceiveCount?: number | string };
        if (rp.deadLetterTargetArn) {
          deadLetterRef = { arn: rp.deadLetterTargetArn, name: rp.deadLetterTargetArn.split(":").pop() ?? "" };
          const m = num(rp.maxReceiveCount);
          if (m !== null) maxReceive = Math.trunc(m);
        }
      } catch { meta.deadLetter = [`sqs:${name}.RedrivePolicy`, 0.6, "RedrivePolicy 를 못 읽음 → DLQ 없음으로 둠. 사람이 확인"]; }
    }
    if (deadLetterRef) {
      props.deadLetter = { ...(maxReceive !== undefined ? { maxReceive } : {}) };
      meta.deadLetter = [`sqs:${name}.RedrivePolicy`, 1];
    }
    return { name, kind: "queue", native: { type: DATA_RAW_KINDS.sqs, name, endpoint: q.QueueUrl, uid: a.QueueArn ?? null }, props, meta,
      ...(deadLetterRef ? { deadLetterRef } : {}) };
  },
};
