import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { QueueName } from "@svc/contracts";
import { NotFound, type AuditInput } from "@svc/core";

// 경로 파일들이 똑같이 되풀이하던 조각 (Z44). 동작은 예전 각 경로와 같다.
// 회사 번호(req.tenantId)·행위자(req.actor)는 plugins/auth.ts 가, Idempotency-Key 는 plugins/idempotency.ts 의
// req.idempotent() 가, 오류 응답 모양은 plugins/errors.ts 가 맡는다. 여기는 처리기 안쪽에서 쓰는 작은 도우미만 둔다

// :id 경로 인자. 이름 없는 스키마라 OpenAPI 에는 예전처럼 그 자리에 풀어 쓰인다 (NAMED_RESPONSES 에 넣지 말 것)
export const IdParam = z.object({ id: z.uuid() });

// DB 시각 → ISO 8601 UTC 밀리초 글자 (pg Date 를 JSON.stringify 한 것과 같은 모양, Z17 의 5,013/5,013 비교)
// 응답 스키마가 시각을 string 으로 받으므로 목록·상세 SELECT 는 이 식으로 문자열을 만든다
export const isoUtc = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// 찾았으면 그대로, 없으면 404 (RLS 때문에 남의 회사 것도 "없음"으로 보인다)
export function found<T>(v: T | null | undefined, what: string, id: string): T {
  if (v === null || v === undefined) throw new NotFound(what, id);
  return v;
}

// 사람이 누른 상태 변경의 감사 줄. 결과는 늘 ok (실패는 예외 → 트랜잭션째 없던 일)
export function auditOk(req: FastifyRequest, action: string, target: string, detail?: Record<string, unknown>): AuditInput {
  return { actor: req.actor, action, target, result: "ok", ...(detail ? { detail } : {}) };
}

// advance() 의 next: 이전 한 건에 대한 다음 작업. 기본 singletonKey = "<큐>:<이전 번호>" (같은 작업 두 번 막기)
export function nextJob(req: FastifyRequest, queue: QueueName, migrationId: string,
  o: { extra?: Record<string, unknown>; singletonKey?: string } = {}) {
  return { queue,
           data: { tenantId: req.tenantId, requestId: req.id, migrationId, ...o.extra },
           opts: { singletonKey: o.singletonKey ?? `${queue}:${migrationId}` } };
}
