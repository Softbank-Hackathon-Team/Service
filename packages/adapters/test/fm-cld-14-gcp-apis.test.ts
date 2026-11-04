// FM-CLD-14: IR 종류로 GCP API 를 정하고 terraform 이 켠다 (손으로 gcloud services enable 하지 않음). TS 표와 gcp/root·gcp/env 의 표가 같은지 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GCP_KIND_APIS, GCP_ENV_APIS, gcpRequiredApis, gcpKindsOfVars } from "../src/index.js";

const root = readFileSync(new URL("../../../infra/modules/gcp/root/main.tf", import.meta.url), "utf8");
const env = readFileSync(new URL("../../../infra/modules/gcp/env/main.tf", import.meta.url), "utf8");
const LOCAL: Record<string, string> = { postgres: "postgres", identity: "identity", cache: "cache", object_store: "object_store", queue: "queue_all", service: "service", job: "job", vm: "vm" };

test("gcp/root locals.required_apis 가 TS 표(GCP_KIND_APIS)와 종류마다 같다", () => {
  const block = /required_apis = sort\(distinct\(concat\(([\s\S]*?)\)\)\)/.exec(root)?.[1] ?? "";
  assert.ok(block, "required_apis 없음");
  for (const [kind, apis] of Object.entries(GCP_KIND_APIS)) {
    const m = new RegExp(`length\\(local\\.${LOCAL[kind]}\\) > 0 \\? \\[([^\\]]*)\\]`).exec(block);
    assert.ok(m, kind);
    assert.deepEqual([...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort(), [...apis].sort(), kind);
  }
  // 켜는 자원이 있고, 지울 때 끄지 않으며, 모든 종류 모듈이 그 뒤에 돈다
  assert.match(root, /resource "google_project_service" "required" \{[\s\S]*?for_each\s*= toset\(local\.required_apis\)[\s\S]*?disable_on_destroy\s*= false/);
  for (const m of root.matchAll(/^module "([a-z_]+)" \{([\s\S]*?)^\}/gm)) assert.match(m[2]!, /depends_on\s*= \[google_project_service\.required/, m[1]!);
});

test("gcp/env 가 앱 층 전에 필요한 API(iam·iamcredentials·compute…)를 켠다 = GCP_ENV_APIS", () => {
  const block = /resource "google_project_service" "apis" \{\s*for_each = toset\(\[([\s\S]*?)\]\)/.exec(env)?.[1] ?? "";
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort(), [...GCP_ENV_APIS].sort());
});

test("3티어 IR(postgres·identity) → sqladmin·secretmanager·iam, 캐시·큐가 오면 redis·pubsub 가 더해짐, 빈 종류는 아무것도 안 켬", () => {
  const vars = { postgres_json: JSON.stringify([{ id: "db" }]), identity_json: JSON.stringify([{ id: "api" }]), cache_json: "[]", queue_json: "[]", object_store_json: "[]" };
  assert.deepEqual(gcpKindsOfVars(vars), ["postgres", "identity"]);
  assert.deepEqual(gcpRequiredApis(gcpKindsOfVars(vars)), ["iam.googleapis.com", "secretmanager.googleapis.com", "sqladmin.googleapis.com"]);
  const more = { ...vars, cache_json: JSON.stringify([{ id: "c" }]), queue_json: JSON.stringify([{ id: "q" }]) };
  assert.ok(gcpRequiredApis(gcpKindsOfVars(more)).includes("redis.googleapis.com"));
  assert.ok(gcpRequiredApis(gcpKindsOfVars(more)).includes("pubsub.googleapis.com"));
  assert.deepEqual(gcpRequiredApis([]), []);
  assert.deepEqual(gcpKindsOfVars({ postgres_json: "not json" }), []);
});

test("거부: 사전 점검 셸이 iam·iamcredentials·sqladmin 등을 FAIL(손 켜기 요구)로 보지 않는다 — serviceusage 만 FAIL", () => {
  const sh = readFileSync(new URL("../../../tools/cloud-precheck.sh", import.meta.url), "utf8");
  const miss = /for a in ([a-z ]+); do echo "\$out" \| grep -qx "\$a\.googleapis\.com" \|\| miss=/.exec(sh)?.[1]?.trim();
  assert.equal(miss, "serviceusage");
});
