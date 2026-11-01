import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapestEnvelope, curveActual, curveApprox, findCrossovers, stepEvents } from "../src/core/crossover.js";
import { makeResourceFn } from "../src/core/resource.js";
import { ResourceProfile, Sizing, VendorPricing } from "../src/core/types.js";
import { pageVendor } from "./helpers.js";

const S = Sizing.parse({ hasDatabase: false });
// 모든 벤더 공통 자원: mem = 0.1 λ GiB, 송신 = 0.01 λ GB/h
const fn = makeResourceFn(ResourceProfile.parse({ source: "measured", points: [
  { lambda: 0, cpu: 0, memGiB: 0, egressGBh: 0, storageGB: 0 },
  { lambda: 1000, cpu: 0, memGiB: 100, egressGBh: 10, storageGB: 0 },
] }));
const A = VendorPricing.parse(pageVendor({ vendor: "aws", fixedHourly: 0, egressPerGB: 0.1, minNodes: 1, nodeTypes: [{ sku: "a", hourly: 0.2, capacity: { cpu: 4, mem: 16, gpu: 0 } }] }));
const B = VendorPricing.parse(pageVendor({ vendor: "gcp", fixedHourly: 1, egressPerGB: 0.02, minNodes: 1, nodeTypes: [{ sku: "b", hourly: 0.2, capacity: { cpu: 4, mem: 16, gpu: 0 } }] }));

test("연속 구간 역전점: 손 검산", () => {
  // 같은 노드라 노드 비용은 상쇄. A-B = -1 + (0.1-0.02) x 0.01 λ = 0 → λ = 1250 (범위 밖이면 없음)
  const ca = curveActual(A, fn, S, 0, 2000); const cb = curveActual(B, fn, S, 0, 2000);
  const xs = findCrossovers(ca, cb, 0, 2000);
  assert.equal(xs.length, 1);
  assert.equal(xs[0]!.kind, "exact");
  assert.ok(Math.abs(xs[0]!.lambda - 1250) < 1e-6, `${xs[0]!.lambda}`);
  assert.equal(xs[0]!.before, "aws");
  assert.equal(xs[0]!.after, "gcp");
  assert.equal(findCrossovers(ca, cb, 0, 1000).length, 0);
});

test("계단 때문에 역전이 여러 번 생기고, 실제와 근사의 역전점이 다르다", () => {
  // A: 고정비 없음, 16 GiB 노드 0.2 / C: 고정비 0.25, 64 GiB 노드 0.4 (GiB당 절반)
  const C = VendorPricing.parse(pageVendor({ vendor: "azure", fixedHourly: 0.25, egressPerGB: 0.1, minNodes: 1, nodeTypes: [{ sku: "c", hourly: 0.4, capacity: { cpu: 16, mem: 64, gpu: 0 } }] }));
  const ca = curveActual(A, fn, S, 0, 3000); const cc = curveActual(C, fn, S, 0, 3000);
  const xs = findCrossovers(ca, cc, 0, 3000);
  assert.ok(xs.length >= 3, `실제 역전 ${xs.length}개`);
  assert.ok(xs.some((x) => x.kind === "jump"), "계단에서 뒤집히는 지점이 있다");
  // 근사식: A = 0.2 x max(1, λ/160), C = 0.25 + 0.4 x max(1, λ/640).
  // λ<640에서 C = 0.65로 평평하고 A = 0.00125λ → λ = 520 (둘 다 바닥 위/아래 확인: 520 < 640)
  const ta = curveApprox(A, fn, S); const tc = curveApprox(C, fn, S);
  const grid = Array.from({ length: 301 }, (_, i) => i * 10);
  const ys = findCrossovers(ta, tc, 0, 3000, { extraPoints: grid, samples: 2 });
  assert.equal(ys.length, 1);
  assert.equal(ys[0]!.kind, "exact");
  assert.ok(Math.abs(ys[0]!.lambda - 520) < 1e-6, `${ys[0]!.lambda}`);
  // 각 지점 검증: exact는 등식, jump는 순서만 뒤집힘
  for (const x of xs) {
    if (x.kind === "exact") assert.ok(Math.abs(ca.cost(x.lambda) - cc.cost(x.lambda)) < 1e-6);
    if (x.kind === "jump") {
      assert.ok(Math.abs(ca.cost(x.lambda) - cc.cost(x.lambda)) > 1e-6);
      const before = ca.cost(x.lambda - 1e-3) - cc.cost(x.lambda - 1e-3);
      const after = ca.cost(x.lambda + 1e-3) - cc.cost(x.lambda + 1e-3);
      assert.ok(before * after < 0);
    }
  }
});

test("계단 경계 계산: 정수를 넘는 λ를 정확히 찾는다", () => {
  const ev = stepEvents(A, fn, S, 0, 500);
  // mem/16 = 0.1λ/16 = n → λ = 160 n
  assert.deepEqual(ev.map((x) => Math.round(x * 1e6) / 1e6), [160, 320, 480]);
});

test("같은 값이면 동률 구간으로 보고한다", () => {
  const A2 = { ...A, vendor: "gcp" as const };
  const xs = findCrossovers(curveActual(A, fn, S, 0, 100), curveActual(A2, fn, S, 0, 100), 0, 100);
  assert.equal(xs.length, 1);
  assert.equal(xs[0]!.kind, "tie");
});

test("한쪽이 불가능하면 역전점 없이 가능한 쪽이 최저다", () => {
  const L = VendorPricing.parse(pageVendor({ vendor: "gcp", fixedHourly: 100, egressPerGB: 0, maxEgressGBh: 5, minNodes: 1 }));
  const a = curveActual(A, fn, S, 0, 1000); const l = curveActual(L, fn, S, 0, 1000);
  const env = cheapestEnvelope([a, l], 0, 1000);
  assert.equal(env.length, 1);
  assert.equal(env[0]!.vendor, "aws");
});

test("최저 벤더 구간: 경계가 역전점과 일치한다", () => {
  const curves = [curveActual(A, fn, S, 0, 2000), curveActual(B, fn, S, 0, 2000)];
  const env = cheapestEnvelope(curves, 0, 2000);
  assert.deepEqual(env.map((e) => e.vendor), ["aws", "gcp"]);
  assert.ok(Math.abs(env[0]!.toLambda - 1250) < 1e-6);
  assert.equal(env[1]!.toLambda, 2000);
});
