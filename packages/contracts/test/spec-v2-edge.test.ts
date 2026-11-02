// 검증 묶음 VI1: IR v2 계약 경계값 · 왕복 · 스키마 재현
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppSpec, AppSpecV2, ImportResultV2, checkV2, upconvertV1, hasPrivateIp, hasVendorHost } from "../src/index.js";

const D = (c: string) => "sha256:" + c.repeat(64);
type Loose = Record<string, any>;
const svc = (id: string, over: Loose = {}): Loose => ({ id, kind: "service", props: {
  runtime: "k8s", image: { source: "registry", repository: "r/" + id, digest: D("a") },
  resources: {}, ports: [{ port: 80 }], serviceAccount: "default", replicas: { min: 1, max: 1 }, env: [], ...over } });
const spec = (components: Loose[], links: Loose[] = [], extra: Loose = {}): any => ({
  schemaVersion: "2", app: { name: "t" }, components, links,
  entry: { via: "cloudflare-lb", hosts: [] }, posture: { permissions: [], network: [] }, ...extra });

// ── 경계값 ─────────────────────────────────────────
test("digest 경계: 64자 소문자 hex 만 통과 (63자·65자·대문자·접두어 없음은 오류)", () => {
  const ok = (d: string | null) => checkV2(spec([svc("a", { image: { source: "registry", repository: "r", digest: d } })])).errors.length === 0;
  assert.equal(ok(D("a")), true);
  assert.equal(ok("sha256:" + "a".repeat(63)), false);
  assert.equal(ok("sha256:" + "a".repeat(65)), false);
  assert.equal(ok("sha256:" + "A".repeat(64)), false);
  assert.equal(ok("a".repeat(64)), false);
  assert.equal(ok(null), false);
});

test("id 경계: 40자 통과, 41자·대문자·숫자 시작은 오류", () => {
  const errs = (id: string) => checkV2(spec([svc(id)])).errors.filter((e) => e.includes("id 모양"));
  assert.deepEqual(errs("a" + "b".repeat(39)), []);
  assert.equal(errs("a" + "b".repeat(40)).length, 1);
  assert.equal(errs("Abc").length, 1);
  assert.equal(errs("1abc").length, 1);
});

test("replicas 경계: min==max 통과, min>max 오류", () => {
  assert.deepEqual(checkV2(spec([svc("a", { replicas: { min: 3, max: 3 } })])).errors, []);
  assert.deepEqual(checkV2(spec([svc("a", { replicas: { min: 0, max: 0 } })])).errors, []);
  assert.equal(checkV2(spec([svc("a", { replicas: { min: 4, max: 3 } })])).errors.length, 1);
});

test("사설 IP 경계: 172.15·172.32·네 칸 아님은 안 걸리고 172.16·172.31·192.168·10.x 는 걸림", () => {
  for (const v of ["172.16.0.1", "172.31.255.1", "192.168.1.1", "10.0.0.1", "db=10.2.3.4:5432", "http://10.2.3.4/x"]) assert.equal(hasPrivateIp(v), true, v);
  for (const v of ["172.15.0.1", "172.32.0.1", "192.169.1.1", "11.0.0.1", "10.4.1", "1.10.0.0.1", "10.1.2.3.4", "v10.1.2.3x"]) assert.equal(hasPrivateIp(v), v === "v10.1.2.3x", v);
});

test("벤더 주소 경계: 대문자·포트·URL 은 잡고, 비슷한 이름·파일 이름은 안 잡는다", () => {
  for (const v of ["X.RDS.AMAZONAWS.COM", "x.rds.amazonaws.com:5432", "postgres://u@x.rds.amazonaws.com/db", "a.b.run.app", "x.blob.windows.net"]) assert.equal(hasVendorHost(v), true, v);
  for (const v of ["evilamazonaws.com", "amazonaws.com.evil.example", "/tmp/app.cache.db", "app.example.com", ""]) assert.equal(hasVendorHost(v), false, v);
  assert.equal(hasVendorHost("x.rds.amazonaws.com", new Set(["x.rds.amazonaws.com"])), false);
});

// ── 거부 경로 · 방어 ────────────────────────────────
test("template 이 모르는 id 를 가리키면 오류, 같은 이름 의존성이 있어도 출력이 틀리면 오류", () => {
  const s = spec([svc("a", { env: [{ name: "X", template: "http://${ghost.host}" }] })]);
  assert.ok(checkV2(s).errors.some((e) => e.includes("a.env.X 참조 ghost 에 맞는 의존성 없음")));
});

test("의존성 중복·출발 없음·unmapped/external 대상은 대상 검사에서 제외", () => {
  const s = spec([svc("a"), svc("b")], [
    { from: "a", to: "b", intent: "call" }, { from: "a", to: "b", intent: "call" },
    { from: "zzz", to: "b", intent: "call" },
    { from: "a", to: { unmapped: "sqs" }, intent: "call" }, { from: "a", to: { external: "api.example.com" }, intent: "call" },
  ]);
  const e = checkV2(s).errors;
  assert.ok(e.includes("의존성 중복: a->b"));
  assert.ok(e.includes("의존성 출발 없음: zzz"));
  assert.equal(e.length, 2, e.join("\n"));
});

test("job 도 build 면 승인, 같은 명세에 승인이 여러 줄이면 순서대로 모두 나온다", () => {
  const b = (id: string) => ({ source: "build", repository: id, digest: null,
    build: { repo: "g/x", commit: "c", path: ".", method: "dockerfile", evidence: [] } });
  const j = { id: "j", kind: "job", props: { image: b("j"), schedule: "* * * * *", resources: {}, env: [], serviceAccount: "default" } };
  const r = checkV2(spec([svc("a", { image: b("a"), origin: { runtime: "vm", product: "ec2" } }), j]));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.approvals.map((a) => `${a.kind}:${a.subject}`), ["build:a", "runtime_change:a", "build:j"]);
});

test("망가진 입력에도 던지지 않는다 (빈 객체·null 칸·숫자 배열)", () => {
  for (const bad of [{}, { schemaVersion: "2" }, { schemaVersion: "2", components: null, links: 5 },
    { schemaVersion: "2", components: [null, 1, "x", { id: 1, kind: null, props: 3 }], links: [null, { from: 1 }], entry: 7, posture: [] }])
    assert.doesNotThrow(() => checkV2(bad as any), JSON.stringify(bad));
  assert.ok(checkV2({} as any).errors.includes("schemaVersion 이 2 아님"));
});

test("같은 입력은 같은 출력 (순수) — 호출 뒤 입력이 안 바뀐다", () => {
  const s = spec([svc("a", { env: [{ name: "H", value: "x.rds.amazonaws.com" }] })]);
  const before = JSON.stringify(s);
  assert.deepEqual(checkV2(s), checkV2(s));
  assert.equal(JSON.stringify(s), before);
});

// ── upconvertV1 왕복 ────────────────────────────────
const v1 = (over: Loose = {}) => AppSpec.parse({ schemaVersion: "1", app: { name: "demo" },
  service: { image: "r/d@sha256:" + "0".repeat(64), port: 8080, healthPath: "/healthz", replicas: 2, cpu: "250m", memory: "2Gi",
    env: [{ name: "A", value: "1" }], secretRefs: [] },
  database: { engine: "postgres", majorVersion: "17", storageGb: 100 },
  ingress: { hostname: "d.example.com", entry: "cloudflare-lb" }, ...over });

test("upconvertV1: JSON 왕복 뒤에도 Zod·checkV2 통과, 두 번 올려도 같은 결과", () => {
  const a = upconvertV1(v1());
  const rt = JSON.parse(JSON.stringify(a));
  assert.equal(ImportResultV2.safeParse(rt).success, true);
  assert.deepEqual(rt, a);
  assert.deepEqual(checkV2(rt.spec), { errors: [], reviews: [], approvals: [] });
  assert.deepEqual(upconvertV1(v1()), a);
});

test("upconvertV1: 데이터베이스가 없는 v1 은 DB 자원·의존성 없이 올라간다", () => {
  const { database: _omit, ...rest } = v1();
  const out = upconvertV1(AppSpec.parse(rest));
  assert.equal(out.spec.components.length, 1);
  assert.deepEqual(out.spec.links, []);
  assert.deepEqual(checkV2(out.spec).errors, []);
});

test("upconvertV1: 표 값 전부 (cpu 3종 × memory 3종) 올라가고 fieldMeta 키는 실제 자원 경로를 가리킨다", () => {
  const cpu: Record<string, number> = { "250m": 250, "500m": 500, "1": 1000 }, mem: Record<string, number> = { "512Mi": 512, "1Gi": 1024, "2Gi": 2048 };
  for (const [c, cm] of Object.entries(cpu)) for (const [m, mm] of Object.entries(mem)) {
    const base = v1();
    const out = upconvertV1({ ...base, service: { ...base.service, cpu: c as any, memory: m as any } });
    const p: any = out.spec.components[0]!.props;
    assert.deepEqual(p.resources.request, { cpuMilli: cm, memMiB: mm });
  }
  const out = upconvertV1(v1());
  const ids = new Set(out.spec.components.map((c) => c.id));
  for (const k of Object.keys(out.fieldMeta)) assert.ok(ids.has(k.split(".")[1]!), k);
});

test("upconvertV1: 비밀 참조 여러 개·env 와 같은 이름 충돌 없이 env 순서 유지", () => {
  const base = v1();
  const out = upconvertV1({ ...base, service: { ...base.service, secretRefs: [{ name: "P1", key: "k1" }, { name: "P2", key: "k2" }] } });
  const env = (out.spec.components[0]!.props as any).env as { name: string }[];
  assert.deepEqual(env.map((e) => e.name), ["A", "P1", "P2"]);
  assert.equal(Object.keys(out.fieldMeta).filter((k) => k.includes(".env.P")).length, 2);
});

// ── 스키마 ──────────────────────────────────────────
// ajv 는 이 패키지의 의존성이 아니라서 쓰지 않는다 (새 의존성 규칙). 뽑힌 JSON Schema 의 모양만 본다
test("JSON Schema: 두 번 뽑아도 글자까지 같고, strict·schemaVersion 상수가 스키마에 남는다", () => {
  const a = JSON.stringify(z.toJSONSchema(AppSpecV2)), b = JSON.stringify(z.toJSONSchema(AppSpecV2));
  assert.equal(a, b);
  const sch: any = JSON.parse(a);
  assert.equal(sch.additionalProperties, false);
  assert.equal(sch.properties.schemaVersion.const ?? sch.properties.schemaVersion.enum?.[0], "2");
  assert.ok(sch.required.includes("components") && sch.required.includes("links"));
});
