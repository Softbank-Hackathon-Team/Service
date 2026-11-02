import type { AppSpecV2, Provider } from "@svc/contracts";
import { parseArn } from "../import/mappers/iam-grants.js";
import { AdapterError } from "../common/errors.js";
import { identityOf, UNSUPPORTED_V2 } from "./shared.js";

// A8 DRAFT(ai): 출발 IAM 근거(LinkV2.grants · posture.permissions, I4) → 도착 신원 권한. 순수 함수, 결정적 (설계 20번 4.3, 27번 3.3)
//   원칙: 출발 계정 번호·ARN 은 옮기지 않는다. 자원은 IR id 로 다시 잡고, 실제 ARN·이름은 도착 Terraform root 가 그 id 의 모듈 출력으로 채운다.
//   못 옮기는 것(대응표 밖 동작·조건·NotAction·IR 밖 자원)은 unsupported → precheck block (TODO(human)). 몰래 빼거나 넓히지 않는다.

type TargetKind = "postgres" | "cache" | "objectStore" | "queue";
const AWS_SERVICE: Record<TargetKind, string> = { postgres: "rds", cache: "elasticache", objectStore: "s3", queue: "sqs" };
const kindOf = (spec: AppSpecV2, id: string): TargetKind | null => {
  const c = spec.components.find((x) => x.id === id);
  return c && c.kind in AWS_SERVICE ? (c.kind as TargetKind) : null;
};
const sortStr = (xs: Iterable<string>) => [...new Set(xs)].sort();

// ── AWS: 같은 동작 이름 + 자원 = 도착 모듈 ARN (+ 출발 경로) ─────────────
/** identity_json.grants_json 한 줄. targets 가 비면 star (Resource "*", 계정 단위 동작 거울) */
export interface AwsGrantStatement {
  effect: "Allow" | "Deny";
  actions: string[];
  star: boolean;
  targets: Array<{ kind: TargetKind; id: string; paths: string[] }>;
}
export interface GrantPlan<S> { byIdentity: Record<string, S[]>; unsupported: string[]; warnings: string[] }

const pathOf = (kind: TargetKind, r: string) => (r === "*" ? (kind === "objectStore" ? ["", "/*"] : [""]) : [kind === "objectStore" ? parseArn(r).path : ""]);

export function awsGrantPlan(spec: AppSpecV2): GrantPlan<AwsGrantStatement> {
  const by = new Map<string, AwsGrantStatement[]>(), unsupported: string[] = [], warnings: string[] = [];
  const push = (identity: string, s: AwsGrantStatement) => by.set(identity, [...(by.get(identity) ?? []), s]);
  for (const l of spec.links) {
    if (!l.grants?.length || typeof l.to !== "string") continue;
    const kind = kindOf(spec, l.to), ident = identityOf(spec, l.from);
    if (!kind || !ident) { unsupported.push(`권한 렌더 미지원: ${l.from}→${l.to} grants 대상이 데이터 자원·신원이 아님`); continue; }
    for (const g of l.grants) {
      const bad = g.actions.filter((a) => !a.startsWith(`${AWS_SERVICE[kind]}:`));
      if (bad.length) { unsupported.push(`권한 렌더 미지원: ${l.from}→${l.to} 대상 서비스가 아닌 동작 ${bad.join(",")}`); continue; }
      // TODO(human): 조건(Condition)은 출발 VPC 엔드포인트·계정 값을 담는 경우가 많아 그대로 옮기면 도착에서 전부 막힘 → 사람이 다시 씀
      if (g.conditions) { unsupported.push(`권한 렌더 미지원: ${l.from}→${l.to} 조건 붙은 권한 (사람이 도착 조건으로 다시 써야 함)`); continue; }
      // DRAFT(ai): Resource "*" 로 이 대상을 덮던 권한은 이 대상 하나로 좁힌다 (계정 전체를 새 계정에 여는 것보다 최소). 기준선에는 원문이 남음
      if (g.resources.includes("*")) warnings.push(`${l.from}→${l.to}: Resource "*" 권한을 이 대상 하나로 좁힘`);
      push(ident.id, { effect: "Allow", actions: sortStr(g.actions), star: false,
        targets: [{ kind, id: l.to, paths: sortStr(g.resources.flatMap((r) => pathOf(kind, r))) }] });
    }
  }
  for (const p of spec.posture.permissions) {
    const ident = identityOf(spec, p.subject);
    const where = `기준선 ${p.subject} ${p.effect} ${p.actions.join(",") || "(NotAction)"}`;
    if (!ident) { unsupported.push(`권한 렌더 미지원: ${where} — 신원 없는 주체`); continue; }
    if (p.notActions?.length || p.notResources?.length) { unsupported.push(`권한 렌더 미지원: ${where} — NotAction/NotResource 는 사람이 다시 씀`); continue; }
    if (p.conditions) { unsupported.push(`권한 렌더 미지원: ${where} — 조건 붙은 권한`); continue; }
    const star = p.resources.includes("*");
    const covered = (p.covers ?? []).map((id) => ({ id, kind: kindOf(spec, id) })).filter((x): x is { id: string; kind: TargetKind } => !!x.kind);
    // IR 밖 자원(출발 계정의 다른 자원): Allow 면 도착에 대응 자원이 없어 못 옮김. Deny 는 없는 자원에 대한 금지라 빼도 넓어지지 않음
    if (!star && !covered.length) {
      if (p.effect === "Allow") unsupported.push(`권한 렌더 미지원: ${where} — IR 밖 자원 (${p.resources.slice(0, 2).join(",")})`);
      else warnings.push(`${where}: IR 밖 자원에 대한 Deny 는 도착에 대상이 없어 뺌`);
      continue;
    }
    push(ident.id, { effect: p.effect, actions: sortStr(p.actions), star,
      targets: star ? [] : covered.map((c) => ({ kind: c.kind, id: c.id, paths: c.kind === "objectStore" ? ["", "/*"] : [""] })) });
  }
  const byIdentity = Object.fromEntries([...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, ss]) => {
    const uniq = new Map(ss.map((s) => [JSON.stringify(s), s]));
    return [id, [...uniq.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s)];
  }));
  return { byIdentity, unsupported: sortStr(unsupported), warnings: sortStr(warnings) };
}

// ── GCP: AWS 동작 → 가장 작은 미리 정의된 역할, 자원 단위 바인딩 ─────────────
export interface GcpGrantBinding { kind: "objectStore" | "queue"; target: string; role: string; scope: "bucket" | "topic" | "subscription" }

// DRAFT(ai): 대응표. 키 = AWS 동작(와일드카드 그대로), 값 = [역할, 단계(0 보기 1 쓰기 2 관리)]. 표 밖 동작은 TODO(human) block
const GCP_ROLE: Record<TargetKind, Record<string, [string, number, GcpGrantBinding["scope"]]>> = {
  objectStore: Object.fromEntries([
    ...["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketVersions"]
      .map((a) => [a, ["roles/storage.objectViewer", 0, "bucket"]]),
    ...["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:ListBucketMultipartUploads"]
      .map((a) => [a, ["roles/storage.objectUser", 1, "bucket"]]),
    ["s3:*Object", ["roles/storage.objectUser", 1, "bucket"]],
    ["s3:*", ["roles/storage.admin", 2, "bucket"]],
  ]) as Record<string, [string, number, GcpGrantBinding["scope"]]>,
  queue: Object.fromEntries([
    ...["sqs:SendMessage", "sqs:SendMessageBatch"].map((a) => [a, ["roles/pubsub.publisher", 1, "topic"]]),
    ...["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:DeleteMessageBatch", "sqs:ChangeMessageVisibility"].map((a) => [a, ["roles/pubsub.subscriber", 1, "subscription"]]),
    ...["sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ListQueueTags"].map((a) => [a, ["roles/pubsub.viewer", 0, "topic"]]),
    ["sqs:*", ["roles/pubsub.editor", 2, "topic"]],
  ]) as Record<string, [string, number, GcpGrantBinding["scope"]]>,
  // DB·캐시 관리 동작은 자원 단위 역할이 없다 (프로젝트 단위 역할 = 프로젝트 setIamPolicy 가 필요해 실행 역할이 너무 커짐) → 비움
  // TODO(human): Cloud SQL·Memorystore 관리 권한을 프로젝트 단위로 줄지
  postgres: {},
  cache: {},
};
const serviceKind = (a: string): TargetKind | null =>
  (Object.entries(AWS_SERVICE).find(([, s]) => a.startsWith(`${s}:`))?.[0] as TargetKind | undefined) ?? null;
// 거부(Deny) 동작이 어떤 단계부터 걸리나. 표에 없거나 와일드카드면 0 (보기부터 전부)
const levelOfDenied = (kind: TargetKind, a: string) => (a.includes("*") ? 0 : GCP_ROLE[kind][a]?.[1] ?? 0);

export function gcpGrantPlan(spec: AppSpecV2): GrantPlan<GcpGrantBinding> {
  const by = new Map<string, Map<string, GcpGrantBinding & { level: number }>>(), unsupported: string[] = [], warnings: string[] = [];
  const bind = (identity: string, b: GcpGrantBinding, level: number) => {
    const m = by.get(identity) ?? new Map(); by.set(identity, m);
    m.set(`${b.kind}/${b.target}/${b.scope}/${b.role}`, { ...b, level });
  };
  for (const l of spec.links) {
    if (!l.grants?.length || typeof l.to !== "string") continue;
    const kind = kindOf(spec, l.to), ident = identityOf(spec, l.from);
    if (!kind || !ident) { unsupported.push(`권한 렌더 미지원: ${l.from}→${l.to} grants 대상이 데이터 자원·신원이 아님`); continue; }
    for (const g of l.grants) {
      if (g.conditions) { unsupported.push(`권한 렌더 미지원: ${l.from}→${l.to} 조건 붙은 권한 (사람이 도착 조건으로 다시 써야 함)`); continue; }
      const miss = g.actions.filter((a) => !GCP_ROLE[kind][a]);
      // TODO(human): 대응표 밖 AWS 동작 → GCP 역할. 지어내지 않고 block
      if (miss.length) { unsupported.push(`권한 렌더 미지원: ${l.from}→${l.to} GCP 대응 역할 없음 ${miss.join(",")}`); continue; }
      // 같은 범위(scope) 안에서는 가장 높은 단계 역할 하나 (보기+쓰기 → 쓰기 역할이 보기를 포함)
      const best = new Map<string, [string, number, GcpGrantBinding["scope"]]>();
      for (const a of g.actions) { const r = GCP_ROLE[kind][a]!; const cur = best.get(r[2]); if (!cur || r[1] > cur[1]) best.set(r[2], r); }
      for (const [role, level, scope] of best.values())
        bind(ident.id, { kind: kind as GcpGrantBinding["kind"], target: l.to, role, scope }, level);
    }
  }
  for (const p of spec.posture.permissions) {
    const ident = identityOf(spec, p.subject);
    const where = `기준선 ${p.subject} ${p.effect} ${p.actions.join(",") || "(NotAction)"}`;
    if (!ident) { unsupported.push(`권한 렌더 미지원: ${where} — 신원 없는 주체`); continue; }
    if (p.notActions?.length || p.notResources?.length || p.conditions) { unsupported.push(`권한 렌더 미지원: ${where} — NotAction/NotResource/조건은 사람이 다시 씀`); continue; }
    if (p.effect === "Allow") {
      // TODO(human): 계정 단위 동작(ListAllMyBuckets 등)·IR 밖 자원 → GCP 프로젝트 단위 역할로 줄지. 지금은 block
      unsupported.push(`권한 렌더 미지원: ${where} — ${p.resources.includes("*") ? "계정 단위 권한(GCP 프로젝트 역할 필요)" : "IR 밖 자원"}`);
      continue;
    }
    // Deny: GCP 엔 여기서 그리는 거부 정책이 없다. 우리가 주는 역할이 그 동작을 안 포함하면 거부는 저절로 지켜진다 → 겹치면 block
    // TODO(human): 겹칠 때 IAM deny policy(조직·프로젝트 단위)를 쓸지
    warnings.push(`${where}: GCP 는 역할을 안 줘서 지킴 (거부 정책 따로 안 그림)`);
  }
  // Deny 겹침 검사는 바인딩을 다 모은 뒤 (순서와 무관하게 같은 결과)
  for (const p of spec.posture.permissions) {
    if (p.effect !== "Deny" || p.notActions?.length || p.notResources?.length || p.conditions) continue;
    const ident = identityOf(spec, p.subject);
    if (!ident) continue;
    const binds = [...(by.get(ident.id)?.values() ?? [])];
    for (const a of p.actions) {
      const k = serviceKind(a);
      const hit = k && binds.find((b) => b.kind === k && (p.resources.includes("*") || (p.covers ?? []).includes(b.target)) && b.level >= levelOfDenied(k, a));
      if (hit) unsupported.push(`권한 렌더 미지원: 기준선 ${p.subject} Deny ${a} 가 줄 역할 ${hit.role}(${hit.target}) 과 겹침`);
    }
  }
  const byIdentity = Object.fromEntries([...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) =>
    [id, [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, { level: _l, ...b }]) => b)]));
  return { byIdentity, unsupported: sortStr(unsupported), warnings: sortStr(warnings) };
}

/** 도착별 권한 렌더 막힘 (precheck block · Builder UNSUPPORTED_V2 가 같은 목록을 쓴다) */
export function grantBlockers(provider: Provider, spec: AppSpecV2): string[] {
  if (provider === "aws") return awsGrantPlan(spec).unsupported;
  if (provider === "gcp") return gcpGrantPlan(spec).unsupported;
  return [];   // onprem: STUB(검토 표시만) · azure_mock: 가짜
}

/** 도착별 권한 렌더 경고 (precheck warn) */
export function grantWarnings(provider: Provider, spec: AppSpecV2): string[] {
  const has = spec.links.some((l) => l.grants?.length) || spec.posture.permissions.length > 0;
  if (!has) return [];
  if (provider === "aws")
    // TODO(human): 앱 역할 권한 경계(infra/permissions/aws-app-role-boundary.json)는 플랫폼 시크릿 읽기만 허용 → 경계를 넓히기 전엔 그린 권한이 실제로는 안 먹힘
    return [...awsGrantPlan(spec).warnings, "앱 역할 권한 경계가 시크릿 읽기만 허용 — 경계를 넓히기 전엔 옮긴 권한이 실제로 막힘 (사람 결정)"];
  if (provider === "gcp") return gcpGrantPlan(spec).warnings;
  // STUB: 온프레엔 클라우드 IAM 이 없다. k8s ServiceAccount 만 만들고 권한은 클러스터 안 대체물(TA12)을 고를 때 사람이 정함
  if (provider === "onprem") return ["온프레 도착: 출발 IAM 권한은 옮기지 않음 (k8s ServiceAccount 만) — 사람이 검토"];
  return ["azure_mock 도착: 권한은 가짜(역할 할당 모양만)"];
}

/** Builder 쪽: precheck 가 막는 것과 같은 목록이면 던진다 (계획 단계에 오면 이미 precheck 를 지났어야 함) */
export function assertGrants(provider: Provider, spec: AppSpecV2): void {
  const u = grantBlockers(provider, spec);
  if (u.length) throw new AdapterError(UNSUPPORTED_V2, u.join("; "));
}
/** 신원 행에 붙일 grants_json (없으면 칸 자체를 안 넣음 → 깃발 off·권한 없는 명세는 지금과 글자 하나까지 같음) */
export function grantsJsonFor(provider: "aws" | "gcp", spec: AppSpecV2, identityId: string): { grants_json?: string } {
  const plan = provider === "aws" ? awsGrantPlan(spec) : gcpGrantPlan(spec);
  const rows = (plan.byIdentity as Record<string, unknown[]>)[identityId];
  return rows?.length ? { grants_json: JSON.stringify(rows) } : {};
}
