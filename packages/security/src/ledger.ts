// 임시 자격 증명 장부 (위협 모델 T-ROLE-8).
// 값은 발급한 워커의 메모리 보관함에만 있다. 장부에는 참조·만료·상태·주인(워커)만 적는다.
// 워커가 여러 대여도 "이 이전의 실행 역할이 전부 회수됐나"(T27 증거)를 장부로 센다.
// 진짜 장부는 DB 표 temp_credentials (워커의 pgLedger). 여기 있는 memoryLedger 는 시험용

// expired = 만료 시각이 지나 청소가 닫은 줄 (0013). 회수(revoked)와 따로 센다: "끝나기 전에 돌려받았나" vs "시간이 지나 저절로 죽었나"
export type LedgerStatus = "active" | "revoke_requested" | "revoked" | "expired";
export interface LedgerEntry {
  ref: string; tenantId: string; migrationId: string | null; envId: string;
  provider: string; purpose: "observe" | "operate"; stage: string | null; roleRef: string;
  owner: string; issuedAt: Date; expiresAt: Date;
  // 0013: 어느 작업 단계가 빌렸나, 동작 수, 요청한 수명(초), Mock 발급기인가. 없으면 비워 둔다
  step?: string | null; actionsCount?: number | null; requestedTtlSec?: number | null; stub?: boolean | null;
  // 0015 (Z61): 재발급이면 바로 앞 자격 참조와 몇 번째 재발급인가 (첫 발급 = null, 0)
  renewedFrom?: string | null; renewSeq?: number;
}

export interface ExpiredRef { ref: string; migrationId: string | null; envId: string }

export interface CredentialLedger {
  // durable = 여러 워커가 같이 보는 저장소인가. false 면 회수 증거를 참으로 내지 않는다
  readonly durable: boolean;
  record(e: LedgerEntry): Promise<void>;
  // 주인이 실제로 지웠을 때
  markRevoked(tenantId: string, ref: string, reason: string, now: Date): Promise<void>;
  // 다른 워커가 쥔 것: 회수를 "요청"만 한다. 주인이 다음 청소 때 지우고 revoked 로 바꾼다
  requestRevoke(tenantId: string, migrationId: string, reason: string, exceptOwner: string): Promise<number>;
  // 주인이 쥔 참조 중 회수 요청이 온 것
  revokeRequested(tenantId: string, refs: string[]): Promise<Array<{ ref: string; reason: string }>>;
  // 아직 살아 있는 실행 역할 수 (revoked 아님 + 만료 전)
  activeOperate(tenantId: string, migrationId: string, now: Date): Promise<number>;
  // 0013: 만료 시각이 지났는데 아직 active·revoke_requested 로 적힌 줄을 expired 로 닫는다. 닫은 참조를 돌려준다
  // 값은 이미 클라우드 쪽에서 죽었다(STS·토큰 만료). 장부를 사실에 맞추는 일이다. 워커가 죽어 주인이 없는 줄도 여기서 닫힌다
  expireDue(tenantId: string, now: Date): Promise<ExpiredRef[]>;
}

// 시험용. 같은 객체를 두 중개자에 넘기면 "워커 두 대가 같은 DB 를 본다"를 흉내 낸다
export function memoryLedger(o: { durable?: boolean } = {}): CredentialLedger & { rows: Map<string, LedgerEntry & { status: LedgerStatus; reason: string | null }> } {
  const rows = new Map<string, LedgerEntry & { status: LedgerStatus; reason: string | null }>();
  return {
    // DRAFT(ai): 기본 false. 프로세스 하나 안의 메모리는 다른 워커의 발급을 모르니 "전부 회수"를 장담 못 한다
    durable: o.durable ?? false,
    rows,
    async record(e) { rows.set(e.ref, { ...e, status: "active", reason: null }); },
    async markRevoked(tenantId, ref, reason) {
      const r = rows.get(ref);
      if (r && r.tenantId === tenantId && r.status !== "revoked" && r.status !== "expired") { r.status = "revoked"; r.reason = reason; }
    },
    async requestRevoke(tenantId, migrationId, reason, exceptOwner) {
      let n = 0;
      for (const r of rows.values())
        if (r.tenantId === tenantId && r.migrationId === migrationId && r.owner !== exceptOwner && r.status === "active") {
          r.status = "revoke_requested"; r.reason = reason; n++;
        }
      return n;
    },
    async revokeRequested(tenantId, refs) {
      return refs.map((ref) => rows.get(ref)).filter((r) => r && r.tenantId === tenantId && r.status === "revoke_requested")
        .map((r) => ({ ref: r!.ref, reason: r!.reason ?? "requested" }));
    },
    async activeOperate(tenantId, migrationId, now) {
      return [...rows.values()].filter((r) => r.tenantId === tenantId && r.migrationId === migrationId && r.purpose === "operate"
        && r.status !== "revoked" && r.status !== "expired" && r.expiresAt.getTime() > now.getTime()).length;
    },
    async expireDue(tenantId, now) {
      const out: ExpiredRef[] = [];
      for (const r of rows.values())
        if (r.tenantId === tenantId && (r.status === "active" || r.status === "revoke_requested") && r.expiresAt.getTime() <= now.getTime()) {
          r.status = "expired"; out.push({ ref: r.ref, migrationId: r.migrationId, envId: r.envId });
        }
      return out;
    },
  };
}
