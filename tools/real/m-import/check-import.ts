// M-import 대조 (상태: AI 초안). 실제 k3d 에서 가져온 IR v2(GET /migrations/:id/spec 응답)가 샘플 3티어 규칙대로 매핑됐는지 PASS/FAIL 표로.
// 사용 (worktree 안 .m-import/ 로 복사해서): npx tsx .m-import/check-import.ts <spec.json> <namespace> [secret 값 파일] [web digest] [api digest]
//   비밀 값 파일 = 실행 때 만든 API_TOKEN (명세 어디에도 이 글자가 없어야 PASS). 값은 출력하지 않는다
import { readFileSync } from "node:fs";
import { AppSpecV2, FieldMetaV2 } from "@svc/contracts";

export interface Row { item: string; result: "PASS" | "FAIL" | "INFO"; note: string }
export interface CheckOpts { namespace: string; secretValue?: string; digests?: { web?: string; api?: string } }
// 샘플 매니페스트(sample-3tier.yaml.tpl)와 같은 이름·값
export const SAMPLE = { web: "shop-web", api: "shop-api", db: "shop-db", config: "api-config", configKey: "LOG_LEVEL",
  configValue: "m-import-cfg-value-7", secret: "api-secrets", secretKey: "API_TOKEN", pgMajor: "16", pgStorageGb: 1 } as const;

type Spec = ReturnType<typeof AppSpecV2.parse>;
type Comp = Spec["components"][number];
const svc = (s: Spec, id: string) => s.components.find((c): c is Extract<Comp, { kind: "service" }> => c.id === id && c.kind === "service");

export function checkImport(view: { specV2?: unknown; fieldMetaV2?: unknown }, o: CheckOpts): Row[] {
  const rows: Row[] = [];
  const ok = (item: string, cond: boolean, note: string) => rows.push({ item, result: cond ? "PASS" : "FAIL", note });
  const parsed = AppSpecV2.safeParse(view.specV2);
  ok("spec_v2 모양 (AppSpecV2)", parsed.success, parsed.success ? "통과" : parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (!parsed.success) return rows;
  const s = parsed.data;
  const meta = FieldMetaV2.safeParse(view.fieldMetaV2 ?? {});
  ok("field_meta 모양 (FieldMetaV2)", meta.success, meta.success ? `${Object.keys(meta.data).length}칸` : "모양 다름");

  // 1) 워크로드·DB
  const kinds = s.components.map((c) => `${c.kind}:${c.id}`).sort();
  ok("리소스 3개 (web·api 서비스 + db postgres)", JSON.stringify(kinds) === JSON.stringify([`postgres:${SAMPLE.db}`, `service:${SAMPLE.api}`, `service:${SAMPLE.web}`]), kinds.join(", "));
  const web = svc(s, SAMPLE.web), api = svc(s, SAMPLE.api);
  const pg = s.components.find((c) => c.id === SAMPLE.db && c.kind === "postgres");
  ok("실행 방식 = k8s (출발과 같음)", !!web && !!api && web.props.runtime === "k8s" && api.props.runtime === "k8s",
    `${web?.props.runtime ?? "-"} / ${api?.props.runtime ?? "-"}`);
  ok("출발 네임스페이스", !!web && !!api && web.props.namespace === o.namespace && api.props.namespace === o.namespace, `${web?.props.namespace ?? "-"}`);
  // 2) Service → endpoints
  const ep = (x?: typeof web) => (x?.props.endpoints ?? []).map((e) => `${e.name}:${e.ports.map((p) => `${p.port}->${p.targetPort}`).join("|")}`).join(",");
  ok("k8s Service → endpoints (web 80->80, api 80->8080)", ep(web) === "shop-web:80->80" && ep(api) === "shop-api:80->8080", `web ${ep(web) || "-"} / api ${ep(api) || "-"}`);
  // 3) 이미지 digest
  const dg = (x?: typeof web) => x?.props.image.digest ?? null;
  const want = (k: "web" | "api", got: string | null) => !o.digests?.[k] || o.digests[k] === got;
  ok("이미지 digest (web·api, sha256 고정)", /^sha256:[0-9a-f]{64}$/.test(dg(web) ?? "") && /^sha256:[0-9a-f]{64}$/.test(dg(api) ?? "")
    && want("web", dg(web)) && want("api", dg(api)), `web ${(dg(web) ?? "없음").slice(0, 19)}… / api ${(dg(api) ?? "없음").slice(0, 19)}…`);
  // 4) ConfigMap: 참조만 (값은 안 읽음 — 리더가 키 이름만 남김)
  const env = api?.props.env ?? [];
  const cfg = env.find((e) => e.name === SAMPLE.configKey);
  ok("ConfigMap 참조 (api LOG_LEVEL ← api-config/LOG_LEVEL)", !!cfg && "fromConfig" in cfg && cfg.fromConfig.config === SAMPLE.config && cfg.fromConfig.key === SAMPLE.configKey,
    cfg ? JSON.stringify(cfg) : "없음");
  const all = JSON.stringify(view);
  // FM-OPS-10: N12 부터 ConfigMap 값은 그대로 이식하려고 components.<서비스>.props.configs[].data 로 옮긴다 (비밀이 아님). 옛 기대 "값 없음" 은 거짓 FAIL
  const cms = Object.values(s.components).flatMap((c) => ("configs" in c.props && Array.isArray(c.props.configs) ? c.props.configs : []) as Array<{ name: string; data: Record<string, string> }>);
  const cm = cms.find((c) => c.name === SAMPLE.config);
  ok("ConfigMap 값은 그대로 옮김 (props.configs[api-config].data, N12)", !!cm && cm.data[SAMPLE.configKey] === SAMPLE.configValue,
    cm ? `키 ${Object.keys(cm.data).join(",")}` : "configs 에 api-config 없음");
  // 5) Secret: 참조만, 값 0
  const sec = env.find((e) => e.name === SAMPLE.secretKey);
  ok("Secret 참조 (api API_TOKEN ← api-secrets/API_TOKEN)", !!sec && "fromSecret" in sec && sec.fromSecret.secret === SAMPLE.secret && sec.fromSecret.key === SAMPLE.secretKey,
    sec ? JSON.stringify(sec) : "없음");
  const dbp = env.find((e) => e.name === "DB_PASSWORD");
  ok("CNPG 비밀 참조 (DB_PASSWORD ← shop-db-app/password)", !!dbp && "fromSecret" in dbp && dbp.fromSecret.secret === "shop-db-app", dbp ? JSON.stringify(dbp) : "없음");
  if (o.secretValue) ok("Secret 값은 명세·field_meta 어디에도 없음", !all.includes(o.secretValue), all.includes(o.secretValue) ? "값이 들어감 (유출)" : "값 0");
  else rows.push({ item: "Secret 값 0 확인", result: "INFO", note: "비밀 값 파일 없음 → 건너뜀" });
  // 6) 의존성
  const links = s.links.map((l) => `${l.from}->${typeof l.to === "string" ? l.to : JSON.stringify(l.to)}:${l.intent}`).sort();
  ok("DB 링크 api → db (connect)", links.includes(`${SAMPLE.api}->${SAMPLE.db}:connect`), links.join(", ") || "링크 없음");
  ok("서비스 링크 web → api (call)", links.includes(`${SAMPLE.web}->${SAMPLE.api}:call`), links.join(", ") || "링크 없음");
  const dbHost = env.find((e) => e.name === "DB_HOST");
  ok("DB 주소 env → 링크 출력 (값 박지 않음)", !!dbHost && ("fromLink" in dbHost || "template" in dbHost), dbHost ? JSON.stringify(dbHost) : "없음");
  // 7) DB 칸
  ok(`postgres 버전 ${SAMPLE.pgMajor}·용량 ${SAMPLE.pgStorageGb}GB·인스턴스 1`, !!pg && pg.kind === "postgres" && pg.props.majorVersion === SAMPLE.pgMajor
    && pg.props.storageGb === SAMPLE.pgStorageGb, pg && pg.kind === "postgres" ? `v${pg.props.majorVersion} ${pg.props.storageGb}GB ha=${pg.props.ha}` : "없음");
  // 8) 자원 요청량·포트·확인
  ok("요청량·포트·readiness (api 100m/64Mi, 8080, http /)", !!api && api.props.resources.request?.cpuMilli === 100 && api.props.resources.request?.memMiB === 64
    && api.props.ports?.[0]?.port === 8080 && api.props.probes?.readiness?.type === "http", api ? JSON.stringify({ r: api.props.resources, p: api.props.ports, pr: api.props.probes }) : "없음");
  ok("서비스 계정 (api = shop-api, web = default)", api?.props.serviceAccount === "shop-api" && web?.props.serviceAccount === "default", `${api?.props.serviceAccount} / ${web?.props.serviceAccount}`);

  // 9) 신뢰도 표 (막지 않음): 1 미만·검토 필요 칸
  if (meta.success) {
    const low = Object.entries(meta.data).filter(([, v]) => (v as { confidence?: number }).confidence !== undefined && (v as { confidence: number }).confidence < 1 || (v as { needs_review?: boolean }).needs_review)
      .map(([k, v]) => `${k}=${(v as { confidence?: number }).confidence ?? "-"}${(v as { needs_review?: boolean }).needs_review ? "(검토)" : ""}`).sort();
    rows.push({ item: "신뢰도 1 미만·검토 칸", result: "INFO", note: low.length ? low.join("; ").slice(0, 600) : "없음" });
  }
  return rows;
}

export const toMarkdown = (rows: Row[]) => ["| 대조 | 결과 | 비고 |", "|---|---|---|",
  ...rows.map((r) => `| ${r.item} | ${r.result} | ${r.note.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`)].join("\n");

if (process.argv[1]?.endsWith("check-import.ts")) {
  const [file, ns, secretFile, webD, apiD] = process.argv.slice(2);
  if (!file || !ns) { console.error("사용: check-import.ts <spec.json> <namespace> [secret 값 파일] [web digest] [api digest]"); process.exit(2); }
  const view = JSON.parse(readFileSync(file, "utf8"));
  const secretValue = secretFile ? readFileSync(secretFile, "utf8").trim() : undefined;
  const rows = checkImport(view, { namespace: ns, secretValue, digests: { web: webD || undefined, api: apiD || undefined } });
  console.log(toMarkdown(rows));
  process.exit(rows.some((r) => r.result === "FAIL") ? 1 : 0);
}
