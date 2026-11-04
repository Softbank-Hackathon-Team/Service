import { AppSpecV2, checkV2, hasRedactionPlaceholder, type FieldMetaV2 } from "@svc/contracts";
import type { MigrationRisk } from "./contracts.js";

// 에이전트가 낸 명세를 그대로 믿지 않는다. 규칙 기반 명세(baseline)와 칸 단위로 비교해
//  - 리소스를 더하거나 빼거나 종류를 바꾸면 되돌리고 (원본에 없는 자원을 지어내지 않음, 있던 자원은 그대로 옮김)
//  - AI 가 고쳐도 되는 칸(AI_EDITABLE) 밖이거나, 원본에서 정확히 읽은 칸(confidence 1, 검토 필요 아님)은 원본 값으로 되돌리고
//  - 나머지 바뀐 칸은 출처 ai, 믿음 0.6, 검토 필요로 표시한다.
// 칸 단위 = components.<id>.<props 맨 위 칸> + 맨 위 칸(schemaVersion·app·availability·links·entry·posture·security·secrets)
// DRAFT(ai): AI 가 고칠 수 있는 칸은 "출발에서 못 읽었거나 어림한 크기·개수·검사" 뿐이다. 이미지·환경변수·비밀·설정·볼륨·배치·
//   의존성·라우팅·보안 기준선은 출발 값만 쓴다 (주입·유출 방지 + 그대로 이식). 목록 밖 새 칸은 기본으로 잠긴다
export const AI_EDITABLE = new Set(["resources", "probes", "replicas", "scale", "ports",
  "majorVersion", "storageGb", "storageMaxGb", "compute", "memoryMiB", "sizeGb"]);
// T1·SC-1: 비밀 표(secrets)도 잠김 (출발 값). 빠지면 AI 초안 판에서 비밀 표가 사라졌다
export const TOP_FIELDS = ["schemaVersion", "app", "availability", "links", "entry", "posture", "security", "secrets"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Comp = { id: string; kind: string; props: Record<string, unknown> };
const issuesOf = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.slice(0, 10).map((x) => `${x.path.map(String).join(".")}: ${x.message}`);

export interface GuardOut {
  ok: boolean;
  spec?: AppSpecV2;
  fieldMeta?: FieldMetaV2;
  rejected: Array<{ field: string; reason: string }>;
  issues: string[];                // 명세 검사 실패 내용 (ok=false 일 때)
}

export function guardDraft(o: {
  baseline: { spec: AppSpecV2; fieldMeta: FieldMetaV2 };
  candidate: unknown;
  notes: Array<{ field: string; rationale: string }>;
  model: string;
}): GuardOut {
  const parsed = AppSpecV2.safeParse(o.candidate);
  if (!parsed.success) return { ok: false, rejected: [], issues: issuesOf(parsed.error) };
  const base = o.baseline.spec as unknown as Record<string, unknown> & { components: Comp[] };
  const cand = structuredClone(parsed.data) as unknown as Record<string, unknown> & { components: Comp[] };
  const meta = o.baseline.fieldMeta;
  const fieldMeta: FieldMetaV2 = structuredClone(meta);
  const rejected: GuardOut["rejected"] = [];
  const exact = (k: string) => meta[k]?.confidence === 1 && !meta[k]?.needs_review;
  const mark = (k: string) => {
    const note = o.notes.find((n) => n.field === k)?.rationale;
    fieldMeta[k] = { source: `ai:${o.model}`, confidence: 0.6, needs_review: true,
      rationale: (note ?? "에이전트가 바꿈 (이유 없음)").slice(0, 300) };
  };

  // 맨 위 칸: 전부 잠김 (출발 값)
  const out: Record<string, unknown> = {};
  for (const f of TOP_FIELDS) {
    if (base[f] !== undefined) out[f] = structuredClone(base[f]);
    if (!same(cand[f], base[f])) rejected.push({ field: f, reason: "잠긴 칸: 원본 값으로 되돌림" });
  }
  // 리소스: 원본 순서·원본 목록 그대로. 칸별로 AI 값을 받을지 정한다
  const byId = new Map(cand.components.map((c) => [c.id, c]));
  for (const c of cand.components) if (!base.components.some((b) => b.id === c.id))
    rejected.push({ field: `components.${c.id}`, reason: "원본에 없는 자원을 추가할 수 없음" });
  out.components = base.components.map((b) => {
    const a = byId.get(b.id);
    if (!a) { rejected.push({ field: `components.${b.id}`, reason: "원본 자원을 뺄 수 없음: 되돌림" }); return structuredClone(b); }
    if (a.kind !== b.kind) { rejected.push({ field: `components.${b.id}.kind`, reason: "종류를 바꿀 수 없음: 되돌림" }); return structuredClone(b); }
    const props: Record<string, unknown> = {};
    for (const k of [...new Set([...Object.keys(b.props), ...Object.keys(a.props)])]) {
      const key = `components.${b.id}.${k}`;
      if (same(a.props[k], b.props[k])) { if (b.props[k] !== undefined) props[k] = structuredClone(b.props[k]); continue; }
      if (!AI_EDITABLE.has(k) || exact(key)) {
        if (b.props[k] !== undefined) props[k] = structuredClone(b.props[k]);
        rejected.push({ field: key, reason: "잠긴 칸: 원본 값으로 되돌림" }); continue;
      }
      // LLM-1: 에이전트는 가린 글을 본다. 가린 자리 표시를 베껴 쓴 값은 원래 값이 아니다 → 원본 값으로 되돌림(원본에 없으면 뺌)
      if (a.props[k] !== undefined && hasRedactionPlaceholder(JSON.stringify(a.props[k]))) {
        if (b.props[k] !== undefined) props[k] = structuredClone(b.props[k]);
        rejected.push({ field: key, reason: "가린 값 자리 표시를 베낌: 원본 값으로 되돌림" }); continue;
      }
      // 여기까지 오면 원본에서 못 읽었거나 검토 필요였던 크기·개수 칸이다. AI 값을 쓰되 반드시 사람 검토
      if (a.props[k] !== undefined) props[k] = structuredClone(a.props[k]);
      mark(key);
    }
    return { id: b.id, kind: b.kind, props };
  });
  // 되돌린 뒤에도 명세 모양·의미가 맞는지 다시 확인한다
  const final = AppSpecV2.safeParse(out);
  if (!final.success) return { ok: false, rejected, issues: issuesOf(final.error) };
  const errs = checkV2(final.data).errors;
  if (errs.length) return { ok: false, rejected, issues: errs.slice(0, 10) };
  return { ok: true, spec: final.data, fieldMeta, rejected, issues: [] };
}

// 위험 목록 합치기: 규칙 위험은 항상 남기고, 에이전트 위험은 번호를 새로 매겨 최대 10개 덧붙인다
export function mergeRisks(rule: MigrationRisk[], ai: Array<Omit<MigrationRisk, "id" | "source">>): MigrationRisk[] {
  return [...rule, ...ai.slice(0, 10).map((r, n) => ({ ...r, id: `AI-${String(n + 1).padStart(2, "0")}`, source: "ai" as const }))];
}

// Z3-F2: 모델이 쓴 글(계획 설명·AI 위험·칸 이유)에서 주소를 지운다. 운영자가 읽고 누르는 글이라 피싱 링크가 되기 쉽다.
// 명세 칸은 위 가드가 지키지만 글은 지키는 곳이 없었다. 지운 개수는 rejectedChanges 에 남긴다
// Z72(Z3-F2b): 스킴 없이 도메인만 쓴 글(login.evil.example, evil.example:8443/x, evil[.]example)도 지운다.
//  - 끝 칸(TLD)이 공개 도메인 목록에 있을 때만 주소로 본다 → service.image·pg.schema 같은 칸 이름, 16.4 같은 버전은 안 건드림
//  - 사설 이름(.internal .local .svc .cluster.local .lan .corp .localhost)은 TLD 목록에 없어서 남는다 (설정의 DB 호스트 등)
//  - 클라우드·레지스트리 도메인(amazonaws.com, pkg.dev 등)과 원본 명세에 이미 있던 호스트(allowHosts)는 남긴다
//  - 파일 확장자와 겹치는 TLD(.md .sh .py .tf .rs .pl …)로 끝나는 두 칸 이름은 경로 뒤(scripts/collect.sh, ./main.tf)일 때만
//    파일로 보고 남긴다 (Z71 에서 흔한 파일 이름 허용을 뺐다, 아래)
//  - 전각·반각 마침표(。．｡)도 점으로 본다 (evil。example)
//  - 공인 IPv4(사설·루프백 대역 밖)도 지운다
// Z71(5차): 띄어 쓴 점과 파일 이름처럼 보이는 도메인도 지운다
//  - 점 앞에 빈칸이 있으면("evil . example", "evil .example", "evil [.] example") 빈칸을 빼고 주소로 본다.
//    문장 끝 점은 앞에 빈칸이 없으니("끝. 다음") 건드리지 않는다
//  - 두 칸 파일형 이름(.sh .md .tf .py …)은 경로 뒤(scripts/deploy.sh, ./main.tf)일 때만 파일로 남긴다.
//    맨 이름(deploy.sh, README.md)은 그 자체로 등록 가능한 도메인이라 지운다 (예전 KNOWN_FILE_STEMS 허용은 뺐다)
// DRAFT(ai): 남는 구멍 — 점 뒤에만 빈칸이면서 두 글자 TLD 두 칸("evil. io", 영어 문장 "it. me" 와 구별 못 함)·목록에 없는 새 gTLD.
//   목록은 아래 상수에서 늘린다
const URL_RE = /\b(?:https?|ftp):\/\/[^\s"'<>)\]]+/gi;
const GTLD = ["com", "net", "org", "info", "biz", "io", "ai", "app", "dev", "cloud", "xyz", "top", "site", "online", "store", "shop",
  "tech", "link", "click", "live", "pro", "me", "co", "cc", "tv", "gg", "sh", "ly", "to", "ws", "zip", "mov", "page", "run", "icu",
  "work", "support", "help", "security", "login", "email", "gov", "edu", "mil", "int", "example", "test", "invalid"];
// ISO 3166 2글자 국가 도메인 (전부). 파일 확장자와 겹치는 것은 아래 FILE_LIKE 에서 따로 다룬다
const CCTLD = ("ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz " +
  "de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp " +
  "ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz " +
  "om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz " +
  "ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw").split(" ");
const PUBLIC_TLD = new Set([...GTLD, ...CCTLD]);
const FILE_LIKE = new Set(["md", "sh", "py", "tf", "rs", "pl", "pm", "so", "cs", "ps", "rb", "ts", "js", "go", "kt", "sql", "yml", "yaml", "json", "toml", "ini", "lock", "log"]);   // zip 은 피싱에 쓰이는 gTLD 라 뺐다 (Z38 메모)
// Z38 REVIEW-4 A-1: 누구나 내용을 올릴 수 있는 호스팅 도메인은 뺐다. 예전 목록의 amazonaws.com·googleapis.com·azure.com 은
//   evil-bucket.s3.amazonaws.com/login.html, storage.googleapis.com/<버킷>/approve.html, *.execute-api.*.amazonaws.com 처럼
//   공격자 페이지를 그대로 남겼다. 남기는 것 = 레지스트리·DB 엔드포인트·공식 문서·콘솔처럼 남이 페이지를 못 올리는 곳만
const SAFE_SUFFIX = ["aws.amazon.com", "rds.amazonaws.com", "pkg.dev", "gcr.io", "cloud.google.com", "azurecr.io",
  "docker.io", "ghcr.io", "quay.io", "registry.k8s.io", "k8s.io", "postgresql.org", "cloudflare.com"];
const SAFE_RE = [/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/];   // ECR 레지스트리 (계정 번호.dkr.ecr.리전)
const DOT = String.raw`(?:[.\u3002\uFF0E\uFF61]|\[\.\]|\(\.\)|\[dot\]|\(dot\))`;
const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
// 앞: 영문·숫자·하이픈이 붙어 있지 않고, "칸이름." 바로 뒤도 아님 (service.image 의 image 에서 시작 금지).
//     한글 바로 뒤의 점("끝.evil.example")은 허용한다. 뒤: 선택 포트·경로
const HOST_RE = new RegExp(String.raw`(?<![a-z0-9\-])(?<![a-z0-9\-][.\u3002\uFF0E\uFF61])((?:${LABEL}${DOT})+([a-z]{2,24}))(?![a-z0-9\-])(?::\d{1,5})?(?:/[^\s"'<>)\]]*)?`, "gi");
// Z71: 점 앞에 빈칸이 있는 주소. 빈칸은 탭·스페이스만 (줄바꿈 넘어서는 안 묶는다)
const SPACED_RE = new RegExp(String.raw`(?<![a-z0-9\-])(${LABEL}(?:[ \t]*${DOT}[ \t]*${LABEL})+)(?![a-z0-9\-])(?:[ \t]*:\d{1,5})?(?:/[^\s"'<>)\]]*)?`, "gi");
const SPACE_BEFORE_DOT = new RegExp(String.raw`[ \t]+${DOT}`, "i");
// Z71 v2: 점 뒤에만 빈칸("evil. example")은 문장 끝 점과 모양이 같다. 셋을 다 만족할 때만 주소로 본다
//  (1) 점 뒤 칸이 모두 소문자로 시작 (문장은 대문자·한글로 시작: "이미지. App")
//  (2) 끝 칸(TLD)이 3글자 이상이거나 칸이 3개 이상 ("it. me too" 같은 두 글자 영단어 TLD 는 남김)
//  (3) 빈칸을 뺀 이름이 기존 주소 검사(isSuspectHost)에 걸림
const SPACE_AFTER_DOT = new RegExp(String.raw`${DOT}[ \t]+`, "gi");
function spacedAfterOnly(raw: string): boolean {
  const parts = raw.split(SPACE_AFTER_DOT);
  if (parts.length < 2 || !parts.slice(1).every((x) => /^[a-z0-9]/.test(x))) return false;
  const labels = normHost(raw.replace(/[ \t]+/g, "")).split(".");
  return labels[labels.length - 1]!.length >= 3 || labels.length >= 3;
}
const IPV4_RE = /(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])(?::\d{1,5})?(?:\/[^\s"'<>)\]]*)?/g;
const normHost = (h: string) => h.toLowerCase().replace(new RegExp(DOT, "gi"), ".");
function isPrivateIp(ip: string) {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
/** 글에서 지울 호스트인지. 사설 이름·칸 이름·버전·파일 이름·허용 목록이면 false */
export function isSuspectHost(raw: string, allowHosts: ReadonlySet<string> = new Set(), afterPath = false): boolean {
  const host = normHost(raw);
  const labels = host.split(".");
  const tld = labels[labels.length - 1]!;
  if (!PUBLIC_TLD.has(tld)) return false;
  if (labels.length === 2 && FILE_LIKE.has(tld) && afterPath) return false;   // 경로 뒤 파일 이름만 (Z71)
  if (allowHosts.has(host)) return false;
  if (SAFE_SUFFIX.some((x) => host === x || host.endsWith(`.${x}`)) || SAFE_RE.some((r) => r.test(host))) return false;
  return true;
}
export function sanitizeText(t: string, allowHosts: ReadonlySet<string> = new Set()): { text: string; removed: number } {
  let removed = 0;
  const gone = () => { removed++; return "[주소 지움]"; };
  const allow = new Set([...allowHosts].map(normHost));
  const text = t.replace(URL_RE, gone)
    .replace(SPACED_RE, (m, host: string, at: number, all: string) =>
      ((SPACE_BEFORE_DOT.test(host) || spacedAfterOnly(host)) && isSuspectHost(host.replace(/[ \t]+/g, ""), allow, all[at - 1] === "/") ? gone() : m))
    .replace(HOST_RE, (m, host: string, _tld: string, at: number, all: string) => (isSuspectHost(host, allow, all[at - 1] === "/") ? gone() : m))
    .replace(IPV4_RE, (m, ip: string) => (isPrivateIp(ip) || allow.has(ip) ? m : gone()))
    .replace(/\[REDACTED\]/g, () => { removed++; return "[가린 값]"; });
  return { text, removed };
}

/** 원본 명세에서 글에 적어도 되는 호스트(이미 사람이 운영하는 이름)를 모은다: 입구 호스트 이름, 이미지 레지스트리 호스트.
 *  환경변수 값은 넣지 않는다 (주입 문장이 들어올 수 있는 자리라서, S13) */
export function baselineHosts(spec: AppSpecV2): Set<string> {
  const out = new Set<string>();
  for (const h of spec.entry?.hosts ?? []) for (const n of h.hostnames) if (n) out.add(n.toLowerCase());
  const reg = (repo: string | undefined) => {
    if (!repo || !repo.includes("/")) return;
    const r = repo.split("/")[0]!;
    if (r.includes(".")) out.add(r.toLowerCase().replace(/:\d+$/, ""));
  };
  for (const c of spec.components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    reg(c.props.image.repository);
    for (const x of [...(c.props.sidecars ?? []), ...(c.props.initContainers ?? [])]) reg(x.image.repository);
  }
  return out;
}
