// IA-1: exec 프로브 명령 안 평문 비밀 — IR 에서 그 자리만 가리고 검토 줄, 감사 사본은 pod 템플릿이 있는 모든 k8s 종류에서 지움
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { maskCommandSecrets, PROBE_HIDDEN } from "../src/import/env-rewrite.js";
import { inventoryForAudit } from "../src/discover/index.js";

const D = "sha256:" + "cd".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items });
const pod = (c: Raw) => ({ metadata: { labels: { app: "cache-api" } }, spec: { containers: [{ name: "api", image: "ghcr.io/demo/api:1", ports: [{ containerPort: 8080 }], env: [], ...c }] } });
const dep = (c: Raw): Raw => ({ kind: "k8s.deployment", imageDigest: D, metadata: { name: "cache-api", namespace: "shop" },
  spec: { replicas: 1, selector: { matchLabels: { app: "cache-api" } }, template: pod(c) } });

test("IA-1 정상: 흔한 프로브 비밀 꼴은 값 자리만 가린다 (따로 떨어진 인자·sh -c 문자열 둘 다)", () => {
  assert.deepEqual(maskCommandSecrets(["redis-cli", "-a", "s3cr3t", "ping"]), ["redis-cli", "-a", PROBE_HIDDEN, "ping"]);
  assert.deepEqual(maskCommandSecrets(["sh", "-c", "redis-cli -h 127.0.0.1 -a 's3cr3t' ping"]), ["sh", "-c", `redis-cli -h 127.0.0.1 -a ${PROBE_HIDDEN} ping`]);
  assert.deepEqual(maskCommandSecrets(["mysqladmin", "-uroot", "-ps3cr3t", "ping"]), ["mysqladmin", "-uroot", `-p${PROBE_HIDDEN}`, "ping"]);
  assert.deepEqual(maskCommandSecrets(["sh", "-c", "PGPASSWORD=s3cr3t psql -h db -c 'select 1'"]), ["sh", "-c", `PGPASSWORD=${PROBE_HIDDEN} psql -h db -c 'select 1'`]);
  assert.deepEqual(maskCommandSecrets(["curl", "-f", "http://u:s3cr3t@localhost:8080/h"]), ["curl", "-f", `http://u:${PROBE_HIDDEN}@localhost:8080/h`]);
});

test("IA-1 거부: 비밀 아닌 비슷한 꼴은 안 건드린다 (redis-cli -p 포트, mysqladmin -P 포트, pg_isready, 환경변수 참조)", () => {
  assert.equal(maskCommandSecrets(["redis-cli", "-p", "6379", "ping"]), null);
  assert.equal(maskCommandSecrets(["mysqladmin", "ping", "-h", "127.0.0.1", "-P", "3306"]), null);
  assert.equal(maskCommandSecrets(["pg_isready", "-U", "app", "-d", "shop"]), null);
  assert.equal(maskCommandSecrets(["sh", "-c", "redis-cli -a \"$REDIS_PASSWORD\" ping"]), null, "이미 비밀 env 로 옮긴 꼴은 그대로 (고친 뒤 다시 가져와도 검토 줄 없음)");
  assert.equal(maskCommandSecrets(["redis-cli", "-a", "$(REDIS_PASSWORD)", "ping"]), null);
  assert.equal(maskCommandSecrets(["sh", "-c", "PGPASSWORD=${DB_PW} psql -c 'select 1'"]), null);
});

test("IA-1 IR: exec 프로브 비밀 → 명세에 평문 없음, 검토 줄 + unmapped B, checkV2 통과", () => {
  const { result } = normalizeV2(inv([dep({ readinessProbe: { exec: { command: ["redis-cli", "-a", "s3cr3t", "ping"] }, periodSeconds: 5 },
    livenessProbe: { exec: { command: ["sh", "-c", "test -f /tmp/ok"] } } })]));
  assert.ok(!JSON.stringify(result).includes("s3cr3t"), "평문 비밀이 명세·검토 줄 어디에도 없음");
  const c = result.spec.components.find((x) => x.id === "cache-api") as unknown as { props: Raw };
  assert.deepEqual(c.props.probes.readiness.command, ["redis-cli", "-a", PROBE_HIDDEN, "ping"]);
  assert.equal(c.props.probes.readiness.periodSec, 5, "다른 칸은 그대로 이식");
  assert.deepEqual(c.props.probes.liveness.command, ["sh", "-c", "test -f /tmp/ok"], "비밀 없는 프로브는 그대로");
  assert.equal(result.fieldMeta["components.cache-api.probes.readiness"]?.needs_review, true);
  assert.equal(result.fieldMeta["components.cache-api.probes.liveness"], undefined);
  assert.ok(result.unmapped.some((u) => u.resource === "probe:cache-api.readiness" && u.grade === "B"));
  assert.deepEqual(checkV2(result.spec).errors, []);
});

test("IA-1 감사 사본: StatefulSet·DaemonSet·Job·Pod 도 env 값·명령·프로브/훅 exec 를 지운다. 원본은 그대로", () => {
  const c = { env: [{ name: "PW", value: "s3cr3t" }], args: ["--pw=s3cr3t"], readinessProbe: { exec: { command: ["redis-cli", "-a", "s3cr3t", "ping"] } },
    lifecycle: { preStop: { exec: { command: ["sh", "-c", "PGPASSWORD=s3cr3t psql"] } } } };
  const items: Raw[] = [
    { kind: "k8s.statefulset", metadata: { name: "a" }, spec: { template: pod(c) } },
    { kind: "k8s.daemonset", metadata: { name: "b" }, spec: { template: pod(c) } },
    { kind: "k8s.job", metadata: { name: "c" }, spec: { template: pod(c) } },
    { kind: "k8s.pod", metadata: { name: "d" }, spec: pod(c).spec },
    dep(c),
    { kind: "k8s.cronjob", metadata: { name: "e" }, spec: { jobTemplate: { spec: { template: pod(c) } } } },
  ];
  const before = JSON.stringify(items);
  const out = inventoryForAudit(inv(items));
  assert.ok(!JSON.stringify(out).includes("s3cr3t"), JSON.stringify(out).slice(0, 400));
  assert.equal(JSON.stringify(items), before, "원본 안 바뀜 (가져오기 매퍼는 원본을 읽음)");
  const first = (out.items[0] as Raw).spec.template.spec.containers[0];
  assert.deepEqual(first.readinessProbe, { exec: {} }, "프로브 종류(exec)는 남김");
  assert.deepEqual(first.env, [{ name: "PW" }]);
});
