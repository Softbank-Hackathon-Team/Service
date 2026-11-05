import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Provider } from "@svc/contracts";
import { checkLeastPrivilege, TempCredential, TempRoleDenied, TempRoleRequest } from "./temp-role.js";
import { AWS_SESSION_POLICY_MAX, checkSessionPolicy, checkWithinCeiling, compactSessionPolicy, type PermissionSet } from "./permissions.js";
import type { ProviderIssuer } from "./issuers.js";
import { CredentialVault, type SecretMaterial } from "./vault.js";
import { memoryLedger, type CredentialLedger } from "./ledger.js";

// 임시 역할 중개자: 검사 → 발급 → 보관함·장부 → 감사 → 참조만 돌려주기. 회수·만료 청소도 여기서 한다.
// 워커가 부르는 유일한 입구다. 어댑터는 credentialRef 로 use() 해서 값을 받는다.

// core 의 AuditInput 과 같은 모양 (core 를 import 하지 않으려고 따로 적었다. 워커가 writeAudit 로 넘긴다)
export interface AuditRecord {
  actor: string; action: string; target: string;
  result: "ok" | "denied" | "error";
  detail?: Record<string, unknown>;
}
export type AuditSink = (tenantId: string, a: AuditRecord) => Promise<void>;

// 환경 → 고객 역할 연결 정보 (environments 표에 적힌 값). 비밀이 아니다
export interface EnvBinding { roleRef: string; externalId?: string }
export type ResolveEnv = (tenantId: string, envId: string, purpose: "observe" | "operate") => Promise<EnvBinding>;

// DRAFT(ai): 실행 역할 세션은 15분까지 (STS 최소값). 강제 회수 수단이 없으니 길이로 피해 범위를 줄인다 (위협 모델 T-ROLE-9)
// 15분 넘는 단계(RDS 생성 apply 등)는 상한을 늘리지 않고 중간에 다시 빌린다: renew() + 워커 jobs/_roles.ts 의 10분 주기 (작업 Z61, Jeong 17:03Z 승인값)
export const OPERATE_MAX_TTL_SEC = 900;

// 재발급 실패. 이전 자격은 만료까지 살아 있지만 단계는 더 못 간다 → 워커가 단계를 paused 로 멈춘다 (Z61)
export class CredRenewFailed extends Error {
  readonly code = "CRED_RENEW_FAILED";
  constructor(readonly credentialRef: string, readonly reason: string, message: string) { super(message); }
}

export interface BrokerDeps {
  issuers: Partial<Record<Provider, ProviderIssuer>>;
  resolveEnv: ResolveEnv;
  audit: AuditSink;
  // 최소 권한 파일. 없으면 실행 역할은 발급하지 않는다 (위협 모델 T-ROLE-6). 관찰 역할은 읽기 검사만으로 발급
  permissions?: PermissionSet;
  ledger?: CredentialLedger;       // 없으면 시험용 메모리 장부(durable=false) → 회수 증거가 참이 안 된다
  vault?: CredentialVault;
  owner?: string;                  // 이 워커 이름. 장부의 주인 칸
  now?: () => Date;
  // 시험·데모용: true 면 Mock 발급기 재발급을 실패시킨다 (워커는 CRED_RENEW_STUB_FAIL=1). 진짜 발급기에는 안 먹는다
  renewFault?: () => boolean;
}

// req·step 은 재발급(renew) 때 같은 요청을 다시 내려고 들고 있는다. seq = 몇 번째 재발급인가 (첫 발급 0)
interface Issued { cred: TempCredential; tenantId: string; migrationId: string | null; envId: string;
  req: TempRoleRequest; step: string | null; seq: number }

export function createTempRoleBroker(d: BrokerDeps) {
  const vault = d.vault ?? new CredentialVault();
  const ledger = d.ledger ?? memoryLedger();
  const owner = d.owner ?? `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const now = d.now ?? (() => new Date());
  const issued = new Map<string, Issued>();
  let seq = 0;

  async function deny(req: Partial<TempRoleRequest>, e: TempRoleDenied): Promise<never> {
    if (req.tenantId) await d.audit(req.tenantId, {
      actor: "worker", action: "temp_role.denied", target: req.migrationId ?? req.envId ?? "-", result: "denied",
      detail: { code: e.code, message: e.message, provider: req.provider, purpose: req.purpose, stage: req.stage, actions: req.actions,
        ...(req.policy ? { policy: req.policy } : {}) },
    });
    throw e;
  }

  // 주인만 실제로 지운다: 보관함 삭제 + 발급기 회수 + 장부 revoked + 감사
  async function revokeOwned(ref: string, tenantId: string, reason: string, hard: boolean) {
    const it = issued.get(ref);
    if (!it || it.tenantId !== tenantId) return { revoked: false, hardRevoked: false };
    let material: SecretMaterial | null = null;
    try { material = vault.use(ref, tenantId, now(), it.migrationId ?? undefined); } catch { material = null; }
    const issuer = d.issuers[it.cred.provider as Provider];
    let r = { hardRevoked: false, detail: {} as Record<string, unknown> };
    try {
      if (issuer) r = await issuer.revoke({ roleRef: it.cred.roleRef, issuedAt: new Date(it.cred.issuedAt), now: now(), material, hard });
    } catch (e) {
      // M5: 발급기 회수가 실패하면 보관함·메모리 장부·DB 장부를 그대로 둔다 → revokeForMigration·sweep 이 다시 시도하고,
      // T27 증거(장부의 살아 있는 실행 역할 수)가 거짓 true 가 되지 않는다. 예전엔 finally 에서 먼저 지우고 감사 없이 던졌다
      await d.audit(tenantId, { actor: "worker", action: "temp_role.revoke_failed", target: it.migrationId ?? it.envId, result: "error",
        detail: { credentialRef: ref, reason, hard, error: (e as Error)?.message?.slice(0, 200) ?? String(e) } });
      throw e;
    }
    vault.drop(ref);
    issued.delete(ref);
    await ledger.markRevoked(tenantId, ref, reason, now());
    await d.audit(tenantId, { actor: "worker", action: "temp_role.revoked", target: it.migrationId ?? it.envId, result: "ok",
      detail: { credentialRef: ref, reason, hard, hardRevoked: r.hardRevoked, ...r.detail } });
    return { revoked: true, hardRevoked: r.hardRevoked };
  }

  // 장부의 만료 줄 닫기 + 감사 (이미 감사에 남긴 참조는 다시 안 남긴다)
  async function closeExpired(tenantId: string, audited: Set<string>) {
    const closed = await ledger.expireDue(tenantId, now());
    for (const c of closed) if (!audited.has(c.ref))
      await d.audit(tenantId, { actor: "worker", action: "temp_role.expired", target: c.migrationId ?? c.envId,
        result: "ok", detail: { credentialRef: c.ref, closedBy: owner } });
    return closed.length;
  }

  // 검사 → 발급 → 장부 → 보관함 → 감사. 첫 발급과 재발급이 같은 길을 탄다 (재발급도 최소 권한·세션 정책을 다시 검사한다)
  async function mint(parsed: TempRoleRequest, o: { step?: string | null; renewedFrom?: string; seq?: number }): Promise<TempCredential> {
      const t = now();
      let sessionPolicy: string | undefined;
      try {
        checkLeastPrivilege(parsed);
        if (parsed.purpose === "operate") {
          // 권한 파일 없이 실행 역할을 주면 AWS plan 단계도 역할 전체 권한을 받는다 → 거부 (T-ROLE-6)
          if (!d.permissions) throw new TempRoleDenied("ROLE_NO_CEILING", "최소 권한 파일(infra/permissions)이 없어 실행 역할을 줄 수 없다");
          if (parsed.policy && parsed.provider !== "aws")
            throw new TempRoleDenied("ROLE_POLICY_PROVIDER", `세션 정책 ${parsed.policy} 는 AWS 실행 역할에만 쓴다`);
          if (parsed.provider === "aws") {
            if (!parsed.stage) throw new TempRoleDenied("ROLE_OPERATE_NO_STAGE", "AWS 실행 역할은 단계(plan|apply|destroy)가 필요하다");
            // 중계기(policy relay): 천장 = 고객이 따로 붙인 중계기 문 묶음, 세션 정책 = 그 동작만. 단계 세션 정책은 안 쓴다
            const relay = parsed.policy === "relay" ? d.permissions.aws.relay : undefined;
            if (parsed.policy === "relay" && !relay)
              throw new TempRoleDenied("ROLE_NO_CEILING", "중계기 권한 파일(infra/permissions/aws-relay-statements.json)이 없어 중계기 역할을 줄 수 없다");
            const ceiling = relay ? relay.ceiling : d.permissions.aws.ceiling;
            const explicitPolicy = relay ? relay.sessionPolicy : d.permissions.aws.sessionPolicies[parsed.stage];
            const allowed = checkSessionPolicy(explicitPolicy, ceiling);
            // 2,048자 상한: 보낼 때는 실효 권한이 같은 짧은 판 (permissions.ts compactSessionPolicy)
            // 중계기는 줄이지 않는다: 줄이기는 "역할 정책 = 천장" 을 전제하는데, 실행 역할에는 중계기 문 말고 운영 정책도 붙어 있어
            //   중계기 천장 기준으로 줄이면 ec2:* 가 되어 운영 정책의 다른 ec2 동작까지 열린다 (시험이 잡음). 18개라 원문도 2,048자 안이다
            sessionPolicy = relay ? explicitPolicy : compactSessionPolicy(explicitPolicy, ceiling);
            if (sessionPolicy.length > AWS_SESSION_POLICY_MAX)
              throw new TempRoleDenied("ROLE_POLICY_TOO_LARGE", `세션 정책 ${sessionPolicy.length}자 > ${AWS_SESSION_POLICY_MAX}`);
            checkWithinCeiling(parsed.actions, allowed);   // 요청이 세션 정책보다 넓으면 설계 실수
          } else if (parsed.provider === "gcp") checkWithinCeiling(parsed.actions, d.permissions.gcp.ceiling);
          else if (parsed.provider === "onprem") checkWithinCeiling(parsed.actions, d.permissions.onprem.ceiling);
        }
      } catch (e) {
        if (e instanceof TempRoleDenied) return deny(parsed, e);
        throw e;
      }
      const issuer = d.issuers[parsed.provider];
      if (!issuer) return deny(parsed, new TempRoleDenied("ROLE_NO_ISSUER", `${parsed.provider} 발급기가 설정되지 않았다`));
      // 실행 역할은 15분까지로 줄인다
      const req = parsed.purpose === "operate" ? { ...parsed, ttlSec: Math.min(parsed.ttlSec, OPERATE_MAX_TTL_SEC) } : parsed;

      const env = await d.resolveEnv(req.tenantId, req.envId, req.purpose);
      // Z47: 진짜 AWS 발급기는 ExternalId 없이 고객 역할을 빌리지 않는다 (혼동된 대리인, 위협 모델 T-ROLE-2).
      //   ExternalId 가 없으면 다른 고객이 우리 플랫폼 계정을 믿는 역할 ARN 을 적어 넣어 남의 계정을 조작하게 만들 수 있다.
      //   Mock 발급기는 막지 않는다 (지금 워커 연결은 전부 Mock, resolveEnv 가 ExternalId 를 아직 안 읽는다 → platform.ts TODO)
      // L4: 환경별로 진짜/가짜가 갈리는 발급기(perEnvAwsIssuer)는 여기서 정해진다
      const mock = issuer.mockFor?.(env) ?? issuer.mock;
      if (req.provider === "aws" && !mock && !env.externalId)
        return deny(req, new TempRoleDenied("ROLE_NO_EXTERNAL_ID", "AWS 고객 역할을 빌릴 때 ExternalId 가 필요하다 (environments.external_id)"));
      const sessionName = `svc-${req.purpose}-${req.tenantId.slice(0, 8)}-${(req.migrationId ?? "observe").slice(0, 8)}-${++seq}`;
      let out;
      try {
        out = await issuer.issue({ req, now: t, roleRef: env.roleRef, sessionName, sessionPolicy, externalId: env.externalId });
      } catch (e) {
        await d.audit(req.tenantId, { actor: "worker", action: "temp_role.issue_failed", target: req.migrationId ?? req.envId,
          result: "error", detail: { provider: req.provider, purpose: req.purpose, error: (e as Error).message } });
        throw e;
      }
      const ref = `cred/${req.provider}/${sessionName}-${randomBytes(3).toString("hex")}`;
      // 장부 먼저 (워커가 여기서 죽어도 "살아 있는 자격이 있다"가 남아 회수 증거가 거짓이 안 된다)
      await ledger.record({ ref, tenantId: req.tenantId, migrationId: req.migrationId ?? null, envId: req.envId,
        provider: req.provider, purpose: req.purpose, stage: req.stage ?? null, roleRef: env.roleRef, owner,
        issuedAt: t, expiresAt: out.expiresAt,
        step: o.step ?? null, actionsCount: req.actions.length, requestedTtlSec: parsed.ttlSec, stub: mock,
        renewedFrom: o.renewedFrom ?? null, renewSeq: o.seq ?? 0 });
      vault.put({ ref, tenantId: req.tenantId, migrationId: req.migrationId ?? null, provider: req.provider,
        expiresAt: out.expiresAt.getTime(), material: out.material });
      const cred = TempCredential.parse({
        provider: req.provider, purpose: req.purpose, roleRef: env.roleRef, sessionName, actions: req.actions,
        issuedAt: t.toISOString(), expiresAt: out.expiresAt.toISOString(), credentialRef: ref, stub: mock,
        ...(req.stage ? { stage: req.stage } : {}),
        ...(out.ttlSec !== parsed.ttlSec ? { ttlAdjustedSec: out.ttlSec } : {}),
      });
      issued.set(ref, { cred, tenantId: req.tenantId, migrationId: req.migrationId ?? null, envId: req.envId,
        req: parsed, step: o.step ?? null, seq: o.seq ?? 0 });
      await d.audit(req.tenantId, {
        actor: "worker", action: "temp_role.issued", target: req.migrationId ?? req.envId, result: "ok",
        detail: { credentialRef: ref, provider: req.provider, purpose: req.purpose, stage: req.stage ?? null,
          ...(req.policy ? { policy: req.policy } : {}),
          roleRef: env.roleRef, expiresAt: cred.expiresAt, actions: req.actions.length, stub: mock,
          ...(o.step ? { step: o.step } : {}),
          ...(o.renewedFrom ? { renewedFrom: o.renewedFrom, renewSeq: o.seq } : {}),
          owner, issuer: out.detail },
      });
      return cred;
  }

  return {
    vault, ledger, owner,

    // o.step = 빌린 작업 단계 이름 (precheck·plan·apply·cleanup·rollback). 장부(0013)와 감사에 같이 남는다
    async issue(raw: unknown, o: { step?: string } = {}): Promise<TempCredential> {
      return mint(TempRoleRequest.parse(raw), { step: o.step ?? null });
    },

    // 재발급 (Z61): 같은 요청으로 새 자격을 받고(새 참조), 장부에 renewed_from 으로 잇고, 옛 자격은 회수(reason renewed)한다.
    // 순서 = 새 것 먼저 → 옛 것 회수. 중간에 쓰는 쪽이 자격 없이 비는 순간이 없다 (AWS SDK 도 만료 전 미리 갱신)
    // 실패하면 옛 자격은 그대로 두고(만료까지 유효) CredRenewFailed. 회수 요청이 와 있던 자격은 재발급하지 않는다 (긴급 정지 뒤 다시 살아나지 않게)
    async renew(ref: string, tenantId: string): Promise<TempCredential> {
      const it = issued.get(ref);
      if (!it || it.tenantId !== tenantId) throw new CredRenewFailed(ref, "ROLE_RENEW_UNKNOWN", `재발급할 자격이 이 워커에 없다: ${ref}`);
      const seq = it.seq + 1;
      const fail = async (reason: string, message: string): Promise<never> => {
        await d.audit(tenantId, { actor: "worker", action: "temp_role.renew_failed", target: it.migrationId ?? it.envId, result: "error",
          detail: { credentialRef: ref, reason, error: message.slice(0, 300), renewSeq: seq, step: it.step,
            oldExpiresAt: it.cred.expiresAt } });
        throw new CredRenewFailed(ref, reason, message);
      };
      if ((await ledger.revokeRequested(tenantId, [ref])).length > 0)
        return fail("ROLE_RENEW_REVOKE_REQUESTED", "회수 요청이 와 있는 자격은 재발급하지 않는다");
      if (d.renewFault?.() && d.issuers[it.cred.provider as Provider]?.mock)
        return fail("STUB_RENEW_FAULT", "STUB: 재발급 실패 흉내 (CRED_RENEW_STUB_FAIL=1)");
      let next: TempCredential;
      try { next = await mint(it.req, { step: it.step, renewedFrom: ref, seq }); }
      catch (e) { return fail(e instanceof TempRoleDenied ? e.code : "ROLE_RENEW_ISSUE_FAILED", (e as Error).message ?? String(e)); }
      await revokeOwned(ref, tenantId, "renewed", false);
      await d.audit(tenantId, { actor: "worker", action: "temp_role.renewed", target: it.migrationId ?? it.envId, result: "ok",
        detail: { from: ref, to: next.credentialRef, renewSeq: seq, step: it.step, expiresAt: next.expiresAt, stub: next.stub } });
      return next;
    },

    // 어댑터 호출 직전에만 값을 꺼낸다. 실행 역할은 같은 이전 번호를 같이 줘야 한다 (T-ROLE-7)
    use(ref: string, tenantId: string, migrationId?: string): SecretMaterial {
      return vault.use(ref, tenantId, now(), migrationId);
    },

    // 이 워커가 쥔 것 하나를 회수. 다른 워커가 쥔 참조는 여기서 못 지운다 (revokeForMigration 이 요청을 남긴다)
    async revoke(ref: string, tenantId: string, reason: string, o: { hard?: boolean } = {}) {
      return revokeOwned(ref, tenantId, reason, !!o.hard);
    },

    // 이전이 끝나면(cleanup, rolled_back) 그 이전의 실행 역할을 모두 회수 → T27 operateRoleRevoked
    // 증거는 이 워커 메모리가 아니라 장부로 센다. 다른 워커가 쥔 것은 회수 요청만 남기고 false (그 워커의 청소 뒤 다시 시도하면 true)
    async revokeForMigration(tenantId: string, migrationId: string, reason: string, o: { hard?: boolean } = {}) {
      await closeExpired(tenantId, new Set());   // 이미 만료된 줄(죽은 워커 몫 포함)은 회수가 아니라 만료로 닫는다 (0013)
      const mine = [...issued.entries()].filter(([, v]) => v.tenantId === tenantId && v.migrationId === migrationId).map(([k]) => k);
      // M5: 하나가 실패해도 나머지는 회수한다. 실패한 것은 장부에 살아 있어 아래 stillActive 에 잡힌다 (증거 false)
      let failed = 0;
      for (const ref of mine) await revokeOwned(ref, tenantId, reason, !!o.hard).catch(() => { failed++; });
      const requested = await ledger.requestRevoke(tenantId, migrationId, reason, owner);
      const left = await ledger.activeOperate(tenantId, migrationId, now());
      const operateRoleRevoked = ledger.durable && left === 0;
      if (requested > 0 || !operateRoleRevoked)
        await d.audit(tenantId, { actor: "worker", action: "temp_role.revoke_pending", target: migrationId, result: "denied",
          detail: { reason, requestedFromOtherWorkers: requested, stillActive: left, revokeFailed: failed, ledgerDurable: ledger.durable } });
      return { revoked: mine.length - failed, failed, requested, stillActive: left, evidence: { operateRoleRevoked } };
    },

    // 주기적으로 (리퍼와 같이) 부른다: 만료 지우기 + 다른 워커가 남긴 회수 요청 처리
    async sweep() {
      const gone = vault.sweep(now());
      const tenants = new Set<string>();
      const audited = new Set<string>();
      for (const ref of gone) {
        const it = issued.get(ref); issued.delete(ref);
        if (it) {
          tenants.add(it.tenantId); audited.add(ref);
          await d.audit(it.tenantId, { actor: "worker", action: "temp_role.expired", target: it.migrationId ?? it.envId,
            result: "ok", detail: { credentialRef: ref } });
        }
      }
      for (const [ref, it] of issued) {
        tenants.add(it.tenantId);
        if (Date.parse(it.cred.expiresAt) <= now().getTime()) issued.delete(ref);
      }
      // 장부에서도 만료로 닫는다 (0013). 이 워커가 아는 회사만 (회사 벽 안에서 쓴다)
      for (const t of tenants) await closeExpired(t, audited);
      let honoured = 0;
      const byTenant = new Map<string, string[]>();
      for (const [ref, it] of issued) byTenant.set(it.tenantId, [...(byTenant.get(it.tenantId) ?? []), ref]);
      for (const [tenantId, refs] of byTenant)
        for (const r of await ledger.revokeRequested(tenantId, refs))
          // M5: 하나가 실패해도 청소를 멈추지 않는다 (실패는 revoke_failed 감사 + 장부 그대로 → 다음 청소에서 다시)
          await revokeOwned(r.ref, tenantId, r.reason, false).then(() => { honoured++; }, () => undefined);
      return { expired: gone.length, revokedOnRequest: honoured };
    },

    active(tenantId: string): TempCredential[] {
      return [...issued.values()].filter((v) => v.tenantId === tenantId).map((v) => v.cred);
    },
  };
}
export type TempRoleBroker = ReturnType<typeof createTempRoleBroker>;
