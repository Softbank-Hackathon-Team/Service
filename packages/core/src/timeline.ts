import type { Tx } from "./db.js";

// 이전 하나의 타임라인: 감사 기록(audit_events)을 시간순으로 펼쳐 "언제 어느 상태로 갔고, 그 전 상태에 얼마나 있었나"를 만든다
// 웹 화면(상세 화면 타임라인)과 증적 리포트(Q)가 같은 함수를 쓴다. DB 없이 줄만 넣어도 되게 순수 함수로 둔다
// 필드 이름은 Q 리포트와 맞춘 것 (10/31): seq, at, from, to, actor, action, durationMs, totalMs
//  - durationMs = from 상태에 머문 ms (앞 전이 시각 ~ 이 전이 시각). 첫 전이는 null
//  - totalMs = 첫 전이 ~ 마지막 전이. 아직 안 끝났으면 첫 전이 ~ 지금 (running=true)
//  - 시간은 ISO UTC 문자열, 길이는 ms 정수
// DRAFT(ai): contracts 로 옮길 모양. 통합 때 packages/contracts 에 zod 로 정의하고 이 타입을 바꾼다

export interface AuditRow {
  seq: number | string;     // bigserial 은 pg 가 문자열로 준다
  at: Date | string;
  actor: string;
  action: string;
  result: string;
  detail: Record<string, unknown> | null;
}

export interface TimelineMeasurement { name: string; value: number; unit: string; [k: string]: unknown }

export interface TimelineItem {
  seq: number;
  at: string;
  kind: "transition" | "event";
  actor: string;
  action: string;
  result: string;
  from: string | null;
  to: string | null;
  durationMs: number | null;
  failureCode: string | null;
  requestId: string | null;
  measurements: TimelineMeasurement[];
  detail: Record<string, unknown>;
}

export interface StateDuration { state: string; ms: number; entries: number }

export interface Timeline {
  migrationId: string;
  status: string;
  createdAt: string;
  generatedAt: string;
  running: boolean;
  totalMs: number | null;
  items: TimelineItem[];
  stateDurations: StateDuration[];
}

const FINISHED = new Set(["completed", "rolled_back", "cancelled", "rejected", "stale"]);
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const ms = (a: string, b: string) => Math.round(Date.parse(b) - Date.parse(a));

// detail 에서 화면에 다시 보일 필요 없는 칸(이미 위로 뺀 것)을 덜어 낸다
const LIFTED = new Set(["from", "to", "failureCode", "requestId", "measurements"]);

export function buildTimeline(
  rows: AuditRow[],
  m: { id: string; status: string; createdAt: Date | string },
  now: Date = new Date(),
): Timeline {
  const sorted = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq));
  const items: TimelineItem[] = [];
  const stay = new Map<string, StateDuration>();
  let lastTransitionAt: string | null = null;
  let firstTransitionAt: string | null = null;

  for (const r of sorted) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const at = iso(r.at);
    const isTransition = typeof d.from === "string" && typeof d.to === "string";
    let durationMs: number | null = null;
    if (isTransition) {
      if (lastTransitionAt) {
        durationMs = ms(lastTransitionAt, at);
        const s = stay.get(d.from as string) ?? { state: d.from as string, ms: 0, entries: 0 };
        s.ms += durationMs; s.entries++;
        stay.set(s.state, s);
      }
      firstTransitionAt ??= at;
      lastTransitionAt = at;
    }
    const meas = Array.isArray(d.measurements)
      ? (d.measurements as unknown[]).filter((x): x is TimelineMeasurement =>
          !!x && typeof x === "object" && typeof (x as TimelineMeasurement).name === "string"
          && typeof (x as TimelineMeasurement).value === "number")
      : [];
    items.push({
      seq: Number(r.seq), at, kind: isTransition ? "transition" : "event",
      actor: r.actor, action: r.action, result: r.result,
      from: isTransition ? (d.from as string) : null,
      to: isTransition ? (d.to as string) : null,
      durationMs,
      failureCode: typeof d.failureCode === "string" ? d.failureCode : null,
      requestId: typeof d.requestId === "string" ? d.requestId : null,
      measurements: meas,
      detail: Object.fromEntries(Object.entries(d).filter(([k]) => !LIFTED.has(k))),
    });
  }

  const running = !FINISHED.has(m.status);
  const end = running ? now.toISOString() : lastTransitionAt;
  return {
    migrationId: m.id,
    status: m.status,
    createdAt: iso(m.createdAt),
    generatedAt: now.toISOString(),
    running,
    totalMs: firstTransitionAt && end ? ms(firstTransitionAt, end) : null,
    items,
    stateDurations: [...stay.values()],
  };
}

// 회사 벽 안(withTenant 의 tx)에서 부른다. 다른 회사 이전이면 null
export async function loadTimeline(tx: Tx, migrationId: string, limit = 1000): Promise<Timeline | null> {
  const m = await tx.query(
    `SELECT id, status, created_at AS "createdAt" FROM migrations WHERE id = $1`, [migrationId]);
  if (!m.rows[0]) return null;
  // DRAFT(ai): 한 이전의 감사 줄 1000개까지. 넘으면 앞부분만 (데모 한 바퀴는 20줄 안팎)
  const a = await tx.query(
    `SELECT seq, at, actor, action, result, detail FROM audit_events
      WHERE target = $1 ORDER BY seq LIMIT $2`, [migrationId, limit]);
  return buildTimeline(a.rows as AuditRow[], m.rows[0]);
}
