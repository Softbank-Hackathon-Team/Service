// VTA0: 도착 계약(TA0) 추가 검증 — 경계값, nullable vs 빠짐, JSON Schema, HCL 칸 대조
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  PostgresTfVars, NamespaceTfVars, IdentityTfVars, CacheTfVars, ObjectStoreTfVars, QueueTfVars, JobTfVars,
  ModuleInstance, ModuleKind, TargetPurpose, TF_KIND_VARS, TF_VAR_KINDS,
} from "../src/index.js";

const pg = () => ({
  id: "a".repeat(40), name: "n", major_version: "16", storage_gb: 1, storage_max_gb: 100,
  instance_class: "db.t4g.micro", ha: true, read_replicas: 0, parameters_json: "{}", logical_replication: true as const,
  allow_from_json: "[]", public: false, peer_cidrs_json: "[]", public_subnet_ids_json: "[]", deletion_protection: true,
});
const queue = () => ({ id: "q", name: "q", model: "topic" as const, ordered: null, retention_sec: null, ack_timeout_sec: null,
  dead_letter_to: null, dead_letter_max_receive: null, allow_from_json: "[]" });

test("경계: id 40자 통과, 41자·대문자·밑줄·숫자 시작 거부 (spec-v2 Id 와 같은 규칙)", () => {
  PostgresTfVars.parse(pg());
  for (const bad of ["a".repeat(41), "Abc", "a_b", "1ab", "", "-a"]) assert.throws(() => PostgresTfVars.parse({ ...pg(), id: bad }), bad);
  assert.ok(ModuleInstance.safeParse({ kind: "queue", id: "a", module: "m" }).success);
});

test("nullable 칸은 null 은 받고 빠지거나 undefined 면 거부 (조용히 기본값 안 넣음)", () => {
  assert.ok(PostgresTfVars.safeParse({ ...pg(), instance_class: null, ha: null }).success);
  const { instance_class: _i, ...noInst } = pg();
  assert.equal(PostgresTfVars.safeParse(noInst).success, false);
  assert.equal(PostgresTfVars.safeParse({ ...pg(), ha: undefined }).success, false);
  assert.equal(ObjectStoreTfVars.safeParse({ id: "b", name: "b", versioning: false, public: null, size_gb: null,
    lifecycle_json: "[]", cors_json: "[]", allow_from_json: "[]", force_destroy: false }).success, true);
});

test("숫자 칸: 정수만(storage_gb 1.5 거부), size_gb 음수 거부, 문자열 숫자 거부", () => {
  assert.throws(() => PostgresTfVars.parse({ ...pg(), storage_gb: 1.5 }));
  assert.throws(() => PostgresTfVars.parse({ ...pg(), storage_gb: "20" }));
  const os = { id: "b", name: "b", versioning: false, public: false, size_gb: -1, lifecycle_json: "[]", cors_json: "[]", allow_from_json: "[]", force_destroy: false };
  assert.throws(() => ObjectStoreTfVars.parse(os));
  assert.ok(ObjectStoreTfVars.safeParse({ ...os, size_gb: 0 }).success);
});

test("열거형 거부: 큐 model·잡 정책·캐시 엔진·ModuleKind·목적", () => {
  assert.throws(() => QueueTfVars.parse({ ...queue(), model: "stream" }));
  assert.throws(() => QueueTfVars.parse({ ...queue(), dead_letter_to: "Bad_ID" }));
  assert.ok(QueueTfVars.safeParse({ ...queue(), dead_letter_to: "dlq" }).success);
  assert.throws(() => CacheTfVars.parse({ id: "c", name: "c", engine: "memcache", version: null, memory_mib: null, cluster_mode: null, shards: null, tls: null, auth: null, ha: null, allow_from_json: "[]" }));
  assert.equal(ModuleKind.safeParse("service").success, false);   // service 는 Terraform 종류 아님(차트/ECS 는 A7)
  assert.equal(TargetPurpose.safeParse("plan").success && !TargetPurpose.safeParse("deploy").success, true);
});

test("strict: 종류마다 모르는 칸 거부 + TF_KIND_VARS 가 7종 모두 JSON Schema 로 뽑힘(additionalProperties:false)", () => {
  for (const k of TF_VAR_KINDS) {
    const js = z.toJSONSchema(TF_KIND_VARS[k]) as { additionalProperties?: unknown; required?: string[] };
    assert.equal(js.additionalProperties, false, k);
    assert.ok((js.required?.length ?? 0) > 0, k);
  }
  assert.throws(() => IdentityTfVars.parse({ id: "x", name: "app-x", service_account: "x", secret_names_json: "[]", role_arn: "no" }));
  assert.throws(() => JobTfVars.parse({}));
  assert.throws(() => NamespaceTfVars.parse({ name: "x", quota_cpu_m: 1.5, quota_memory_mi: null }));
});

// HCL 대조(terraform 안 돌림): kinds 모듈이 읽는 cfg.<칸> 이 TfVars 에 있는지
const infra = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/modules");
const DIR: Record<string, string> = { postgres: "postgres", identity: "identity", namespace: "namespace" };
const usedCfg = (p: string, d: string) => {
  const src = readFileSync(join(infra, p, "kinds", d, "main.tf"), "utf8");
  return [...new Set([...src.matchAll(/\bcfg\.([a-z_]+)/g)].map((m) => m[1]!))].sort();
};
test("HCL 대조: postgres·identity·namespace kinds 가 읽는 칸 ⊂ TfVars 칸 (aws·gcp)", () => {
  for (const p of ["aws", "gcp"]) for (const [kind, d] of Object.entries(DIR)) {
    const fields = Object.keys((TF_KIND_VARS as Record<string, z.ZodObject>)[kind]!.shape);
    for (const f of usedCfg(p, d)) assert.ok(fields.includes(f), `${p}/${d}: HCL 이 읽는 cfg.${f} 가 ${kind} TfVars 에 없음`);
  }
});
