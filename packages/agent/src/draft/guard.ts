import { AppSpec, type FieldMeta } from "@svc/contracts";
import { DRAFT_MARKER_KEY, type MigrationRisk } from "./contracts.js";

// 에이전트가 낸 명세를 그대로 믿지 않는다. 규칙 기반 v1과 칸 단위로 비교해
//  - 잠긴 칸(원본에서 정확히 읽은 칸, 공급망·비밀·주소 칸)은 바꿔도 v1 값으로 되돌리고
//  - 원본에 없던 DB를 지어내면 되돌리고
//  - 나머지 바뀐 칸은 출처 ai, 믿음 0.6, 검토 필요로 표시한다.
// DRAFT(ai): 항상 잠그는 칸 목록. 이미지(digest)·환경변수·비밀 참조·호스트 이름은 원본 값만 쓴다 (주입·유출 방지)
export const ALWAYS_LOCKED = new Set(["schemaVersion", "service.image", "service.env", "service.secretRefs", "ingress.hostname", "ingress.entry"]);
export const FIELDS = [
  "schemaVersion", "app.name", "service.image", "service.port", "service.healthPath", "service.replicas",
  "service.cpu", "service.memory", "service.env", "service.secretRefs", "database", "ingress.hostname", "ingress.entry",
] as const;

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
function set(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) { cur[k] ??= {}; cur = cur[k] as Record<string, unknown>; }
  const last = ks[ks.length - 1]!;
  if (v === undefined) delete cur[last]; else cur[last] = v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface GuardOut {
  ok: boolean;
  spec?: AppSpec;
  fieldMeta?: FieldMeta;
  rejected: Array<{ field: string; reason: string }>;
  issues: string[];                // AppSpec 검사 실패 내용 (ok=false 일 때)
}

export function guardDraft(o: {
  baseline: { spec: Partial<AppSpec>; fieldMeta: FieldMeta };
  candidate: unknown;
  notes: Array<{ field: string; rationale: string }>;
  model: string;
}): GuardOut {
  const parsed = AppSpec.safeParse(o.candidate);
  if (!parsed.success) {
    return { ok: false, rejected: [], issues: parsed.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`) };
  }
  const base = o.baseline.spec as Record<string, unknown>;
  const meta = o.baseline.fieldMeta;
  const out = structuredClone(parsed.data) as unknown as Record<string, unknown>;
  const fieldMeta: FieldMeta = structuredClone(meta);
  const rejected: GuardOut["rejected"] = [];
  const locked = (f: string) => ALWAYS_LOCKED.has(f) || (meta[f]?.confidence === 1 && !meta[f]?.needs_review);

  for (const f of FIELDS) {
    const b = get(base, f), a = get(out, f);
    if (same(a, b)) continue;
    if (b !== undefined && locked(f)) {
      set(out, f, structuredClone(b)); rejected.push({ field: f, reason: "잠긴 칸: 원본 값으로 되돌림" }); continue;
    }
    if (f === "database" && b === undefined) {
      set(out, f, undefined); rejected.push({ field: f, reason: "원본에 없는 DB를 추가할 수 없음" }); continue;
    }
    // 여기까지 오면 v1이 비었거나 검토 필요였던 칸이다. AI 값을 쓰되 반드시 사람 검토
    const note = o.notes.find((n) => n.field === f)?.rationale;
    fieldMeta[f] = { source: `ai:${o.model}`, confidence: 0.6, needs_review: true,
      rationale: (note ?? "에이전트가 바꿈 (이유 없음)").slice(0, 300) };
  }
  // 되돌린 뒤에도 명세 모양이 맞는지 다시 확인한다
  const final = AppSpec.safeParse(out);
  if (!final.success) {
    return { ok: false, rejected, issues: final.error.issues.slice(0, 10).map((x) => `${x.path.join(".")}: ${x.message}`) };
  }
  fieldMeta[DRAFT_MARKER_KEY] = { source: `ai:${o.model}`, confidence: 0.6, needs_review: true,
    rationale: "DRAFT(ai) 에이전트 초안 판. 사람이 검토·승인하기 전에는 계획에 쓰지 않는다" };
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
//  - 클라우드·레지스트리 도메인(amazonaws.com, pkg.dev 등)과 원본 v1 명세에 이미 있던 호스트(allowHosts)는 남긴다
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

/** 원본 v1 명세에서 글에 적어도 되는 호스트(이미 사람이 운영하는 이름)를 모은다: ingress.hostname, 이미지 레지스트리 호스트.
 *  환경변수 값은 넣지 않는다 (주입 문장이 들어올 수 있는 자리라서, S13) */
export function baselineHosts(spec: Partial<AppSpec>): Set<string> {
  const out = new Set<string>();
  const h = (spec as { ingress?: { hostname?: unknown } }).ingress?.hostname;
  if (typeof h === "string" && h) out.add(h.toLowerCase());
  const img = (spec as { service?: { image?: unknown } }).service?.image;
  if (typeof img === "string" && img.includes("/")) { const reg = img.split("/")[0]!; if (reg.includes(".")) out.add(reg.toLowerCase().replace(/:\d+$/, "")); }
  return out;
}
