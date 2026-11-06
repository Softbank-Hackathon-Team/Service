// 고객 배포 Terraform state 위치 (state-backend.ts). 파일만 쓰고 terraform·AWS 는 부르지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStateKey, envStateKey, stateBackend, stateBackendKind } from "../src/index.js";

const TEN = "t-0a1b2c3d";
const MID = "4a8c0000-0000-4000-8000-0000000000ee";
const S3 = { TF_STATE_BACKEND: "s3", TF_STATE_BUCKET: "svc-customer-tfstate", TF_STATE_ROLE_ARN: "arn:aws:iam::111122223333:role/platform-tf-state", TF_STATE_REGION: "ap-northeast-2" };
const tmp = () => mkdtempSync(join(tmpdir(), "tfstate-"));

test("환경변수 없음 → local HCL (지금 경로 그대로), 설정 파일을 안 쓴다", () => {
  const dir = tmp();
  const b = stateBackend({}, { key: appStateKey(TEN, MID), localPath: "../terraform.tfstate", dir });
  assert.equal(b.kind, "local");
  assert.equal(b.hcl, `terraform {\n  backend "local" {\n    path = "../terraform.tfstate"\n  }\n}\n`);
  assert.equal(existsSync(join(dir, "tfstate-aws-config")), false);
  assert.equal(stateBackendKind({ TF_STATE_BACKEND: "local" }), "local");
});

test("s3 → bucket·key·use_lockfile·별도 profile·별도 설정 파일(0600), 고객 AWS_CONFIG_FILE 은 안 본다", () => {
  const dir = tmp();
  const key = appStateKey(TEN, MID);
  assert.equal(key, `tenants/${TEN}/migrations/${MID}/terraform.tfstate`);
  assert.equal(envStateKey(TEN, MID), `tenants/${TEN}/envs/${MID}/terraform.tfstate`);
  const b = stateBackend({ ...S3, AWS_CONFIG_FILE: "/work/customer-aws-config" }, { key, localPath: "../terraform.tfstate", dir });
  assert.equal(b.kind, "s3");
  assert.equal(b.kind === "s3" && b.key, key);
  assert.match(b.hcl, /backend "s3"/);
  assert.match(b.hcl, /bucket\s+= "svc-customer-tfstate"/);
  assert.match(b.hcl, new RegExp(`key\\s+= "${key}"`));
  assert.match(b.hcl, /encrypt\s+= true/);
  assert.match(b.hcl, /use_lockfile\s+= true/);
  assert.match(b.hcl, /profile\s+= "svc-tfstate"/);
  assert.ok(b.hcl.includes(`shared_config_files      = ["${join(dir, "tfstate-aws-config")}"]`));
  assert.ok(b.hcl.includes(`shared_credentials_files = ["${join(dir, "tfstate-aws-credentials")}"]`));
  assert.ok(!b.hcl.includes("customer-aws-config"));
  const cfg = readFileSync(join(dir, "tfstate-aws-config"), "utf8");
  assert.match(cfg, /^\[profile svc-tfstate\]$/m);
  assert.match(cfg, /^role_arn = arn:aws:iam::111122223333:role\/platform-tf-state$/m);
  assert.match(cfg, /^credential_source = EcsContainer$/m);
  assert.match(cfg, /^region = ap-northeast-2$/m);
  assert.equal(readFileSync(join(dir, "tfstate-aws-credentials"), "utf8"), "");
  for (const f of ["tfstate-aws-config", "tfstate-aws-credentials"]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
});

test("거부: s3 인데 BUCKET·ROLE_ARN·REGION 중 하나라도 없음 / 값이 틀린 모양 / TF_STATE_BACKEND 오타", () => {
  const i = { key: appStateKey(TEN, MID), localPath: "../terraform.tfstate", dir: tmp() };
  assert.throws(() => stateBackend({ ...S3, TF_STATE_BUCKET: "" }, i), /TF_STATE_BUCKET/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_ROLE_ARN: undefined }, i), /TF_STATE_ROLE_ARN/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_REGION: " " }, i), /TF_STATE_REGION/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_BUCKET: 'b"\n  key = "x' }, i), /not allowed in HCL/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_ROLE_ARN: "arn:aws:iam::111122223333:role/x\ncredential_process = sh" }, i), /not allowed in HCL/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_BUCKET: "${var.x}" }, i), /not allowed in HCL/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_ROLE_ARN: "not-an-arn" }, i), /IAM role ARN/);
  assert.throws(() => stateBackend({ ...S3, TF_STATE_BACKEND: "S3" }, i), /must be s3/);
  assert.throws(() => stateBackend(S3, { ...i, dir: '/tmp/a"b' }), /not allowed in HCL/);
  assert.equal(existsSync(join(i.dir, "tfstate-aws-config")), false, "거부되면 설정 파일을 안 쓴다");
});

test("거부: 회사가 규칙 밖이거나 id 에 ../·/·공백 → 키를 못 만든다", () => {
  assert.throws(() => appStateKey("../t-0a1b2c3d", MID), /bad tenant/);
  assert.throws(() => appStateKey("T-0A1B2C3D", MID), /bad tenant/);
  assert.throws(() => appStateKey(TEN, `../${MID}`), /bad migration id/);
  assert.throws(() => appStateKey(TEN, `${MID}/x`), /bad migration id/);
  assert.throws(() => envStateKey(TEN, "abc def 1234"), /bad env id/);
  assert.throws(() => stateBackend(S3, { key: `tenants/${TEN}/migrations/../../x/terraform.tfstate`, localPath: "../terraform.tfstate", dir: tmp() }), /bad key/);
  assert.throws(() => stateBackend({}, { key: "other/terraform.tfstate", localPath: "../terraform.tfstate", dir: tmp() }), /bad key/);
});
