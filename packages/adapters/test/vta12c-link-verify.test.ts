// 검증 묶음 VTA12c: TA12c 추가 검증 — 데이터 링크 의도(read·write·readwrite·admin)가 명세 검사(checkV2)·도착 Builder·권한 렌더를 한 줄로 통과하는지.
//   "checkV2 는 의도를 허용하는데 Builder 가 모른다"(E2EDATA2 설계 구멍)가 대상 종류 × 의도 × 도착 전체에서 다시 안 생기게 표로 고정
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2Blockers, stubTfOutputsV2 } from "../src/index.js";
import { awsGrantPlan, gcpGrantPlan, grantBlockers } from "../src/target/grants.js";

type Raw = Record<string, any>;
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
const INTENTS = ["connect", "read", "write", "readwrite", "admin", "call"] as const;
const TARGETS: Record<string, Raw> = {
  cache: { id: "t-cache", kind: "cache", props: { engine: "redis", memoryMiB: 256, tls: true, auth: true } },
  objectStore: { id: "t-assets", kind: "objectStore", props: { versioning: false, public: false, sizeGb: 1 } },
  queue: { id: "t-orders", kind: "queue", props: { model: "queue" } },
};
const ALLOWED: Record<string, string[]> = { cache: ["connect"], objectStore: ["read", "write", "readwrite", "admin"], queue: ["read", "write", "readwrite", "admin"] };
function build(kind: string, intent: string, grants?: Raw[]): Raw {
  const s: Raw = structuredClone(BASE);
  const svc = s.components.find((c: Raw) => c.kind === "service");
  s.components.push(structuredClone(TARGETS[kind]));
  s.links.push({ from: svc.id, to: TARGETS[kind]!.id, intent, ...(grants ? { grants } : {}) });
  return s;
}

for (const kind of Object.keys(TARGETS)) for (const intent of INTENTS) {
  const ok = ALLOWED[kind]!.includes(intent);
  test(`${kind} ← intent=${intent}: ${ok ? "명세 검사·aws·gcp·azure-mock Builder 가 모두 받고 렌더·가짜 출력·env 까지 감" : "명세 검사가 거부 (Builder 까지 안 감)"}`, () => {
    const raw = build(kind, intent);
    const errors = checkV2(AppSpecV2.parse(raw)).errors.map(String);
    if (!ok) { assert.ok(errors.some((e) => /의도가 대상과 안 맞음/.test(e)), errors.join()); return; }
    assert.deepEqual(errors, []);
    const spec = AppSpecV2.parse(raw);
    for (const p of ["aws", "gcp", "azure_mock"] as const) {
      const b = targetBuilderFor(p);
      assert.deepEqual(v2Blockers(spec, b.capabilities()).unsupported, [], `${p} unsupported`);
      assert.doesNotThrow(() => b.toTerraformV2(spec, T(p)), `${p} toTerraformV2`);
      const out = stubTfOutputsV2(spec);
      assert.doesNotThrow(() => b.toWorkloadValues(spec, out, T(p)), `${p} toWorkloadValues`);
    }
  });
}

test("거부: 온프레 도착은 데이터 자원(캐시·버킷·큐)을 모르므로 막음 — 몰래 그리지 않음", () => {
  for (const kind of Object.keys(TARGETS)) {
    const intent = ALLOWED[kind]![0]!;
    const b = v2Blockers(AppSpecV2.parse(build(kind, intent)), targetBuilderFor("onprem").capabilities());
    assert.ok(b.unsupported.length > 0, `${kind}: 온프레가 막지 않음`);
  }
});

const G = (actions: string[], resources = ["arn:aws:s3:::src-bucket/*"]) => ({ effect: "Allow", actions, resources });
const GRANT_CASES: Array<{ kind: string; intent: string; grants: Raw[]; want: string[] }> = [
  { kind: "objectStore", intent: "read", grants: [G(["s3:GetObject"])], want: ["s3:GetObject"] },
  { kind: "objectStore", intent: "write", grants: [G(["s3:PutObject"])], want: ["s3:PutObject"] },
  { kind: "objectStore", intent: "readwrite", grants: [G(["s3:GetObject", "s3:PutObject"])], want: ["s3:GetObject", "s3:PutObject"] },
  { kind: "queue", intent: "readwrite", grants: [G(["sqs:ReceiveMessage", "sqs:SendMessage"], ["arn:aws:sqs:ap-northeast-1:123456789012:src-orders"])], want: ["sqs:ReceiveMessage", "sqs:SendMessage"] },
];
for (const c of GRANT_CASES) test(`권한 원문 + intent=${c.intent} (${c.kind}): aws grants_json 이 원문 동작을 그대로, gcp 는 역할로, 출발 ARN·이름·계정 번호는 도착 변수에 안 남음`, () => {
  const raw = build(c.kind, c.intent, c.grants);
  assert.deepEqual(checkV2(AppSpecV2.parse(raw)).errors, []);
  const spec = AppSpecV2.parse(raw);
  const tfAws = targetBuilderFor("aws").toTerraformV2(spec, T("aws"));
  const id = JSON.parse(String(tfAws.vars.identity_json))[0];
  const g = JSON.parse(id.grants_json) as Array<{ actions: string[]; targets: Array<{ id: string }> }>;
  assert.deepEqual(g.flatMap((x) => x.actions).sort(), [...c.want].sort());
  assert.equal(g[0]!.targets[0]!.id, TARGETS[c.kind]!.id);
  const tfGcp = targetBuilderFor("gcp").toTerraformV2(spec, T("gcp"));
  const gid = JSON.parse(String(tfGcp.vars.identity_json))[0];
  assert.ok(gid.grants_json, "gcp grants_json 없음");
  for (const v of [tfAws.vars, tfGcp.vars]) { const s = JSON.stringify(v); assert.ok(!/src-bucket|src-orders|123456789012/.test(s), "출발 값이 남음"); }
  assert.deepEqual(gcpGrantPlan(spec).unsupported, []); assert.deepEqual(awsGrantPlan(spec).unsupported, []);
});

test("의도는 권한을 넓히지 않는다: 원문 없이 admin·readwrite 만 있으면 aws·gcp 모두 grants_json 이 비고 경고만 (버킷·큐)", () => {
  for (const kind of ["objectStore", "queue"]) for (const intent of ["admin", "readwrite", "read", "write"]) {
    const spec = AppSpecV2.parse(build(kind, intent));
    for (const p of ["aws", "gcp"] as const) {
      const id = JSON.parse(String(targetBuilderFor(p).toTerraformV2(spec, T(p)).vars.identity_json))[0];
      assert.ok(!id.grants_json || JSON.parse(id.grants_json).length === 0, `${p} ${kind} ${intent}: 원문 없이 권한이 생김`);
    }
    assert.ok((p => p)(awsGrantPlan(spec)).warnings.some((w) => new RegExp(`${intent} 의도만`).test(w)));
    assert.ok(gcpGrantPlan(spec).warnings.some((w) => new RegExp(`${intent} 의도만`).test(w)));
  }
});

test("거부: 대응표 밖 동작·조건 붙은 권한은 막음(지어내지 않음) — 데이터 링크에서도 aws·gcp 같음", () => {
  const spec = AppSpecV2.parse(build("objectStore", "readwrite", [G(["s3:PutBucketPolicy"])]));
  assert.ok(awsGrantPlan(spec).unsupported.length + gcpGrantPlan(spec).unsupported.length > 0);
  const cond = AppSpecV2.parse(build("objectStore", "read", [{ effect: "Allow", actions: ["s3:GetObject"], resources: ["arn:aws:s3:::src-bucket/*"], conditions: { StringEquals: { "aws:SourceVpce": "vpce-1" } } }]));
  assert.ok(awsGrantPlan(cond).unsupported.some((u) => /조건/.test(u)));
  assert.ok(gcpGrantPlan(cond).unsupported.some((u) => /조건/.test(u)));
  // v2Blockers 는 권한 원문을 안 본다(설계: precheck 는 grantBlockers 를 따로 더하고, Builder 는 assertGrants 로 던짐) → 둘 다 같은 목록으로 막는지
  for (const p of ["aws", "gcp"] as const) {
    assert.ok(grantBlockers(p, cond).length > 0, `${p} grantBlockers`);
    assert.throws(() => targetBuilderFor(p).toTerraformV2(cond, T(p)), /UNSUPPORTED_V2|권한 렌더 미지원/, `${p} Builder 가 안 던짐`);
  }
});

test("캐시 AUTH: 출발이 AUTH 를 썼으면 aws 는 막지 않되 사람 확인(needsHuman), 사람이 auth=false 로 정하면 사라짐 / gcp 는 AUTH 를 옮기므로 확인 없음", () => {
  for (const p of ["aws", "gcp"] as const) {
    const raw = build("cache", "connect");
    const caps = targetBuilderFor(p).capabilities();
    const on = v2Blockers(AppSpecV2.parse(raw), caps);
    assert.deepEqual(on.unsupported, [], p);
    assert.equal(on.needsHuman.some((x) => /AUTH/.test(x)), p === "aws", `${p}: ${on.needsHuman.join()}`);
    const off: Raw = structuredClone(raw); off.components.find((c: Raw) => c.id === "t-cache").props.auth = false;
    assert.deepEqual(v2Blockers(AppSpecV2.parse(off), caps).needsHuman.filter((x) => /AUTH/.test(x)), [], p);
  }
});
