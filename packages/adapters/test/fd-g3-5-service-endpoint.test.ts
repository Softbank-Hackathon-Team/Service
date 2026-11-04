// G3-5: 서비스 사이 링크가 "어느 k8s Service 를 불렀나"를 IR 에 남기고, Builder 는 그 Service 이름·포트로 주소를 계산한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { k8sEnv, serviceAddress } from "../src/target/shared.js";
import { AdapterError } from "../src/common/errors.js";

const D = "sha256:" + "ab".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items }) as RawInventory;
const dep = (name: string, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
    serviceAccountName: name, containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }, { containerPort: 9000 }], env }] } } },
});
const svc = (name: string, app: string, port: number): Raw => ({ kind: "k8s.service", metadata: { name, namespace: "shop" },
  spec: { type: "ClusterIP", selector: { app }, ports: [{ port, targetPort: port, protocol: "TCP" }] } });
const comp = (r: any, id: string) => r.spec.components.find((c: any) => c.id === id);
const ctx = { namespace: "shop", out: {} as never };

test("G3-5 정상: payments-admin(9000)·payments-svc(8080) 두 Service 중 부른 이름이 IR 에 남고, 도착 주소도 그 Service", () => {
  const r = normalizeV2(inv([
    dep("web", [{ name: "PAY_URL", value: "http://payments-svc:8080/v1" }, { name: "PAY_HOST", value: "payments-svc.shop.svc.cluster.local" },
      { name: "ADMIN_PORT_URL", value: "payments-admin.shop.svc" }]),
    dep("payments"), svc("payments-admin", "payments", 9000), svc("payments-svc", "payments", 8080),
  ])).result;
  const env = comp(r, "web").props.env as Raw[];
  const by = (n: string) => env.find((e) => e.name === n)!;
  assert.equal(by("PAY_URL").template, "http://${payments.host@payments-svc}:8080/v1");
  assert.deepEqual(by("PAY_HOST").fromLink, { to: "payments", output: "host", endpoint: "payments-svc" });
  assert.deepEqual(by("ADMIN_PORT_URL").fromLink, { to: "payments", output: "host", endpoint: "payments-admin" });
  const spec = AppSpecV2.parse(r.spec);
  assert.deepEqual(checkV2(spec).errors, []);
  assert.equal(k8sEnv(spec, by("PAY_URL") as never, ctx).value, "http://payments-svc.shop.svc:8080/v1");
  assert.equal(k8sEnv(spec, by("PAY_HOST") as never, ctx).value, "payments-svc.shop.svc");
  // 포트 출력도 부른 Service 의 첫 포트 (이름순 첫 Service 9000 이 아님)
  assert.equal(k8sEnv(spec, { name: "P", fromLink: { to: "payments", output: "port", endpoint: "payments-svc" } }, ctx).value, "8080");
  assert.equal(k8sEnv(spec, { name: "P", fromLink: { to: "payments", output: "port" } }, ctx).value, "9000", "이름 없는 예전 IR 은 예전처럼 이름순 첫");
});

test("G3-5 거부: 대상 endpoints 에 없는 Service 이름은 checkV2 오류 + Builder 도 계산 거부", () => {
  const r = normalizeV2(inv([dep("web", [{ name: "PAY", value: "payments-svc" }]), dep("payments"), svc("payments-svc", "payments", 8080)])).result;
  const spec = AppSpecV2.parse(r.spec) as any;
  const web = spec.components.find((c: any) => c.id === "web");
  web.props.env = [{ name: "PAY", template: "http://${payments.host@nope}:1" }];
  assert.ok(checkV2(spec).errors.some((e) => e.includes("Service 이름 nope")));
  assert.throws(() => serviceAddress(spec.components.find((c: any) => c.id === "payments"), "shop", "nope"), AdapterError);
  assert.equal(AppSpecV2.safeParse({ ...spec, components: spec.components.map((c: any) => c.id !== "web" ? c
    : { ...c, props: { ...c.props, env: [{ name: "PAY", fromLink: { to: "payments", output: "host", endpoint: "Bad_Name" } }] } }) }).success, false);
});

test("G3-5 검토: Service 하나가 Deployment 둘을 고르면 같은 Service 가 두 컴포넌트에 있다는 검토 줄", () => {
  const a = dep("pay-a"), b = dep("pay-b");
  for (const d of [a, b]) d.spec.template.metadata.labels.tier = "pay";
  const shared = { ...svc("pay", "x", 8080), spec: { type: "ClusterIP", selector: { tier: "pay" }, ports: [{ port: 8080, targetPort: 8080 }] } };
  const r = normalizeV2(inv([a, b, shared])).result;
  assert.ok(checkV2(AppSpecV2.parse(r.spec)).reviews.some((x) => x.startsWith("Service pay 가 서비스 pay-a·pay-b")), JSON.stringify(checkV2(AppSpecV2.parse(r.spec)).reviews));
});
