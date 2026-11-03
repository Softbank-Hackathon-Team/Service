// 이식성 규칙표. 순수 데이터 + 순수 함수: DB·파일·네트워크 없음.
// 번호는 보안 영역 설계 문서의 규칙표(P-*, 괴리 G-*)와 같다. 규칙 하나 = 판정 한 줄 이하
// DRAFT(ai): 규칙마다의 판정 단계(block/warn/attest/advise)는 보안 영역 초안이다. 팀 검토 전
// Z95 보안 회귀(같은 열쇠 pass→fail)가 이미 잡는 "출발보다 나빠짐"만으로 끝나는 것은 여기서 다시 세지 않는다.
// 여기는 값(국가·키 소유·확장 목록)과 앱 요구사항이 있어야 판정되는 것, 그리고 도착 하나만 봐도 안 되는 것을 본다
import type { DataClass, EnvFacts, Operator, PortabilityVerdict, SecurityRequirements } from "@svc/contracts";
import { SECRET_ENV_NAME, secretKindOf } from "../secret-patterns.js";

export interface PortabilityInput {
  requirements: SecurityRequirements | null;     // null = 명세에 아직 요구사항이 없음
  source: EnvFacts;
  target: EnvFacts;
  appEnv?: { name: string; value: string }[];    // AppSpec.service.env (비밀이 아닌 설정값)
}

export type PortabilityHit = Omit<PortabilityVerdict, "ruleId" | "title">;
// env = 환경 하나에 한 번 / db = 도착 postgres 컴포넌트마다 (target.db 를 그 컴포넌트 사실로 바꿔 끼운다)
// target.db 를 읽는 규칙만 db 다. 출발 DB 만 보는 규칙(P-DB-2·3)은 출발 대표 DB 하나라 env 로 한 번 낸다
export type RuleScope = "env" | "db";
export interface PortabilityRule {
  id: string;
  title: string;
  scope: RuleScope;
  check(i: PortabilityInput): PortabilityHit | null;
}

type Fact<T> = { value: T | null; origin: "measured" | "attested" | "unknown"; source: string | null };
type Side = "source" | "target";

// 모름이면 undefined. measured 인데 값이 null 인 것도 모름으로 본다
const val = <T>(f: Fact<T>): T | undefined => (f.origin === "unknown" || f.value === null ? undefined : f.value);
const show = <T>(label: string, f: Fact<T>) =>
  `${label}=${f.value === null ? "모름" : JSON.stringify(f.value)} (${f.origin}${f.source ? `, ${f.source}` : ""})`;

const isOnprem = (e: EnvFacts) => e.provider === "onprem";
// 온프레는 API 가 없어 고객 선언으로 닫고, 클라우드는 못 읽었으면 읽을 권한을 더해야 하므로 경고
const unknownLevel = (e: EnvFacts) => (isOnprem(e) ? "attest" as const : "warn" as const);
const unknownHit = (side: Side, e: EnvFacts, label: string, f: Fact<unknown>): PortabilityHit => ({
  level: unknownLevel(e), side, basis: "unknown",
  reason: `${side === "source" ? "출발" : "도착"}의 ${label} 을(를) 모른다. 모름은 통과가 아니다`,
  recommend: isOnprem(e) ? "고객이 이 값을 선언하고 그 선언을 감사 기록에 남긴다"
    : "observe 역할에 이 값을 읽을 권한을 더하고 다시 점검한다",
  evidence: show(label, f),
});

const OPERATOR: Record<EnvFacts["provider"], Operator> = { aws: "aws", gcp: "gcp", azure_mock: "azure", onprem: "customer" };
const CLASS_RANK: Record<DataClass, number> = { public: 0, internal: 1, personal: 2, sensitive: 3 };
const atLeastPersonal = (r: SecurityRequirements | null) => r !== null && CLASS_RANK[r.dataClass] >= CLASS_RANK.personal;

// 사설 주소·내부 도메인 (G-23). 클라우드로 옮기면 그대로는 안 닿는다
const PRIVATE_ADDR = /\b(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b|\.(internal|local|lan|corp)\b/i;
const SSL_OFF = /sslmode=disable/i;

export const PORTABILITY_RULES: PortabilityRule[] = [
  // ── 요구사항 ──
  {
    id: "P-REQ-0", scope: "env", title: "앱 보안 요구사항이 명세에 없다",
    check: (i) => i.requirements !== null ? null : {
      level: "attest", side: "app",
      reason: "데이터 등급·허용 국가·키 소유를 모르면 위치·키 규칙을 판정할 수 없다",
      recommend: "명세 검토 때 데이터 등급, 허용 국가, 키 소유를 정한다",
      evidence: "requirements=null",
    },
  },
  // ── 위치·주권 ──
  {
    id: "P-LOC-1", scope: "env", title: "도착 국가가 허용 국가 밖이다",
    check: ({ requirements: r, target: t }) => {
      if (!r || r.residency.length === 0) return null;
      const c = val(t.country);
      if (c === undefined) return unknownHit("target", t, "country", t.country);
      return r.residency.includes(c) ? null : {
        level: "block", side: "target",
        reason: `허용 국가 ${r.residency.join(",")} 밖(${c})으로 데이터가 옮겨진다`,
        recommend: "허용 국가 안의 리전이나 온프레를 도착으로 고른다",
        evidence: show("country", t.country),
      };
    },
  },
  {
    id: "P-LOC-2", scope: "env", title: "개인정보가 국경을 넘는다",
    check: ({ requirements: r, source: s, target: t }) => {
      if (!atLeastPersonal(r)) return null;
      const a = val(s.country), b = val(t.country);
      // 허용 국가가 정해져 있으면 도착 국가 모름은 P-LOC-1 이 이미 낸다
      if (a === undefined) return unknownHit("source", s, "country", s.country);
      if (b === undefined) return r!.residency.length > 0 ? null : unknownHit("target", t, "country", t.country);
      return a === b ? null : {
        level: "warn", side: "both",
        reason: `${r!.dataClass} 데이터가 ${a} 에서 ${b} 로 옮겨진다. 국외 이전은 고지·동의 등 근거가 필요하다 (개인정보보호법 제28조의8)`,
        recommend: "같은 국가 리전을 쓰거나, 국외 이전 근거를 승인 때 첨부한다",
        evidence: `${show("source.country", s.country)} / ${show("target.country", t.country)}`,
      };
    },
  },
  {
    id: "P-LOC-3", scope: "env", title: "도착 운영 주체가 허용 목록 밖이다",
    check: ({ requirements: r, target: t }) => {
      const allow = r?.operatorAllow;
      if (!allow) return null;
      const op = OPERATOR[t.provider];
      return allow.includes(op) ? null : {
        level: "block", side: "target",
        reason: `운영 주체 ${op} 는 허용 목록(${allow.join(",")})에 없다`,
        recommend: "허용된 운영 주체의 환경이나 온프레로 바꾼다",
        evidence: `provider=${t.provider}`,
      };
    },
  },
  {
    id: "P-LOC-5", scope: "env", title: "이전 중 데이터가 지나는 곳도 위치다",
    check: ({ requirements: r }) => !atLeastPersonal(r) ? null : {
      level: "advise", side: "app",
      reason: "Cloudflare 엣지, AI 워커가 부르는 LLM API, 덤프·스냅숏 보관 위치도 데이터가 놓이는 곳이다",
      recommend: "AI 워커에는 스키마만 보내고 행 데이터는 보내지 않는다. 덤프·스냅숏은 도착 국가 안에만 둔다",
      evidence: `dataClass=${r!.dataClass}`,
    },
  },
  // ── 암호화·키 ──
  {
    id: "P-ENC-1", scope: "db", title: "도착 DB 저장 암호화가 꺼져 있다",
    check: ({ requirements: r, source: s, target: t }) => {
      const b = val(t.db.encryptedAtRest);
      if (b === undefined) return unknownHit("target", t, "db.encryptedAtRest", t.db.encryptedAtRest);
      if (b) return null;
      const strict = val(s.db.encryptedAtRest) === true || atLeastPersonal(r);
      return {
        level: strict ? "block" : "warn", side: "target",
        reason: strict ? "출발에서 암호화돼 있었거나 개인정보 이상인데 도착 디스크가 평문이다" : "도착 디스크가 평문이다",
        recommend: isOnprem(t) ? "데이터 볼륨에 LUKS 를 건다" : "도착 DB 를 저장 암호화를 켜고 만든다",
        evidence: `${show("source.encryptedAtRest", s.db.encryptedAtRest)} / ${show("target.encryptedAtRest", t.db.encryptedAtRest)}`,
      };
    },
  },
  {
    id: "P-KEY-1", scope: "db", title: "고객 키가 제공자 기본 키로 내려간다",
    check: ({ requirements: r, source: s, target: t }) => {
      const need = val(s.db.keyOwner) === "customer" || r?.keyOwnership === "customer";
      if (!need || val(t.db.keyOwner) !== "provider") return null;
      return {
        level: "block", side: "target",
        reason: "고객이 쥐던 키가 제공자 기본 키로 바뀐다. 고객이 키를 꺼서 데이터를 못 읽게 하는 통제가 사라진다",
        recommend: "도착에 고객 관리 키(CMK·CMEK)를 먼저 만들고 그 키로 DB 를 만든다",
        evidence: `${show("source.keyOwner", s.db.keyOwner)} / ${show("target.keyOwner", t.db.keyOwner)} / requirements.keyOwnership=${r?.keyOwnership ?? "없음"}`,
      };
    },
  },
  {
    id: "P-KEY-2", scope: "db", title: "고객 키가 필요한데 도착 키 소유를 모른다",
    check: ({ requirements: r, source: s, target: t }) => {
      const need = val(s.db.keyOwner) === "customer" || r?.keyOwnership === "customer";
      return need && val(t.db.keyOwner) === undefined ? unknownHit("target", t, "db.keyOwner", t.db.keyOwner) : null;
    },
  },
  {
    id: "P-ENC-2", scope: "db", title: "도착 DB 가 비TLS 접속을 받는다",
    check: ({ target: t }) => {
      const b = val(t.db.tlsEnforced);
      if (b === undefined) return unknownHit("target", t, "db.tlsEnforced", t.db.tlsEnforced);
      return b ? null : {
        level: "block", side: "target",
        reason: "평문 DB 접속이 허용된다. TLS 강제는 플랫폼 기본값이라 고객이 끌 수 없다",
        recommend: isOnprem(t) ? "CNPG pg_hba 에 hostnossl all all all reject 를 더한다" : "도착 DB 의 TLS 강제 설정을 켠다",
        evidence: show("db.tlsEnforced", t.db.tlsEnforced),
      };
    },
  },
  // ── 노출·신원·비밀 ──
  {
    id: "P-NET-1", scope: "db", title: "도착 DB 가 인터넷에 열려 있다",
    check: ({ target: t }) => {
      const b = val(t.db.publicAccess);
      if (b === undefined) return unknownHit("target", t, "db.publicAccess", t.db.publicAccess);
      return !b ? null : {
        level: "block", side: "target",
        reason: "DB 가 인터넷에 열린 채로 데이터가 들어간다",
        recommend: "사설 서브넷·내부 Service 로 둔다. 복제용 구멍은 임시 자원 장부에 적고 정리 때 닫는다",
        evidence: show("db.publicAccess", t.db.publicAccess),
      };
    },
  },
  {
    id: "P-IAM-1", scope: "db", title: "도착 DB 가 약한 로그인 방식을 허용한다",
    check: ({ target: t }) => {
      const m = val(t.db.authMethods);
      if (m === undefined) return unknownHit("target", t, "db.authMethods", t.db.authMethods);
      const trust = m.includes("trust"), weak = m.includes("md5") || m.includes("password");
      if (!trust && !weak) return null;
      return {
        level: trust ? "block" : "warn", side: "target",
        reason: trust ? "trust 는 비밀번호 없이 들어온다" : "md5·password 는 오래된 방식이다",
        recommend: "scram-sha-256 만 남긴다",
        evidence: show("db.authMethods", t.db.authMethods),
      };
    },
  },
  {
    id: "P-IAM-2", scope: "env", title: "클라우드 역할을 빌리던 앱이 온프레에서 고정 키를 쓰게 된다",
    check: ({ source: s, target: t }) => val(s.platform.workloadIdentity) !== true || !isOnprem(t) ? null : {
      level: "warn", side: "both",
      reason: "온프레에는 클라우드 역할을 빌릴 길이 없어 오래 사는 고정 키가 필요하다. 유출되면 회수가 늦다",
      recommend: "그 의존(S3·GCS 등)을 명세의 외부 의존으로 드러내고, 키는 ESO 로 넣고 교체 주기를 정한다",
      evidence: show("source.workloadIdentity", s.platform.workloadIdentity),
    },
  },
  {
    id: "P-SEC-1", scope: "env", title: "앱 설정값에 비밀이 평문으로 있다",
    check: ({ appEnv }) => {
      // 값은 돌려주지 않는다. 이름만 싣는다
      const names = (appEnv ?? []).filter((e) => secretKindOf(e.value) !== null || (SECRET_ENV_NAME.test(e.name) && e.value !== ""))
        .map((e) => e.name);
      return names.length === 0 ? null : {
        level: "block", side: "app",
        reason: "비밀이 명세·Git·Helm 값에 평문으로 남는다",
        recommend: "secretRefs 로 옮긴다",
        evidence: `env: ${names.join(", ")}`,
      };
    },
  },
  {
    id: "P-SEC-2", scope: "env", title: "도착 비밀 저장소가 암호화돼 있지 않다",
    check: ({ target: t }) => {
      const b = val(t.platform.secretsEncrypted);
      if (b === undefined) return unknownHit("target", t, "platform.secretsEncrypted", t.platform.secretsEncrypted);
      return b ? null : {
        level: "warn", side: "target",
        reason: "비밀이 클러스터 저장소에 평문으로 저장된다",
        recommend: isOnprem(t) ? "k3s secrets-encryption 을 켠다" : "비밀 저장소 암호화를 켠다",
        evidence: show("platform.secretsEncrypted", t.platform.secretsEncrypted),
      };
    },
  },
  {
    id: "G-21", scope: "env", title: "앱이 DB 평문 접속을 설정하고 있다",
    check: ({ appEnv }) => {
      const names = (appEnv ?? []).filter((e) => SSL_OFF.test(e.value)).map((e) => e.name);
      return names.length === 0 ? null : {
        level: "block", side: "app",
        reason: "내부망이라 평문으로 붙던 설정이 옮긴 뒤에는 남의 망을 지난다",
        recommend: "접속 문자열을 sslmode=require 이상으로 바꾼다",
        evidence: `env: ${names.join(", ")}`,
      };
    },
  },
  {
    id: "G-23", scope: "env", title: "앱 설정에 사설 주소·내부 도메인이 박혀 있다",
    check: ({ appEnv }) => {
      const names = (appEnv ?? []).filter((e) => PRIVATE_ADDR.test(e.value)).map((e) => e.name);
      return names.length === 0 ? null : {
        level: "warn", side: "app",
        reason: "옮긴 뒤 그 주소에 안 닿는다. 급하게 방화벽을 넓혀 맞추는 일이 생긴다",
        recommend: "주소를 설정값으로 빼고 도착 주소로 바꾼다",
        evidence: `env: ${names.join(", ")}`,
      };
    },
  },
  // ── DB 호환 (보안과 이어지는 것만) ──
  {
    id: "P-DB-1", scope: "db", title: "도착이 허용하지 않는 확장을 출발이 쓴다",
    check: ({ source: s, target: t }) => {
      const ext = val(s.db.extensions);
      if (ext === undefined) return unknownHit("source", s, "db.extensions", s.db.extensions);
      const used = ext.filter((e) => e !== "plpgsql");
      if (used.length === 0) return null;
      const allow = val(t.db.extensionAllowlist);
      if (allow === undefined) return unknownHit("target", t, "db.extensionAllowlist", t.db.extensionAllowlist);
      const missing = allow.includes("*") ? [] : used.filter((e) => !allow.includes(e));
      return missing.length === 0 ? null : {
        level: "block", side: "both",
        reason: `도착에서 쓸 수 없는 확장: ${missing.join(", ")}. 앱이 깨지거나 급하게 권한을 넓혀 우회하게 된다`,
        recommend: "확장 없이 돌게 바꾸거나, 그 확장을 허용하는 도착을 고른다",
        evidence: `${show("source.extensions", s.db.extensions)} / ${show("target.extensionAllowlist", t.db.extensionAllowlist)}`,
      };
    },
  },
  {
    id: "P-DB-2", scope: "env", title: "앱 계정이 superuser 다",
    check: ({ source: s, target: t }) => val(s.db.appRoleSuperuser) !== true ? null : {
      level: isOnprem(t) ? "warn" : "block", side: "source",
      reason: isOnprem(t) ? "온프레에서는 그대로 돌지만 최소 권한이 깨진 채로 옮겨진다"
        : "관리형 DB 에는 진짜 superuser 가 없어 도착에서 앱이 깨진다",
      recommend: "앱 계정에서 superuser 를 빼고 필요한 권한만 준다",
      evidence: show("source.appRoleSuperuser", s.db.appRoleSuperuser),
    },
  },
  {
    id: "P-DB-3", scope: "env", title: "출발 인코딩이 SQL_ASCII 다",
    check: ({ source: s }) => val(s.db.encoding) !== "SQL_ASCII" ? null : {
      level: "warn", side: "source",
      reason: "검사 안 된 바이트가 도착 UTF8 DB 에서 복제를 멈춘다",
      recommend: "이전 전에 잘못된 바이트를 정제한다",
      evidence: show("source.encoding", s.db.encoding),
    },
  },
  {
    id: "P-DB-4", scope: "db", title: "정렬 규칙이 다르다",
    check: ({ source: s, target: t }) => {
      const a = val(s.db.collation), b = val(t.db.collation);
      return a === undefined || b === undefined || a === b ? null : {
        level: "advise", side: "both",
        reason: "논리 복제는 도착이 인덱스를 새로 만들어 안전하지만, 정렬 순서가 달라 앱 결과가 바뀔 수 있다",
        recommend: "논리 복제를 유지하고 정렬에 기대는 화면·API 를 시험한다. 디스크 사본으로 옮기지 않는다",
        evidence: `${show("source.collation", s.db.collation)} / ${show("target.collation", t.db.collation)}`,
      };
    },
  },
  {
    id: "P-DB-5", scope: "db", title: "도착 DB 주 버전이 더 낮다",
    check: ({ source: s, target: t }) => {
      const a = val(s.db.majorVersion), b = val(t.db.majorVersion);
      return a === undefined || b === undefined || b >= a ? null : {
        level: "advise", side: "both",
        reason: "논리 복제는 되지만 롤백(역방향 복제) 때 기능 차이가 드러난다",
        recommend: "같은 주 버전이나 상위 버전을 고른다",
        evidence: `${show("source.majorVersion", s.db.majorVersion)} / ${show("target.majorVersion", t.db.majorVersion)}`,
      };
    },
  },
  // ── 운영 ──
  {
    id: "P-BAK-1", scope: "db", title: "출발에서 되던 시점 복구가 도착에서 안 된다",
    check: ({ source: s, target: t }) => val(s.db.pitr) !== true || val(t.db.pitr) === true ? null : {
      level: "warn", side: "target",
      reason: val(t.db.pitr) === false ? "도착에 시점 복구가 없다" : "도착 시점 복구 여부를 모른다",
      recommend: isOnprem(t) ? "CNPG 백업(오브젝트 저장소 + WAL 보관)을 건다" : "도착 DB 의 시점 복구를 켠다",
      evidence: `${show("source.pitr", s.db.pitr)} / ${show("target.pitr", t.db.pitr)}`,
    },
  },
  {
    id: "P-AUD-1", scope: "env", title: "출발에 있던 감사 로그가 도착에 없다",
    check: ({ source: s, target: t }) => val(s.platform.auditLog) !== true || val(t.platform.auditLog) === true ? null : {
      level: "warn", side: "target",
      reason: "누가 무엇을 바꿨는지 남지 않는다",
      recommend: isOnprem(t) ? "k3s API 감사 로그를 켠다" : "도착 계정의 감사 로그를 켠다",
      evidence: `${show("source.auditLog", s.platform.auditLog)} / ${show("target.auditLog", t.platform.auditLog)}`,
    },
  },
  // ── 클라우드↔온프레 방향 ──
  {
    id: "G-07", scope: "env", title: "패치·운영 책임이 고객에게 넘어간다",
    check: ({ source: s, target: t }) => isOnprem(s) || !isOnprem(t) ? null : {
      level: "advise", side: "target",
      reason: "관리형이 하던 OS·k3s·Postgres 부 버전 패치와 백업을 고객이 해야 한다",
      recommend: "승인 화면에 책임 이전을 적고, 패치 주기를 고객과 정한다",
      evidence: `${s.provider} → ${t.provider}`,
    },
  },
  {
    id: "G-32", scope: "env", title: "복제를 위해 온프레 DB 로 들어오는 길이 필요하다",
    check: ({ source: s, target: t }) => isOnprem(s) === isOnprem(t) ? null : {
      level: "warn", side: isOnprem(s) ? "source" : "target",
      reason: isOnprem(s) ? "온프레가 복제 출발이라 클라우드 DB 가 온프레 DB 로 접속해야 한다"
        : "롤백 창의 역방향 복제에서 클라우드 DB 가 온프레 DB 로 접속해야 한다",
      recommend: "온프레 5432 를 상대 NAT IP 1개에만 열고 TLS 강제·복제 전용 계정을 쓴다. 그 구멍은 만들기 전에 임시 자원 장부에 적는다. 또는 Site-to-Site VPN",
      evidence: `${s.provider} → ${t.provider}`,
    },
  },
];
