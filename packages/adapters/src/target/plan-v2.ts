import { AppSpecV2, PrecheckItem, type Provider, type TfOutputs } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { postgresOf, renderViewV2, secretPairWarnings, v2Blockers, workloadsOf, identitiesOf, managedServicesOf, vmServicesOf } from "./shared.js";
import { targetBuilderFor } from "./index.js";
import { azureShapeBlockers } from "./azure-mock.js";
import { grantBlockers, grantWarnings } from "./grants.js";
import { managedWarnings } from "./managed.js";
import { vmWarnings } from "./vm.js";
import { k8sRenderWarnings } from "./render-warnings.js";
import { queueRangeProblems } from "./data.js";
import { dataFit, dbIdentityFor } from "./data-fit.js";
import { rdsClassFor } from "./aws.js";
import { cloudSqlTierFor } from "./gcp.js";
import { capabilityPlanLines } from "./capability-checks.js";

// TA3 DRAFT(ai): 계획·적용 연결용 순수 조각 (설계 27번 3.5·3.6). DB·네트워크 없음. 워커(plan·precheck·apply·deploy)가 부른다

export const NEEDS_HUMAN = "NEEDS_HUMAN";

// 최신 받아들인 판 한 줄 (core latestAcceptedSpecV2 결과 모양). specV2 = spec_v2->'spec'
export interface SpecV2Source { specV2: unknown | null }
export type ResolvedSpecV2 =
  | { ok: true; spec: AppSpecV2 }
  | { ok: false; code: typeof NEEDS_HUMAN; reason: string };

/** 명세 꺼내기. 없거나 모양이 틀리면 NEEDS_HUMAN (예전 판을 몰래 바꿔 옮기지 않음) */
export function resolveSpecV2(row: SpecV2Source): ResolvedSpecV2 {
  if (row.specV2 == null)
    return { ok: false, code: NEEDS_HUMAN, reason: "이 판에 명세가 없음 (예전 형식 판). 다시 가져와야 함" };
  const p = AppSpecV2.safeParse(row.specV2);
  if (!p.success) return { ok: false, code: NEEDS_HUMAN, reason: `명세 모양이 틀림: ${p.error.issues[0]?.path.join(".") ?? "?"}` };
  return { ok: true, spec: renderViewV2(p.data) };   // INCL: 클러스터 안 데이터 자원은 워크로드 그대로 그림 (계획·적용·배포 모두 이 길)
}

/** 계획 단계가 쓰는 명세. 못 쓰면 AdapterError(NEEDS_HUMAN) → planOnError 가 바로 failed */
export function specV2OrThrow(row: SpecV2Source): { spec: AppSpecV2 } {
  const r = resolveSpecV2(row);
  if (!r.ok) throw new AdapterError(NEEDS_HUMAN, r.reason);
  return r;
}

/** apply·deploy 때 쓰는 명세. 못 쓰면 null (부르는 쪽이 drift 로 멈춘다) */
export function specV2ForPlan(row: SpecV2Source): AppSpecV2 | null {
  const r = resolveSpecV2(row);
  return r.ok ? r.spec : null;
}

/** precheck 대조 (27번 3.6). capability 밖·사람 확인 → block, 렌더 경고는 따로 안 냄(계획서 값 warnings) */
export function v2PrecheckItems(provider: Provider, row: SpecV2Source): PrecheckItem[] {
  const r = resolveSpecV2(row);
  if (!r.ok) return [{ id: "PC-V2-HUMAN", level: "block", message: `FAIL 명세 — ${r.reason}`, fix: "명세를 다시 가져오거나 판을 고친다" }];
  const b = v2Blockers(r.spec, targetBuilderFor(provider).capabilities());
  // E2E-v5: capability 표로 못 거르는 Builder 모양 제한 (azure_mock 신원 1개). 빼면 계획 단계에서 UNSUPPORTED_V2 로 failed 가 됨
  if (provider === "azure_mock") b.unsupported.push(...azureShapeBlockers(r.spec));
  // A8: 출발 IAM 권한(grants·posture.permissions) 중 도착에서 못 그리는 것 — Builder(assertGrants)와 같은 목록
  b.unsupported.push(...grantBlockers(provider, r.spec));
  // QR-1: 도착 상품의 큐 시간 범위 밖 → 자르지 않고 사람에게 (모듈은 그대로 넘겨 apply 에서 깨지거나 조용히 바뀜)
  b.needsHuman.push(...queueRangeProblems(provider, r.spec));
  // SZ-1·CV-1·DM-5 (fc2): DB·캐시 크기·캐시 버전이 도착 표에 맞나 (Builder assertDataFit 과 같은 목록)
  const fit = dataFit(provider, r.spec, { postgres: (c) => (provider === "aws" ? rdsClassFor(c.props.compute) : cloudSqlTierFor(c.props.compute)) });
  b.unsupported.push(...fit.unsupported);
  b.needsHuman.push(...fit.needsHuman);
  // FM-APP-hunt-deploy-db-02 DRAFT(ai): DB 논리 복제 끝점은 이전마다 하나(terraform root repl_key 는 postgres 1개일 때만 값, 워커 _repl.ts 도 하나).
  //   postgres 가 둘 이상이면 apply·배포(돈 드는 단계)까지 간 뒤 복제가 빈 주소로 멈춘다 → 계획 전에 막는다. TODO(human): 끝점을 postgres 마다 두는 확장
  const pgs = r.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id).sort();
  if (pgs.length > 1) b.unsupported.push(`Postgres ${pgs.length}개(${pgs.join(", ")}) → DB 복제는 이전 하나에 Postgres 하나만 지원. 하나만 남기거나(명세에서 빼기) 이전을 나눈다`);
  const out: PrecheckItem[] = [
    { id: "PC-V2-SOURCE", level: "info", message: `PASS 명세 — 리소스 ${r.spec.components.length}개` },
  ];
  b.unsupported.forEach((m, n) => out.push({ id: `PC-V2-UNSUP-${n + 1}`, level: "block", message: `FAIL ${m}`, fix: "도착을 바꾸거나 그 칸을 명세에서 뺀다 (사람 승인)" }));
  b.needsHuman.forEach((m, n) => out.push({ id: `PC-V2-HUMAN-${n + 1}`, level: "block", message: `FAIL 사람 확인 필요 — ${m}`, fix: "명세 검토에서 정한다" }));
  grantWarnings(provider, r.spec).forEach((m, n) => out.push({ id: `PC-V2-GRANTS-${n + 1}`, level: "warn", message: `WARN 권한 — ${m}` }));
  if (provider === "aws" || provider === "gcp")
    managedWarnings(provider, r.spec).forEach((m, n) => out.push({ id: `PC-V2-MANAGED-${n + 1}`, level: "warn", message: `WARN 관리형 — ${m}` }));
  if (provider === "aws" || provider === "gcp")
    secretPairWarnings(r.spec).forEach((m, n) => out.push({ id: `PC-V2-SECRETS-${n + 1}`, level: "warn", message: `WARN 비밀 — ${m}` }));
  if (provider === "aws" || provider === "gcp")
    vmWarnings(provider, r.spec).forEach((m, n) => out.push({ id: `PC-V2-VM-${n + 1}`, level: "warn", message: `WARN VM — ${m}` }));
  // W-1: k8s 렌더에서 달라지는 것 (메시 사이드카·빈 PVC·L4 주소·와일드카드·다른 클라우드 annotation). 손실은 위 UNSUP 이 막음
  fit.warnings.forEach((m, n) => out.push({ id: `PC-V2-DATA-${n + 1}`, level: "warn", message: `WARN 데이터 자원 — ${m}` }));
  k8sRenderWarnings(r.spec, provider).forEach((m, n) => out.push({ id: `PC-V2-K8S-${n + 1}`, level: "warn", message: `WARN k8s — ${m}` }));
  // E-1: 출발 나가는 IP → 도착은 다른 IP. 도착 고정 IP 만들기는 범위 밖(계획 줄로만). warn = 승인 확인 줄(acks)이 된다
  const eg = r.spec.posture.egress;
  if (eg && (eg.ips.length || eg.fixed === false))
    out.push({ id: "PC-V2-EGRESS", level: "warn",
      message: `WARN 나가는 IP — 출발은 ${eg.ips.length ? `고정 IP ${eg.ips.length}개(${eg.ips.join(", ")})` : "자동 할당 IP"}로 밖에 나감. 도착은 IP 가 달라 외부 파트너·결제사 허용 목록에 막힐 수 있음`,
      fix: "도착 나가는 IP 를 정해 파트너 허용 목록을 바꾼다 (TODO(human): 도착 고정 IP 를 플랫폼이 만들지)" });
  // APP-20 (지휘 결정 11/4 00:51Z, ADR-072 유지: 플랫폼은 비밀 값을 복사하지 않는다): 도착 k8s 가 ExternalSecret 으로 읽을 비밀 그릇마다
  //   "값을 넣어야 함" 승인 줄(warn = 계획 승인 acks). 그릇은 apply 가 만든다 → 값이 들었는지는 deploy 직전에 본다(deploy SECRET_VALUES_MISSING)
  if (provider === "aws" || provider === "gcp") {
    secretValueLines(provider, r.spec).forEach((m, n) => out.push({ id: `PC-V2-SECVAL-${n + 1}`, level: "warn", message: `WARN 비밀 값 — ${m}`,
      fix: "apply 뒤 deploy 전에 고객 도구로 값을 넣는다 (플랫폼은 값을 복사하지 않음, ADR-072). deploy 가 버전이 있는지 확인한다" }));
  }
  // E-2: 출발 사설 DNS 이름 → 도착엔 같은 이름이 없음. 환경변수는 fromLink 로 바뀌지만 설정 파일·코드 안 이름은 안 풀림
  const dns = r.spec.privateDns ?? [];
  if (dns.length)
    out.push({ id: "PC-V2-DNS", level: "warn",
      message: `WARN 사설 DNS — 출발 사설 이름 ${dns.length}개(${dns.slice(0, 5).map((d) => `${d.name}→${d.to}`).join(", ")}${dns.length > 5 ? " …" : ""})가 도착에 없음. 설정 파일·코드에 적힌 이름은 안 풀림`,
      fix: "도착에 같은 이름의 사설 영역을 만들거나 앱 설정을 도착 주소로 바꾼다 (TODO(human): 플랫폼이 사설 영역을 만들지)" });
  return out.map((i) => PrecheckItem.parse(i));
}

/** GW-2: 입구 호스트마다 출발 공개 DNS 한 줄 (dns 칸이 없는 호스트는 줄 없음 = 온프레 등 DNS 를 안 읽는 출발) */
export function dnsPlanLines(spec: AppSpecV2): Array<{ warn: boolean; message: string }> {
  return (spec.entry?.hosts ?? []).filter((h) => h.dns).map((h) => {
    const host = h.hostnames[0]!, d = h.dns!;
    if (!d.read) return { warn: true, message: `${host}: 출발 공개 DNS 레코드를 못 읽음 → 가중치 전환·컷오버 때 바꿀 레코드(어느 영역·무슨 값)를 사람이 확인. 자동으로 안 바꿈` };
    if (!d.records.length) return { warn: true, message: `${host}: 출발 클라우드 공개 영역에 레코드 없음 (다른 DNS 업체일 수 있음) → 전환·컷오버 때 바꿀 곳을 사람이 확인` };
    const recs = d.records.map((x) => `${x.provider} ${x.zone} ${x.name} ${x.type}${x.alias ? ` 별칭→${x.alias}` : x.values.length ? ` ${x.values.join(",")}` : ""}${x.ttl !== undefined ? ` TTL ${x.ttl}` : ""}${x.weight !== undefined ? ` 가중치 ${x.weight}` : ""}${x.policy ? ` 정책 ${x.policy}` : ""}`);
    const longTtl = d.records.some((x) => (x.ttl ?? 0) > 300);
    return { warn: longTtl || d.records.some((x) => !!x.policy || x.weight !== undefined),
      message: `${host}: 출발 공개 DNS ${recs.join(" / ")} → 가중치 전환·컷오버 때 이 레코드를 사람이 바꿈 (자동으로 안 바꿈)${longTtl ? ". TTL 이 길어(300초 넘음) 바꾼 뒤에도 옛 주소로 오래 감 → 미리 줄여 둘 것" : ""}` };
  });
}

/** 진짜 terraform 출력(맵은 JSON 글자)을 자리표시 키로 펼침: link_outputs → link.<id>.<출력>, identity_* → identity.<id>.<칸>.
 *  원래 키는 그대로 둔다 (v1 평평한 이름 = 복제·비밀번호·프록시 코드가 읽음). 이미 펼친 키가 있으면 덮지 않는다 */
export function flattenTfOutputsV2(out: TfOutputs): TfOutputs {
  const res: TfOutputs = { ...out };
  const put = (k: string, v: unknown) => { if (res[k] === undefined && v != null) res[k] = typeof v === "string" ? v : String(v); };
  const obj = (s: string | undefined): Record<string, unknown> | null => {
    if (!s) return null;
    try { const o = JSON.parse(s); return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : null; } catch { return null; }
  };
  for (const [id, links] of Object.entries(obj(out.link_outputs) ?? {}))
    if (links && typeof links === "object") for (const [k, v] of Object.entries(links as Record<string, unknown>)) put(`link.${id}.${k}`, v);
  for (const [id, v] of Object.entries(obj(out.identity_gsa_emails) ?? {})) put(`identity.${id}.gsa_email`, v);
  for (const [id, v] of Object.entries(obj(out.identity_role_arns) ?? {})) put(`identity.${id}.role_arn`, v);
  // TA13: 관리형 서비스 이름 (aws·gcp 루트 출력 service_names)
  for (const [id, v] of Object.entries(obj(out.service_names) ?? {})) put(`service.${id}.name`, v);
  // RUNTIMEMAP v2: VM 머신 종류 (aws·gcp 루트 출력 vm_machine_types)
  for (const [id, v] of Object.entries(obj(out.vm_machine_types) ?? {})) put(`vm.${id}.machine`, v);
  return res;
}

/** STUB: 흉내 길(MOCK_IAC=1)의 v2 출력. v1 STUB_TF_OUTPUTS 에 더할 link.<id>.* · identity.<id>.* 가짜 값 (결정적) */
export function stubTfOutputsV2(spec: AppSpecV2): TfOutputs {
  const out: TfOutputs = {};
  for (const p of postgresOf(spec)) {
    const host = `stub-${p.id}.target.internal`;
    const { db, user } = dbIdentityFor(spec, p);   // DBN-1·E10-2: 진짜 모듈과 같은 이름
    Object.assign(out, { [`link.${p.id}.host`]: host, [`link.${p.id}.reader`]: host, [`link.${p.id}.port`]: "5432", [`link.${p.id}.user`]: user,
      [`link.${p.id}.url`]: `postgresql://${user}@${host}:5432/${db}` });
  }
  // TA12b STUB: 데이터 자원 link 출력 (LINK_OUTPUTS 표 그대로: cache host·port·url / objectStore name·url / queue url·name). 값은 id 에서 결정적
  for (const c of spec.components) {
    if (c.kind === "cache") {
      const host = `stub-${c.id}.cache.target.internal`;
      Object.assign(out, { [`link.${c.id}.host`]: host, [`link.${c.id}.port`]: "6379", [`link.${c.id}.url`]: `${c.props.tls === false ? "redis" : "rediss"}://${host}:6379` });
    } else if (c.kind === "objectStore") {
      const name = `stub-${spec.app.name}-${c.id}`;
      Object.assign(out, { [`link.${c.id}.name`]: name, [`link.${c.id}.url`]: `https://${name}.objects.target.internal` });
    } else if (c.kind === "queue") {
      const name = `stub-${c.id}`;
      Object.assign(out, { [`link.${c.id}.name`]: name, [`link.${c.id}.url`]: `https://queue.target.internal/${name}` });
    }
  }
  for (const i of identitiesOf(spec)) {
    out[`identity.${i.id}.gsa_email`] = `stub-${i.id}@stub-project.iam.gserviceaccount.com`;
    out[`identity.${i.id}.role_arn`] = `arn:aws:iam::000000000000:role/stub-${i.id}`;
  }
  // DEPLOYNONK8S STUB: 관리형 서비스 이름·VM 머신 종류·인스턴스 목록 (화면 값의 자리표시 없애기 + 배포 확인이 읽는 출력). 값은 id 에서 결정적
  const svc = managedServicesOf(spec), vms = vmServicesOf(spec);
  if (svc.length) {
    for (const s of svc) out[`service.${s.id}.name`] = `stub-${s.id}`;
    out.service_names = JSON.stringify(Object.fromEntries(svc.map((s) => [s.id, `stub-${s.id}`])));
    out.ecs_cluster_name = `stub-${spec.app.name}`;
  }
  if (vms.length) {
    const inst = Object.fromEntries(vms.map((v) => [v.id, Array.from({ length: Math.max(1, v.props.replicas.min) }, (_, n) => `stub-${v.id}-${n + 1}`)]));
    for (const v of vms) out[`vm.${v.id}.machine`] = "stub-machine";
    out.vm_machine_types = JSON.stringify(Object.fromEntries(vms.map((v) => [v.id, "stub-machine"])));
    out.vm_instance_ids = JSON.stringify(inst);
    out.vm_instance_names = JSON.stringify(inst);
  }
  return out;
}

// 이 명세가 k8s 워크로드를 하나라도 가지나 (없으면 배포할 값이 없다)
export const hasWorkloadsV2 = (spec: AppSpecV2) => workloadsOf(spec).length > 0;

/** APP-20: 도착 비밀 그릇(원격 키)과 키 목록. Builder 값과 같은 규칙 (회사 번호가 들어가는 aws 키는 <env:tenantId> 자리표시). 못 그리는 명세면 [] (다른 줄이 막음) */
export function secretValueLines(provider: Provider, spec: AppSpecV2): string[] {
  let v: { externalSecrets?: { secrets?: Array<{ name: string; remoteKey: string; keys: string[] }> } };
  try { v = targetBuilderFor(provider).toWorkloadValues(spec, {}, { envId: "00000000-0000-4000-8000-000000000000", provider, region: "default" } as never) as typeof v; }
  catch { return []; }
  return (v.externalSecrets?.secrets ?? []).map((s) =>
    `도착 저장소 ${s.remoteKey} 에 ${s.keys.length ? `키 ${s.keys.join(",")}` : "값(JSON 통째)"} 을 넣어야 Secret ${s.name} 이 생김 (안 넣으면 파드가 못 뜸)`);
}
