// IA-1: 프로브 exec 명령 속 비밀번호가 감사 사본·IR 에 평문으로 남지 않는다. 감사 사본 가리기는 종류 목록이 아니라 파드 템플릿 모양으로
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { inventoryForAudit } from "../src/discover/index.js";
import { maskInlineSecrets } from "../src/import/env-rewrite.js";

const D = "sha256:" + "ab".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items }) as RawInventory;
const execProbe = (command: string[]) => ({ exec: { command }, periodSeconds: 10 });
const dep = (name: string, c: Raw = {}, kind = "k8s.deployment"): Raw => ({
  kind, imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
    serviceAccountName: name, containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 6379 }], env: [{ name: "X", value: "PLAIN-ENV" }], ...c }] } } },
});

test("IA-1 정상: 감사 사본은 프로브 exec 명령을 지우고(exec 였다는 것만 남김), 처음 보는 종류(StatefulSet)도 파드 템플릿 모양으로 가린다", () => {
  const probe = { readinessProbe: execProbe(["redis-cli", "-a", "PROBE-PW", "ping"]), livenessProbe: { httpGet: { path: "/h", port: 8080 } } };
  const a = inventoryForAudit(inv([dep("cache", probe), dep("db", { ...probe, args: ["--password=ARG-PW"] }, "k8s.statefulset")]));
  const s = JSON.stringify(a);
  for (const leak of ["PROBE-PW", "ARG-PW", "PLAIN-ENV"]) assert.ok(!s.includes(leak), leak);
  const c0 = (a.items[0] as Raw).spec.template.spec.containers[0];
  assert.deepEqual(c0.readinessProbe.exec, {}, "exec 프로브였다는 표시는 남음");
  assert.deepEqual(c0.livenessProbe.httpGet, { path: "/h", port: 8080 }, "http 프로브는 그대로");
  assert.deepEqual(c0.env, [{ name: "X" }]);
});

test("IA-1 정상: IR 의 exec 프로브 명령 속 비밀번호는 자리표시로 바뀌고 검토 표시 + unmapped B", () => {
  const r = normalizeV2(inv([dep("cache", {
    readinessProbe: execProbe(["redis-cli", "-a", "PROBE-PW", "ping"]),
    livenessProbe: execProbe(["sh", "-c", "mysqladmin -uroot -pMYSQL-PW ping && psql 'host=db password=PG-PW' -c 'select 1'"]),
  })])).result;
  const s = JSON.stringify(r.spec);
  for (const leak of ["PROBE-PW", "MYSQL-PW", "PG-PW"]) assert.ok(!s.includes(leak), leak);
  const p = (r.spec.components.find((c) => c.id === "cache") as any).props.probes;
  assert.deepEqual(p.readiness.command, ["redis-cli", "-a", "$(PLAIN_SECRET_PROBES_READINESS_COMMAND_2)", "ping"]);
  assert.match(p.liveness.command[2], /^mysqladmin -uroot -p\$\(PLAIN_SECRET_PROBES_LIVENESS_COMMAND_2_0\) ping && psql 'host=db password=\$\(PLAIN_SECRET_PROBES_LIVENESS_COMMAND_2_1\)'/);
  assert.equal(r.fieldMeta["components.cache.probes.readiness.command"]?.needs_review, true);
  assert.ok(r.unmapped.some((u) => u.resource === "probe:cache.probes.liveness.command" && u.grade === "B"));
});

test("IA-1 거부: 비밀이 아닌 프로브 명령·비슷한 글자는 안 바꾼다", () => {
  const r = normalizeV2(inv([dep("cache", { readinessProbe: execProbe(["redis-cli", "-h", "localhost", "ping"]),
    livenessProbe: execProbe(["sh", "-c", "pg_isready -U app -d shop && test -f /tmp/password-file"]) })])).result;
  const p = (r.spec.components.find((c) => c.id === "cache") as any).props.probes;
  assert.deepEqual(p.readiness.command, ["redis-cli", "-h", "localhost", "ping"]);
  assert.equal(p.liveness.command[2], "pg_isready -U app -d shop && test -f /tmp/password-file");
  assert.equal(r.fieldMeta["components.cache.probes.readiness.command"], undefined);
  assert.equal(maskInlineSecrets("mysql -h db -P 3306 shop", () => "X"), "mysql -h db -P 3306 shop", "-P(포트) 는 비밀번호 아님");
});
