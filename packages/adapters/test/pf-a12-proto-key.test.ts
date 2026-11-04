// PF-A12 (14회차 공격자 관점): 출발 객체에 __proto__·constructor 같은 이름이 있어도 프로토타입이 오염되지 않고,
//   명세에 담을 수 없는 ConfigMap 키 "__proto__" 는 조용히 빠지지 않고 검토 줄로 남는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2 } from "@svc/contracts";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { pfExec, PF_NS } from "./pf-a-eks-demo-fixture.js";

const md = (name: string, labels: Record<string, string> = {}) => ({ name, namespace: PF_NS, labels });
const evil = (data: Record<string, string>) => [
  { kind: "configmaps", o: { metadata: md("evil-cfg"), data } },
  { kind: "deployments", o: { metadata: md("evil-api", { app: "evil-api" }), spec: { replicas: 1, selector: { matchLabels: { app: "evil-api" } },
    template: { metadata: { labels: { app: "evil-api" } }, spec: { containers: [{ name: "api", image: "nginx:1.27", ports: [{ containerPort: 8080 }],
      env: [{ name: "__proto__", value: "P" }, { name: "constructor", value: "C" }], envFrom: [{ configMapRef: { name: "evil-cfg" } }] }] } } } } },
  { kind: "pods", o: { metadata: md("evil-api-1", { app: "evil-api" }), status: { containerStatuses: [{ name: "api", imageID: `docker.io/library/nginx@sha256:${"f".repeat(64)}` }] } } },
];
const run = async (data: Record<string, string>) =>
  normalizeV2(await discoverAws({ exec: pfExec({ extraObjs: evil(data) }).exec, env: {} }, { iam: true })).result;

test("PF-A12: ConfigMap 키 __proto__ → 검토 줄, 프로토타입 오염 없음, 명세 모양 통과, env 이름은 그대로", async () => {
  const r = await run(JSON.parse('{"__proto__":"p","constructor":"c","A":"1"}'));
  assert.equal(r.fieldMeta["components.evil-api.configs.evil-cfg.protoKey"]?.needs_review, true);
  assert.equal(({} as Record<string, unknown>).P, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "p"), false);
  assert.ok(ImportResultV2.safeParse(r).success);
  const c = r.spec.components.find((x) => x.id === "evil-api")! as unknown as { props: Record<string, unknown> };
  assert.deepEqual((c.props.env as Array<{ name: string }>).map((e) => e.name).filter((n) => n === "__proto__" || n === "constructor"), ["__proto__", "constructor"]);
  const cfg = (c.props.configs as Array<{ name: string; data: Record<string, string> }>).find((x) => x.name === "evil-cfg")!;
  assert.deepEqual(Object.keys(cfg.data).sort(), ["A", "constructor"]);
});

test("PF-A12 거부 쪽: 보통 ConfigMap 이면 protoKey 검토 줄 없음", async () => {
  const r = await run({ A: "1" });
  assert.equal(Object.keys(r.fieldMeta).some((k) => k.endsWith(".protoKey")), false);
});
