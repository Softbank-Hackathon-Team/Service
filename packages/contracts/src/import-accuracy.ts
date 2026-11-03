import { z } from "zod";

// DRAFT(ai): 가져오기 정확도 (ALIGN-v2 IR-10). 읽어 온 원본 값과 "도착에 내보낼 값"을 칸마다 맞춰 본 결과.
//   비교 불가 칸은 분모에서 뺀다 (percent = 일치 ÷ (일치+불일치) × 100, 비교 가능한 칸이 0 이면 null).
//   환경변수는 이름만 비교하고 값은 어디에도 담지 않는다 (비밀값 노출 방지).
export const AccuracyResult = z.enum(["match", "mismatch", "unverifiable"]);
export type AccuracyResult = z.infer<typeof AccuracyResult>;

export const AccuracyField = z.object({
  /** 공통 명세 부품 id (서비스·잡·DB) */
  component: z.string().min(1).max(200),
  /** image.digest | ports | env.names | replicas | resources.cpu | resources.memory | probes.readiness … | command | schedule | db.version | db.storageGb */
  field: z.string().min(1).max(60),
  result: AccuracyResult,
  /** 사람이 읽는 짧은 이유. 값 자체(특히 환경변수 값)는 넣지 않는다. 이름·숫자만 */
  detail: z.string().max(300).optional(),
}).strict();
export type AccuracyField = z.infer<typeof AccuracyField>;

export const ImportAccuracy = z.object({
  schemaVersion: z.literal("1"),
  /** render = 도착 렌더 결과(Helm 값)와 비교 · spec = 렌더를 못 해서 공통 명세 값과 비교 */
  basis: z.enum(["render", "spec"]),
  total: z.number().int().min(0),
  matched: z.number().int().min(0),
  mismatched: z.number().int().min(0),
  unverifiable: z.number().int().min(0),
  /** 비교 가능한 칸 수 = matched + mismatched */
  comparable: z.number().int().min(0),
  /** 0~100, 소수 첫째 자리. comparable 이 0 이면 null (0% 로 속이지 않는다) */
  percent: z.number().min(0).max(100).nullable(),
  fields: z.array(AccuracyField).max(2000),
}).strict();
export type ImportAccuracy = z.infer<typeof ImportAccuracy>;
