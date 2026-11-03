// VE2Ev5: v2 사전점검(v2PrecheckItems) 과 계획 단계 Builder 렌더(toTerraformV2·toWorkloadValues)가 같은 경계를 쓰는지.
//   precheck 가 통과시킨 명세를 계획 단계가 UNSUPPORTED_V2 로 failed 시키면(E2E-v5 에서 찾은 구멍) 되돌릴 수 없는 끝 상태가 된다.
//   → 도착 4개 × 못 그리는 조합마다 "precheck block 이 있다 ⇔ Builder 가 던진다" 를 고정
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, upconvertV1, type Provider, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2PrecheckItems, AdapterError, UNSUPPORTED_V2, type Target } from "../src/index.js";

const T = (p: TargetEnv["provider"]): Target => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default",
  tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222",
  ...(p === "aws" ? { accountId: "000000000000" } : p === "gcp" ? { projectId: "p-1" } : {}) }) as Target;
const D = (c: string) => `sha256:${c.repeat(64)}`;
const V1 = AppSpec.parse({ schemaVersion: "1", app: { name: "shop" },
  service: { image: `registry/shop-api@${D("a")}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "500m", memory: "1Gi",
    env: [{ name: "LOG_LEVEL", value: "info" }], secretRefs: [{ name: "DATABASE_PASSWORD", key: "password" }] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 }, ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" } });
const base = (): any => structuredClone(upconvertV1(V1).spec);
const svcOf = (s: any) => s.components.find((c: any) => c.kind === "service");
const pgOf = (s: any) => s.components.find((c: any) => c.kind === "postgres");

// 못 그리는(또는 경계에 있는) 조합. 값 = 명세를 바꾸는 함수
const VARIANTS: Record<string, (s: any) => void> = {
  "그대로": () => undefined,
  "신원 2개": (s) => { const a = svcOf(s); s.components.push({ ...structuredClone(a), id: `${a.id}-2`, props: { ...structuredClone(a.props), serviceAccount: "other-sa" } }); },
  "같은 SA 서비스 2개(신원 1개)": (s) => { const a = svcOf(s); s.components.push({ ...structuredClone(a), id: `${a.id}-2` }); },
  "postgres 2개": (s) => { const p = pgOf(s); s.components.push({ ...structuredClone(p), id: `${p.id}-2` }); },
  "postgres 0개": (s) => { s.components = s.components.filter((c: any) => c.kind !== "postgres"); s.links = s.links.filter((l: any) => typeof l.to !== "string" || s.components.some((c: any) => c.id === l.to)); },
  "postgres 14": (s) => { pgOf(s).props.majorVersion = "14"; },
  "postgres 버전 모름": (s) => { pgOf(s).props.majorVersion = null; },
  "postgres 크기 모름": (s) => { pgOf(s).props.storageGb = null; },
  "캐시": (s) => { s.components.push({ id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } }); },
  "객체 저장소": (s) => { s.components.push({ id: "shop-bucket", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } }); },
  "큐": (s) => { s.components.push({ id: "shop-q", kind: "queue", props: { model: "queue" } }); },
  "관리형 컨테이너 실행": (s) => { svcOf(s).props.runtime = "managedContainer"; },
  "이미지 digest 없음": (s) => { const i = svcOf(s).props.image; i.digest = null; },
  "IAM grants(I4)": (s) => { const l = s.links.find((x: any) => typeof x.to === "string"); l.grants = [{ effect: "Allow", actions: ["rds:Describe*"], resources: ["*"] }]; },
  "posture.permissions(I4)": (s) => { s.posture.permissions = [{ subject: svcOf(s).id, source: "iam:r", effect: "Deny", actions: ["s3:*"], resources: ["*"], mode: "mirror" }]; },
};

function variant(name: string): AppSpecV2 | null {
  const s = base();
  VARIANTS[name]!(s);
  const p = AppSpecV2.safeParse(s);
  return p.success ? p.data : null;
}
const unsup = (p: Provider, s: AppSpecV2) => v2PrecheckItems(p, { spec: V1, specV2: s, hadV2Before: false }).filter((i) => i.level === "block");
function builderThrows(p: Provider, s: AppSpecV2): string | null {
  const b = targetBuilderFor(p), t = T(p);
  try { b.toTerraformV2(s, t); b.toWorkloadValues(s, {}, t); return null; }
  catch (e) {
    if (e instanceof AdapterError && e.code === UNSUPPORTED_V2) return e.message;
    throw e;   // UNSUPPORTED_V2 말고 다른 오류는 이 시험의 대상 밖 → 그대로 실패로 보이게
  }
}

const PROVIDERS: Provider[] = ["aws", "gcp", "onprem", "azure_mock"];

test("명세 조합이 전부 모양 검사(Zod)를 통과한다 (시험 재료 확인)", () => {
  for (const n of Object.keys(VARIANTS)) assert.ok(variant(n), n);
});

for (const p of PROVIDERS) {
  test(`${p}: precheck block 이 있다 ⇔ 계획 단계 Builder 가 UNSUPPORTED_V2 (못 그리는 조합 ${Object.keys(VARIANTS).length}개)`, () => {
    const rows: string[] = [];
    for (const n of Object.keys(VARIANTS)) {
      const s = variant(n)!;
      const blocks = unsup(p, s), thrown = builderThrows(p, s);
      // needsHuman(사람 확인) block 은 Builder 가 안 던져도 된다 → 렌더 미지원(UNSUP) 만 대조
      const u = blocks.filter((b) => b.id.startsWith("PC-V2-UNSUP"));
      if ((u.length > 0) !== (thrown !== null)) rows.push(`${n}: precheck UNSUP ${u.length}개 / Builder ${thrown ?? "통과"}`);
    }
    assert.deepEqual(rows, []);
  });
}

// 온프레 캐시·객체 저장소·큐는 TA12에서 TODO(human)(클러스터 안 대체물 미정)라 아직 막힘
// TA13: 관리형 컨테이너는 aws(ECS)·gcp(Cloud Run)가 그림 → 온프레·azure 만 막힘
const EXTRA: Partial<Record<Provider, string[]>> = { onprem: ["캐시", "객체 저장소", "큐", "관리형 컨테이너 실행"], gcp: ["IAM grants(I4)"], azure_mock: ["관리형 컨테이너 실행"] };   // gcp: 시험 grant(s3 action)는 대응표 밖이라 A8 TODO(human) block
test("기대값 고정: 도착별로 어떤 조합이 막히나 (바뀌면 설계 27번 3.6 과 같이 고친다)", () => {
  const blocked = (p: Provider) => Object.keys(VARIANTS).filter((n) => unsup(p, variant(n)!).some((b) => b.id.startsWith("PC-V2-UNSUP")));
  // TA12: 캐시·객체 저장소·큐는 이제 도착 Builder가 그린다 → 막힘 목록에서 빠짐 (환경별 실제 값은 아래 출력으로 고정)
  const common = ["postgres 2개", "postgres 14", "postgres 버전 모름", "postgres 크기 모름",
    "이미지 digest 없음"];   // A8: IAM grants·posture.permissions 는 이제 네 도착 모두 그림(온프레는 STUB+warn)
  for (const p of ["aws", "gcp", "onprem"] as const) assert.deepEqual(blocked(p).sort(), [...common, ...(EXTRA[p] ?? [])].sort(), p);
  assert.deepEqual(blocked("azure_mock").sort(), [...common, "신원 2개", ...(EXTRA.azure_mock ?? [])].sort());
});

test("block 메시지는 PrecheckItem 모양 + 고칠 방법(fix) 이 있고, 번호가 1부터 이어진다", () => {
  const s = variant("캐시")!;
  (s.components as any[]).push({ id: "shop-bucket", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } });
  const u = unsup("azure_mock", s).filter((b) => b.id.startsWith("PC-V2-UNSUP"));
  assert.deepEqual(u.map((b) => b.id), u.map((_, i) => `PC-V2-UNSUP-${i + 1}`));
  assert.ok(u.every((b) => b.message.startsWith("FAIL ") && b.fix));
});

test("v2 명세 출처가 막힘(NEEDS_HUMAN)이면 도착과 상관없이 PC-V2-HUMAN 하나만", () => {
  for (const p of PROVIDERS) {
    const items = v2PrecheckItems(p, { spec: V1, specV2: null, hadV2Before: true });
    assert.deepEqual(items.map((i) => [i.id, i.level]), [["PC-V2-HUMAN", "block"]], p);
  }
});
