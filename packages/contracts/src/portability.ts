import { z } from "zod";
import { Provider } from "./common.js";

// 이식성 판정 계약. 계획 단계에서 출발·도착 환경의 보안 사실과 앱 요구사항을 맞대어 막기·경고·추천을 낸다.
// Z95 보안 회귀(같은 열쇠의 pass/warn/fail 비교)와 다른 점: 여기는 판정 전의 "값"(국가·키 소유·확장 목록)을 본다.
// 판정 코드는 packages/security/src/portability (이 파일의 타입을 import type 으로만 쓴다)
// DRAFT(ai): 요구사항 4칸·사실 칸·판정 단계 4개는 보안 영역 설계 초안이다. AppSpec 에 requirements 로 붙일지는 팀 검토 후 정한다

// 앱이 어디서 돌든 지켜야 하는 조건. 사람이 명세 검토 때 확정한다
// TLS 강제·DB 비공개는 칸으로 두지 않는다. 고객이 끌 수 있는 선택이 아니라 플랫폼 기본값이다
export const DataClass = z.enum(["public", "internal", "personal", "sensitive"]);
export type DataClass = z.infer<typeof DataClass>;
export const Operator = z.enum(["customer", "aws", "gcp", "azure"]);
export type Operator = z.infer<typeof Operator>;

export const SecurityRequirements = z.object({
  dataClass: DataClass,
  residency: z.array(z.string().regex(/^[A-Z]{2}$/)),   // 허용 국가 (ISO 3166-1 alpha-2). 빈 배열 = 제한 없음
  keyOwnership: z.enum(["provider", "customer"]),
  operatorAllow: z.array(Operator).optional(),          // 없으면 제한 없음
}).strict();
export type SecurityRequirements = z.infer<typeof SecurityRequirements>;

// IR v2 의 security 칸 (spec-v2.ts). 객체로 감싸 둬서 나중에 칸을 더해도 IR 모양이 안 깨진다
// 가져오기는 이 칸을 비워 둔다. 고객이 명세 검토에서 넣는다
export const SecuritySpecV2 = z.object({
  requirements: SecurityRequirements,
}).strict();
export type SecuritySpecV2 = z.infer<typeof SecuritySpecV2>;

// 사실 한 칸. measured = API·SQL 로 읽음 / attested = 고객 선언 / unknown = 모름 (value 는 null)
// 모름은 통과가 아니다. 판정 규칙은 unknown 을 경고(온프레는 선언 요청)로 바꾼다
export const FactOrigin = z.enum(["measured", "attested", "unknown"]);
export type FactOrigin = z.infer<typeof FactOrigin>;
const fact = <T extends z.ZodType>(v: T) => z.object({
  value: v.nullable(),
  origin: FactOrigin,
  source: z.string().nullable(),   // 무엇을 읽었나 (예: "aws kms describe-key"). 선언이면 선언한 사람·시각
}).strict();

export const KeyOwner = z.enum(["provider", "customer"]);
export type KeyOwner = z.infer<typeof KeyOwner>;

// 환경 하나의 보안 사실. precheck 가 observe 역할로 채운다 (질의표 Q-01~Q-16)
export const EnvFacts = z.object({
  provider: Provider,
  envId: z.string(),
  country: fact(z.string().regex(/^[A-Z]{2}$/)),       // Q-01 데이터가 놓인 국가
  db: z.object({
    publicAccess: fact(z.boolean()),                    // Q-06 인터넷에서 DB 포트에 닿나
    encryptedAtRest: fact(z.boolean()),                 // Q-03
    keyOwner: fact(KeyOwner),                           // Q-04
    tlsEnforced: fact(z.boolean()),                     // Q-05 비TLS 접속을 거부하나
    authMethods: fact(z.array(z.string())),             // Q-07 pg_hba 방식 목록 (scram-sha-256, md5, trust …)
    majorVersion: fact(z.number().int()),               // Q-08
    extensions: fact(z.array(z.string())),              // Q-09 설치된 확장
    extensionAllowlist: fact(z.array(z.string())),      // Q-09 이 환경이 허용하는 확장. ["*"] = 제한 없음 (온프레)
    encoding: fact(z.string()),                         // Q-10
    collation: fact(z.string()),                        // Q-10 datcollate
    appRoleSuperuser: fact(z.boolean()),                // Q-11
    pitr: fact(z.boolean()),                            // Q-13
  }).strict(),
  platform: z.object({
    auditLog: fact(z.boolean()),                        // Q-14 제어면 감사 로그
    secretsEncrypted: fact(z.boolean()),                // Q-15 비밀 저장소 암호화 (k3s secrets-encryption 등)
    workloadIdentity: fact(z.boolean()),                // Q-16 앱이 클라우드 역할을 빌려 쓰나
  }).strict(),
}).strict();
export type EnvFacts = z.infer<typeof EnvFacts>;

// 가져오기가 출발 원본(describe)에서 읽을 수 있는 DB 칸만. ImportResultV2.securityFacts 에 componentId 별로 담는다
// 명세(spec) 밖에 두는 이유: security 칸은 사람이 PATCH 로 통째 바꾼다. 측정한 출발 사실은 사람이 고칠 수 없는 자리에 둔다
export const SourceDbFacts = EnvFacts.shape.db.pick({ encryptedAtRest: true, keyOwner: true, tlsEnforced: true }).strict();
export type SourceDbFacts = z.infer<typeof SourceDbFacts>;

// 리전 → 데이터가 놓이는 국가 (ISO 3166-1 alpha-2). 출발과 도착이 같이 쓴다
// 표에 없으면 null = 모름. 온프레·azure_mock 은 리전 이름으로 국가를 알 수 없어 늘 null 이다 (고객 선언 필요)
const REGION_COUNTRY: Partial<Record<Provider, Record<string, string>>> = {
  aws: {
    "us-east-1": "US", "us-east-2": "US", "us-west-1": "US", "us-west-2": "US", "ca-central-1": "CA", "sa-east-1": "BR",
    "eu-west-1": "IE", "eu-west-2": "GB", "eu-west-3": "FR", "eu-central-1": "DE", "eu-north-1": "SE", "eu-south-1": "IT",
    "ap-northeast-1": "JP", "ap-northeast-2": "KR", "ap-northeast-3": "JP", "ap-southeast-1": "SG", "ap-southeast-2": "AU",
    "ap-south-1": "IN", "ap-east-1": "HK",
  },
  gcp: {
    "us-central1": "US", "us-east1": "US", "us-east4": "US", "us-west1": "US", "us-west2": "US", "us-west3": "US", "us-west4": "US",
    "northamerica-northeast1": "CA", "southamerica-east1": "BR",
    "europe-west1": "BE", "europe-west2": "GB", "europe-west3": "DE", "europe-west4": "NL", "europe-north1": "FI",
    "asia-northeast1": "JP", "asia-northeast2": "JP", "asia-northeast3": "KR", "asia-southeast1": "SG", "asia-east1": "TW",
    "asia-east2": "HK", "asia-south1": "IN", "australia-southeast1": "AU",
  },
};
export function regionCountry(provider: Provider, region: string | null | undefined): string | null {
  if (!region) return null;
  return REGION_COUNTRY[provider]?.[region] ?? null;
}

// block = 승인 불가 / warn = 승인자가 위험 수용을 체크해야 승인 / attest = 고객 선언이 있어야 끝남 / advise = 추천만
export const PortabilityLevel = z.enum(["block", "warn", "attest", "advise"]);
export type PortabilityLevel = z.infer<typeof PortabilityLevel>;

export const PortabilityVerdict = z.object({
  ruleId: z.string(),                                   // 예: P-KEY-1 (설계 문서의 규칙표 번호)
  level: PortabilityLevel,
  side: z.enum(["source", "target", "both", "app"]),
  title: z.string(),
  reason: z.string(),
  recommend: z.string(),
  evidence: z.string(),                                 // 판정에 쓴 사실과 출처. 비밀값 없음
  basis: z.enum(["known", "unknown"]).optional(),       // unknown = 사실을 몰라서 낸 판정. 승인 항목에서 쪽마다 하나로 묶는다
}).strict();
export type PortabilityVerdict = z.infer<typeof PortabilityVerdict>;

// blocked = 막기 1개 이상 / needs_ack = 경고·선언 요청 1개 이상 / clear = 추천만 있거나 없음
export const PortabilityResult = z.object({
  verdict: z.enum(["blocked", "needs_ack", "clear"]),
  summary: z.object({ block: z.number().int(), warn: z.number().int(), attest: z.number().int(), advise: z.number().int() }).strict(),
  items: z.array(PortabilityVerdict),
}).strict();
export type PortabilityResult = z.infer<typeof PortabilityResult>;
