// 출발 DB 원본 한 줄 → 보안 판정용 출발 사실 (SourceDbFacts). 순수 함수: 네트워크 없음.
// 판정은 packages/security 가 한다. adapters 는 security 를 모르므로 여기서는 원본 칸을 사실 칸으로 옮기기만 한다
// 못 읽은 칸은 지어내지 않고 unknown 으로 둔다. 모름은 판정이 경고·선언 요청으로 바꾼다
import type { SourceDbFacts } from "@svc/contracts";
import { DB_RAW_KINDS } from "./raw-k8s.js";
import type { RawItem } from "./types.js";

type Fact<T> = { value: T | null; origin: "measured" | "attested" | "unknown"; source: string | null };
const unknown = (): Fact<never> => ({ value: null, origin: "unknown", source: null });
const measured = <T>(value: T, source: string): Fact<T> => ({ value, origin: "measured", source });

// Cloud SQL 이 비암호화 접속을 거부하는 sslMode (ALLOW_UNENCRYPTED_AND_ENCRYPTED 만 받는다)
const CLOUDSQL_TLS_ONLY = new Set(["ENCRYPTED_ONLY", "TRUSTED_CLIENT_CERTIFICATE_REQUIRED"]);

/** postgres 원본(RDS·Cloud SQL)이 아니면 null. CNPG 등 나머지는 읽을 칸이 없어 사실 없음(= 판정에서 모름) */
export function sourceDbFactsOf(item: RawItem): SourceDbFacts | null {
  if (item.kind === DB_RAW_KINDS.rds) {
    const id = String(item.DBInstanceIdentifier ?? "");
    const enc = item.StorageEncrypted;
    return {
      encryptedAtRest: typeof enc === "boolean" ? measured(enc, `rds:${id}.StorageEncrypted`) : unknown(),
      // 암호화된 RDS 는 AWS 관리 키여도 KmsKeyId 가 있다. 고객 키인지는 kms describe-key 의 KeyManager 를 봐야 안다 (아직 안 부름)
      keyOwner: unknown(),
      // TLS 강제는 파라미터 그룹의 rds.force_ssl 이다. 파라미터 그룹은 아직 안 읽는다
      tlsEnforced: unknown(),
    };
  }
  if (item.kind === DB_RAW_KINDS.cloudsql) {
    const name = String(item.name ?? "");
    const ip = ((item.settings as Record<string, unknown> | undefined)?.ipConfiguration ?? null) as Record<string, unknown> | null;
    const src = `cloudsql:${name}.settings.ipConfiguration`;
    const tls = typeof ip?.sslMode === "string" ? measured(CLOUDSQL_TLS_ONLY.has(ip.sslMode), `${src}.sslMode`)
      : typeof ip?.requireSsl === "boolean" ? measured(ip.requireSsl, `${src}.requireSsl`)
      : unknown();
    return {
      // Cloud SQL 은 저장 데이터를 늘 암호화한다 (끌 수 있는 칸이 없다). 읽은 값이 아니라 제공자 문서 근거라 attested
      encryptedAtRest: { value: true, origin: "attested", source: "GCP Cloud SQL 기본 저장 암호화 (제공자 문서)" },
      // 고객 키(CMEK)는 diskEncryptionConfiguration 이다. 아직 안 읽는다
      keyOwner: unknown(),
      tlsEnforced: tls,
    };
  }
  return null;
}
