// L-1: IR 개수 상한은 남용 막기 용도로만. 실제 큰 앱 모양은 통과하고, 넘으면 어느 칸이 몇 개 넘었는지 알려 준다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, SPEC_LIMITS, checkV2, specIssueLines } from "../src/index.js";

const D = (c: string) => "sha256:" + c.repeat(64);
type Loose = Record<string, any>;
const sidecar = (n: number): Loose => ({ name: `side-${n}`, image: { source: "registry", repository: `r/side-${n}`, digest: D("c") }, env: [], resources: {} });
const svc = (id: string, over: Loose = {}): Loose => ({ id, kind: "service", props: {
  runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "big",
  image: { source: "registry", repository: "r/" + id, digest: D("a") },
  resources: {}, ports: [{ port: 8080 }], serviceAccount: "default", replicas: { min: 1, max: 1 }, env: [], ...over } });
const spec = (components: Loose[], links: Loose[] = []): any => ({
  schemaVersion: "2", app: { name: "big" }, components, links, posture: { permissions: [], network: [] } });

// 큰 앱 고정 예시: 마이크로서비스 120개 + DB 1개, 서비스마다 다음 서비스·DB 로 링크(≈240개),
//   첫 서비스는 사이드카 7개(메시·로그·모니터링 등)·env 300개·포트 15개·복제 최대 300
const bigApp = () => {
  const n = 120;
  const ids = Array.from({ length: n }, (_, i) => `svc-${String(i).padStart(3, "0")}`);
  const comps: Loose[] = ids.map((id, i) => i === 0
    ? svc(id, {
      sidecars: Array.from({ length: 7 }, (_, k) => sidecar(k)),
      env: Array.from({ length: 300 }, (_, k) => ({ name: `E_${k}`, value: String(k) })),
      ports: Array.from({ length: 15 }, (_, k) => ({ port: 8000 + k })),
      replicas: { min: 10, max: 300 } })
    : svc(id));
  comps.push({ id: "big-db", kind: "postgres", props: { majorVersion: "16", storageGb: 500, ha: true } });
  const links: Loose[] = [];
  ids.forEach((id, i) => {
    if (i + 1 < n) links.push({ from: id, to: ids[i + 1], intent: "call" });
    links.push({ from: id, to: "big-db", intent: "connect" });
  });
  return spec(comps, links);
};

test("L-1 정상: 예전 상한(리소스 30·링크 100·사이드카 5·env 200·포트 10·복제 100)을 넘는 큰 앱이 그대로 통과", () => {
  const s = bigApp();
  assert.ok(s.components.length > 30 && s.links.length > 100);
  const r = AppSpecV2.safeParse(s);
  assert.equal(r.success, true, r.success ? "" : specIssueLines(r.error.issues, s).join("; "));
  assert.deepEqual(checkV2(r.data!).errors, []);
});

test("L-1 거부: 남용 상한을 넘으면 칸 경로·이름·상한·지금 개수를 알려 준다 (값은 안 냄)", () => {
  const ids = Array.from({ length: SPEC_LIMITS.components + 1 }, (_, i) => `s-${i}`);
  const tooMany = spec(ids.map((id) => svc(id)));
  const r = AppSpecV2.safeParse(tooMany);
  assert.equal(r.success, false);
  const lines = specIssueLines(r.error!.issues, tooMany);
  assert.ok(lines.includes(`components: 리소스 개수 상한 ${SPEC_LIMITS.components} 넘음 (지금 ${SPEC_LIMITS.components + 1}개)`), lines.join("; "));

  const secret = "s3cr3t-value";
  const deep = spec([svc("a", { sidecars: Array.from({ length: SPEC_LIMITS.sidecars + 1 }, (_, k) => sidecar(k)),
    env: Array.from({ length: SPEC_LIMITS.env + 1 }, (_, k) => ({ name: `E_${k}`, value: secret })) })]);
  const r2 = AppSpecV2.safeParse(deep);
  assert.equal(r2.success, false);
  const l2 = specIssueLines(r2.error!.issues, deep);
  assert.ok(l2.includes(`components.0.props.sidecars: 보조 컨테이너 개수 상한 ${SPEC_LIMITS.sidecars} 넘음 (지금 ${SPEC_LIMITS.sidecars + 1}개)`), l2.join("; "));
  assert.ok(l2.includes(`components.0.props.env: env 개수 상한 ${SPEC_LIMITS.env} 넘음 (지금 ${SPEC_LIMITS.env + 1}개)`), l2.join("; "));
  assert.ok(!l2.join(" ").includes(secret));
});

test("L-1: 개수 상한이 아닌 모양 오류는 경로 + Zod 메시지 그대로, 입력 없이 불러도 지금 개수만 빠짐", () => {
  const bad = spec([svc("a", { replicas: { min: 1, max: SPEC_LIMITS.replicas + 1 } })]);
  const r = AppSpecV2.safeParse(bad);
  assert.equal(r.success, false);
  assert.match(specIssueLines(r.error!.issues, bad)[0]!, /^components\.0\.props\.replicas\.max: /);
  const big = spec(Array.from({ length: SPEC_LIMITS.components + 1 }, (_, i) => svc(`s-${i}`)));
  const noInput = specIssueLines(AppSpecV2.safeParse(big).error!.issues);
  assert.ok(noInput.includes(`components: 리소스 개수 상한 ${SPEC_LIMITS.components} 넘음`), noInput.join("; "));
});
