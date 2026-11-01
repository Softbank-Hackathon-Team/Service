import type { MigrationRisk, SpecDraftInput } from "./contracts.js";

// 규칙으로 찾는 이전 위험. 같은 입력이면 같은 결과(순수 함수). 에이전트는 이 목록을 지울 수 없고 덧붙이기만 한다.
// DRAFT(ai): 규칙 9개와 등급은 설계 문서(이전 계획·컷오버 v1, 보안 v1)를 읽고 AI가 고른 초안. 팀 검토 대상
type Item = { kind?: string; [k: string]: unknown };
// Z3-F4: pg.schema 는 옮길 자원이 아니라 DB 안 표 요약이다 (RISK-08 에서 빼고 RISK-11 이 본다)
const KNOWN_KINDS = new Set(["ecs.service", "k8s.deployment", "rds.dbInstance", "cloudsql.instance", "cnpg.cluster", "pg.schema"]);

export function ruleRisks(i: SpecDraftInput): MigrationRisk[] {
  const out: Omit<MigrationRisk, "source">[] = [];  // 번호는 규칙마다 고정
  const spec = i.baseline.spec;
  const meta = i.baseline.fieldMeta;
  const items = i.inventory.items as Item[];

  const review = Object.entries(meta).filter(([k, m]) => m.needs_review && !k.startsWith("_")).map(([k]) => k);
  if (review.length) out.push({ id: "RISK-01", level: "medium", title: `확인이 필요한 명세 칸 ${review.length}개`,
    detail: `원본에서 정확히 옮기지 못한 칸: ${review.join(", ")}`, field: review[0],
    mitigation: "명세 검토 화면에서 값 확인 후 승인" });

  const db = items.find((x) => x.kind === "rds.dbInstance") as { AllocatedStorage?: number } | undefined;
  if (db?.AllocatedStorage && db.AllocatedStorage > 100) out.push({ id: "RISK-02", level: "high", title: "DB 용량이 명세 상한(100GB)을 넘음",
    detail: `원본 ${db.AllocatedStorage}GB, 명세는 100GB로 잘림. 복제 중 공간 부족 가능`, field: "database.storageGb",
    mitigation: "명세 상한을 올리거나 도착 DB를 수동으로 키움" });

  if (spec.database) {
    const cap = `db.postgres.${spec.database.majorVersion}`;
    if (!i.target.capabilities.includes(cap)) out.push({ id: "RISK-03", level: "high", title: `도착 환경이 Postgres ${spec.database.majorVersion}을 지원하지 않음`,
      detail: `도착 어댑터 능력 목록에 ${cap} 없음. 논리 복제는 같은 메이저 버전 기준으로 검증했다`, field: "database.majorVersion",
      mitigation: "지원 버전으로 올린 뒤 복제 시험" });
    out.push({ id: "RISK-04", level: "medium", title: "DB 컷오버 순간 쓰기 멈춤",
      detail: "논리 복제 뒤 컷오버 때 쓰기를 잠깐 막는다 (측정 중앙값 62ms, 로컬 Postgres 2대 기준)", field: "database",
      mitigation: "쓰기가 적은 시간대에 컷오버, 롤백 창 유지" });
  }

  if (spec.service?.replicas === 1) out.push({ id: "RISK-05", level: "medium", title: "복제본 1개",
    detail: "트래픽 전환·재시작 때 잠깐 응답이 끊길 수 있다", field: "service.replicas", mitigation: "이전 중에는 2개 이상" });

  if (spec.service?.secretRefs.length) out.push({ id: "RISK-06", level: "medium", title: `비밀값 참조 ${spec.service.secretRefs.length}개`,
    detail: "플랫폼은 비밀값 자체를 옮기지 않는다. 도착 환경 비밀 저장소에 같은 이름으로 미리 있어야 한다",
    field: "service.secretRefs", mitigation: "도착 비밀 저장소에 값 등록 후 사전 점검 재실행" });

  if (meta["service.healthPath"]?.needs_review) out.push({ id: "RISK-07", level: "medium", title: "상태 확인 경로가 원본에 없음",
    detail: "기본값 /healthz 를 썼다. 틀리면 배포 판정과 자동 롤백이 오작동한다", field: "service.healthPath" });

  const unknown = items.filter((x) => !KNOWN_KINDS.has(String(x.kind)));
  if (unknown.length) out.push({ id: "RISK-08", level: "medium", title: `옮기지 않는 원본 자원 ${unknown.length}개`,
    detail: `명세에 담지 못한 종류: ${[...new Set(unknown.map((x) => String(x.kind)))].join(", ")}`,
    mitigation: "수동 이전 또는 다음 판에서 지원" });

  if (i.source.provider !== i.target.provider) out.push({ id: "RISK-09", level: "low", title: "클라우드 간 이동",
    detail: `${i.source.provider} → ${i.target.provider}. 복제 기간 동안 클라우드 간 지연과 전송 비용이 생긴다` });

  if (i.target.provider === "azure_mock") out.push({ id: "RISK-10", level: "high", title: "도착 환경이 흉내(Mock)",
    detail: "Azure는 어댑터 모양만 있다. 실제 자원이 만들어지지 않는다" });

  // Z3-F4: 기본키 없는 표. 논리 복제는 PK(또는 REPLICA IDENTITY FULL) 없는 표의 UPDATE/DELETE 를 옮기지 못하고 출발에서 오류가 난다.
  // replication precheck DB-T2 와 같은 조건을 명세 단계에서 먼저 알린다
  // TODO(human): discover 가 pg.schema(표 이름·PK 유무·행 수)를 만들지 결정. 지금은 이 원본이 없으면 규칙이 조용히 넘어간다
  const schema = items.find((x) => x.kind === "pg.schema") as { tables?: Array<{ name: string; pk: string[] | null; rows?: number }> } | undefined;
  const noPk = (schema?.tables ?? []).filter((t) => !t.pk || t.pk.length === 0);
  if (noPk.length) out.push({ id: "RISK-11", level: "high", title: `기본키 없는 표 ${noPk.length}개`,
    detail: `논리 복제로 UPDATE/DELETE 가 옮겨지지 않는 표: ${noPk.map((t) => t.name).slice(0, 10).join(", ")}`.slice(0, 500),
    field: "database", mitigation: "기본키 추가 또는 ALTER TABLE ... REPLICA IDENTITY FULL 후 복제 사전 점검(DB-T2) 재실행" });

  // Z3-F6: 원본 문자열(이름·태그·주석·환경변수 값)에 지시처럼 보이는 문장. 모델이 알아채든 말든 규칙이 먼저 적는다.
  // 문장 자체와 그 안의 주소는 옮기지 않고 위치만 적는다 (운영자 화면에 다시 주입되지 않게)
  // DRAFT(ai): 문구 목록. 오탐이 나도 위험 한 줄일 뿐이라 넓게 잡았다
  const hits = suspectStrings(items).slice(0, 5);
  if (hits.length) out.push({ id: "RISK-12", level: "high", title: `원본 데이터에 지시처럼 보이는 문장 ${hits.length}곳`,
    detail: `에이전트에게 명령하는 듯한 문장이 있다(따르지 않음). 위치: ${hits.join(", ")}`.slice(0, 500),
    mitigation: "출처 자원 담당자에게 확인. AI 초안의 바뀐 칸과 설명을 평소보다 꼼꼼히 검토" });

  return out.map((r) => ({ ...r, source: "rule" as const }));
}

const SUSPECT = [/<\/?tool_result/i, /ignore (all |the )?(previous|above) instructions/i, /system (prompt|notice|message)\s*:/i,
  /시스템\s*(공지|지시|프롬프트)/, /(위|앞)의? (규칙|지시)보다 우선/, /에이전트(에게|는)\s*:?/, /\b(AI|assistant)\s*(에게|:)/i];
function suspectStrings(items: unknown[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") { if (SUSPECT.some((r) => r.test(v))) out.push(path); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  items.forEach((x, i) => walk(x, `inventory[${i}]`));
  return out;
}
