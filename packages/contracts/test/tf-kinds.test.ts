import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PostgresTfVars, NamespaceTfVars, IdentityTfVars, CacheTfVars, ObjectStoreTfVars, QueueTfVars, JobTfVars,
  ModuleInstance, KIND_INTERNAL_OUTPUTS, TF_KIND_VARS, TF_VAR_KINDS, LINK_OUTPUTS,
} from "../src/index.js";

const pg = () => ({
  id: "shop-db", name: "shop-db-a1b2c3", major_version: "16", storage_gb: 20, storage_max_gb: null,
  instance_class: null, ha: null, read_replicas: null, parameters_json: "{}", logical_replication: true as const,
  allow_from_json: '["shop-api"]', public: false, peer_cidrs_json: "[]", public_subnet_ids_json: null,
  deletion_protection: false,
});

test("정상: 데모 DB 값 parse + 나머지 종류 값 parse", () => {
  assert.equal(PostgresTfVars.parse(pg()).id, "shop-db");
  NamespaceTfVars.parse({ name: "shop", quota_cpu_m: null, quota_memory_mi: null });
  IdentityTfVars.parse({ id: "shop-api", name: "app-shop-api", service_account: "shop-api", secret_names_json: "[]" });
  CacheTfVars.parse({ id: "shop-cache", name: "shop-cache-a1", engine: "redis", version: null, memory_mib: 512,
    cluster_mode: null, shards: null, tls: true, auth: true, ha: null, allow_from_json: '["shop-api"]' });
  ObjectStoreTfVars.parse({ id: "shop-uploads", name: "shop-uploads-a1", versioning: false, public: null, size_gb: null,
    lifecycle_json: "[]", cors_json: "[]", allow_from_json: "[]", force_destroy: true });
  QueueTfVars.parse({ id: "shop-jobs", name: "shop-jobs-a1", model: "queue", ordered: null, retention_sec: 345600,
    ack_timeout_sec: null, dead_letter_to: "shop-dlq", dead_letter_max_receive: 5, allow_from_json: "[]" });
  JobTfVars.parse({ id: "shop-clean", name: "shop-clean-a1", schedule: "0 3 * * *", time_zone: null, concurrency_policy: "Forbid",
    suspend: null, backoff_limit: null, active_deadline_sec: null, restart_policy: "OnFailure", image: "r/x@sha256:" + "a".repeat(64),
    command_json: null, args_json: null, cpu_milli: 250, mem_mib: 512, env_json: "[]", identity: "shop-clean" });
  ModuleInstance.parse({ kind: "postgres", id: "shop-db", module: "aws/kinds/postgres" });
});

test("정상: KIND_INTERNAL_OUTPUTS 키 ⊂ 종류, 표 키 = 종류 목록, LINK_OUTPUTS 와 겹치는 이름 없음", () => {
  for (const k of Object.keys(KIND_INTERNAL_OUTPUTS)) assert.ok((TF_VAR_KINDS as readonly string[]).includes(k), k);
  assert.deepEqual(Object.keys(TF_KIND_VARS).sort(), [...TF_VAR_KINDS].sort());
  for (const [k, outs] of Object.entries(KIND_INTERNAL_OUTPUTS)) {
    const link = (LINK_OUTPUTS as Record<string, readonly string[]>)[k] ?? [];
    for (const o of outs) assert.ok(!link.includes(o), `${k}.${o} 는 link_outputs 와 겹치면 안 됨`);
  }
});

test("거부: 모르는 칸(strict)", () => {
  assert.throws(() => PostgresTfVars.parse({ ...pg(), extra: 1 }));
  assert.throws(() => NamespaceTfVars.parse({ name: "x", quota_cpu_m: null, quota_memory_mi: null, foo: true }));
});

test("거부: id 규칙 위반", () => {
  assert.throws(() => PostgresTfVars.parse({ ...pg(), id: "Shop_DB" }));
  assert.throws(() => PostgresTfVars.parse({ ...pg(), id: "a".repeat(41) }));
  assert.throws(() => ModuleInstance.parse({ kind: "postgres", id: "1db", module: "aws/kinds/postgres" }));
});

test("거부: logical_replication false, 모르는 module kind, 빠진 필수 칸", () => {
  assert.throws(() => PostgresTfVars.parse({ ...pg(), logical_replication: false }));
  assert.throws(() => ModuleInstance.parse({ kind: "weird", id: "x", module: "m" }));
  const { major_version: _m, ...rest } = pg();
  assert.throws(() => PostgresTfVars.parse(rest));
  assert.throws(() => QueueTfVars.parse({ id: "q", name: "q", model: "stream", ordered: null, retention_sec: null,
    ack_timeout_sec: null, dead_letter_to: null, dead_letter_max_receive: null, allow_from_json: "[]" }));
});
