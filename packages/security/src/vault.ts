// 임시 자격 증명 보관함 (워커 프로세스 메모리 안).
// 원칙: 자격 증명 값은 DB·로그·감사·큐에 절대 안 나간다. 밖으로 나가는 것은 credentialRef(이름)뿐이다.
// DRAFT(ai): 프로세스 메모리에만 둔다. 워커가 죽으면 다시 발급받는다 (최대 1시간짜리라 다시 받는 비용이 작다)
//   대안: Secrets Manager 에 잠깐 저장 → 버린 이유: 비밀이 저장소에 남고, 지우는 절차가 하나 더 생긴다

export type SecretMaterial =
  | { kind: "aws"; accessKeyId: string; secretAccessKey: string; sessionToken: string }
  | { kind: "bearer"; token: string };

export interface VaultEntry {
  ref: string;
  tenantId: string;
  migrationId: string | null;
  provider: string;
  expiresAt: number;
  material: SecretMaterial;
}

// 값을 실수로 JSON·로그로 찍어도 안 새게 감싼다
class Sealed {
  #m: SecretMaterial;
  constructor(m: SecretMaterial) { this.#m = m; }
  open(): SecretMaterial { return this.#m; }
  toJSON() { return "[redacted]"; }
  toString() { return "[redacted]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "[redacted]"; }
}

export class VaultMiss extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";
  readonly status = 404;
}

export class CredentialVault {
  #items = new Map<string, Omit<VaultEntry, "material"> & { sealed: Sealed }>();

  put(e: VaultEntry): void {
    const { material, ...rest } = e;
    this.#items.set(e.ref, { ...rest, sealed: new Sealed(material) });
  }

  // 쓰는 쪽(어댑터 호출 직전)만 값을 꺼낸다. 만료됐으면 지우고 실패
  // 실행 역할(이전 번호에 묶인 것)은 같은 이전에서만 꺼낼 수 있다 (위협 모델 T-ROLE-7).
  // 관찰 역할(이전 번호 없음)은 같은 회사면 꺼낼 수 있다
  use(ref: string, tenantId: string, now: Date, migrationId?: string): SecretMaterial {
    const it = this.#items.get(ref);
    // 다른 회사·다른 이전의 참조는 "없음"으로 보인다 (CLAUDE.md 5-6: 남의 자원은 404)
    if (!it || it.tenantId !== tenantId) throw new VaultMiss(`자격 증명 없음: ${ref}`);
    if (it.migrationId !== null && it.migrationId !== migrationId) throw new VaultMiss(`자격 증명 없음: ${ref}`);
    // Z47: 여기서 지우지 않는다. 지우면 중개자 sweep() 이 만료를 못 봐서 temp_role.expired 감사가 빠진다 (값은 어차피 안 돌려준다)
    if (it.expiresAt <= now.getTime()) throw new VaultMiss(`자격 증명 만료: ${ref}`);
    return it.sealed.open();
  }

  drop(ref: string): boolean { return this.#items.delete(ref); }

  refsFor(filter: { tenantId?: string; migrationId?: string }): string[] {
    return [...this.#items.values()]
      .filter((i) => (!filter.tenantId || i.tenantId === filter.tenantId) && (!filter.migrationId || i.migrationId === filter.migrationId))
      .map((i) => i.ref);
  }

  // 만료된 것 지우기. 지운 참조 목록을 돌려준다 (감사용)
  sweep(now: Date): string[] {
    const gone: string[] = [];
    for (const [ref, it] of this.#items) if (it.expiresAt <= now.getTime()) { this.#items.delete(ref); gone.push(ref); }
    return gone;
  }

  get size() { return this.#items.size; }
}
