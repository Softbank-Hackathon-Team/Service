// REALECS 대조 (상태: AI 초안). 진짜 계정의 ECS Fargate 서비스에서 가져온 IR v2(GET /migrations/:id/spec 응답)가 기대대로인지 PASS/FAIL 표로.
// 사용 (worktree 안 .real/ 로 복사해서): npx tsx .real/ecs-check.ts <spec.json> [비밀 값 파일] [서비스 이름(기본 realecs-src-api)]
//   기대값 = infra/modules/aws/ecs-source 가 만드는 값 (min 1·max 2, CPU 60%, 작업 역할 realecs-src-task, 포트 5678, 환경변수 LOG_LEVEL=info)
//   비밀 값 파일이 있으면 그 글자가 명세에 없어야 PASS. 값은 출력하지 않는다. 클라우드 호출 0
import { readFileSync } from "node:fs";
import { AppSpecV2, FieldMetaV2 } from "@svc/contracts";

export interface Row { item: string; result: "PASS" | "FAIL" | "INFO"; note: string }
export interface EcsExpect { service: string; replicas?: { min: number; max: number }; targetCpuPct?: number; serviceAccount?: string; port?: number; plainEnv?: Record<string, string> }
export const FIXTURE: EcsExpect = { service: "realecs-src-api", replicas: { min: 1, max: 2 }, targetCpuPct: 60, serviceAccount: "realecs-src-task", port: 5678, plainEnv: { LOG_LEVEL: "info" } };

export function checkEcs(view: { specV2?: unknown; fieldMetaV2?: unknown }, e: EcsExpect, secretValue?: string): Row[] {
  const rows: Row[] = [];
  const ok = (item: string, cond: boolean, note: string) => rows.push({ item, result: cond ? "PASS" : "FAIL", note });
  const parsed = AppSpecV2.safeParse(view.specV2);
  ok("spec_v2 모양 (AppSpecV2)", parsed.success, parsed.success ? "통과" : parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (!parsed.success) return rows;
  const s = parsed.data;
  const meta = FieldMetaV2.safeParse(view.fieldMetaV2 ?? {});
  ok("field_meta 모양 (FieldMetaV2)", meta.success, meta.success ? `${Object.keys(meta.data).length}칸` : "모양 다름");
  const c = s.components.find((x) => x.kind === "service" && x.id === e.service);
  ok(`서비스 ${e.service} 가 리소스에 있다`, !!c, c ? "있음" : `없음 (있는 것: ${s.components.map((x) => `${x.kind}:${x.id}`).join(", ") || "-"})`);
  if (!c || c.kind !== "service") return rows;
  const p = c.props;
  ok("실행 방식 runtime = managedContainer", p.runtime === "managedContainer", String(p.runtime));
  ok("출발 상품 origin.product = ecs", p.origin?.runtime === "managedContainer" && p.origin?.product === "ecs", JSON.stringify(p.origin ?? null));
  ok("이미지 digest (sha256 고정)", /^sha256:[0-9a-f]{64}$/.test(p.image.digest ?? ""), `${(p.image.digest ?? "없음").slice(0, 19)}…`);
  if (e.replicas) ok(`복제 수 min ${e.replicas.min}·max ${e.replicas.max} (Auto Scaling)`, p.replicas?.min === e.replicas.min && p.replicas?.max === e.replicas.max, JSON.stringify(p.replicas ?? null));
  if (e.targetCpuPct != null) ok(`CPU 목표 ${e.targetCpuPct}%`, p.scale?.targetCpuPct === e.targetCpuPct, JSON.stringify(p.scale ?? null));
  if (e.serviceAccount) ok(`작업 역할 → serviceAccount ${e.serviceAccount}`, p.serviceAccount === e.serviceAccount, String(p.serviceAccount));
  if (e.port != null) ok(`포트 ${e.port}`, (p.ports ?? []).some((x) => x.port === e.port), JSON.stringify(p.ports ?? []));
  for (const [k, v] of Object.entries(e.plainEnv ?? {})) {
    const ev = p.env.find((x) => x.name === k);
    ok(`환경변수 ${k}=${v} (비밀 아님, 그대로)`, !!ev && "value" in ev && ev.value === v, ev ? JSON.stringify(ev) : "없음");
  }
  const all = JSON.stringify(view);
  if (secretValue) ok("비밀 값은 명세·field_meta 어디에도 없음", !all.includes(secretValue), all.includes(secretValue) ? "값이 들어감 (유출)" : "값 0");
  else rows.push({ item: "비밀 값 0 확인", result: "INFO", note: "비밀 값 파일 없음 → 건너뜀 (샘플은 비밀 0)" });
  // ECR 주소(<12자리>.dkr.ecr…)에는 계정 ID 가 있을 수 있다 → 명세에서는 정상. 결과 파일에 옮길 때 mask 를 거치게 알림만 (FAIL 아님)
  const hasAcct = /(^|[^0-9])\d{12}([^0-9]|$)/.test(all.replace(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}/g, ""));
  rows.push({ item: "계정 ID(12자리) 흔적", result: "INFO", note: hasAcct ? "명세에 있음(ECR 주소 등): 결과 파일은 mask 를 통과해야 함" : "없음" });
  return rows;
}

export function toMd(rows: Row[]): string {
  return ["| 항목 | 결과 | 비고 |", "|---|---|---|", ...rows.map((r) => `| ${r.item} | ${r.result} | ${r.note.replace(/\|/g, "/")} |`)].join("\n");
}

if (process.argv[1]?.endsWith("ecs-check.ts") && process.argv[2]) {
  const view = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const sec = process.argv[3] && process.argv[3] !== "-" ? readFileSync(process.argv[3], "utf8").trim() : undefined;
  const rows = checkEcs(view, { ...FIXTURE, service: process.argv[4] || FIXTURE.service }, sec);
  console.log(toMd(rows));
  process.exit(rows.some((r) => r.result === "FAIL") ? 1 : 0);
}
