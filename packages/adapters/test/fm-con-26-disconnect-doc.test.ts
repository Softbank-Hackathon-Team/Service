// FM-CON-hunt-cloud-26: 연결 끊기 안내가 연결 스크립트가 만드는 것(SA·커스텀 역할·빌리기 허용)을 빠짐없이 지우게 하는가. 문서·스크립트 대조만 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("../../../infra/onboarding/", import.meta.url);
const sh = readFileSync(new URL("gcp-connect.sh", dir), "utf8");
const readme = readFileSync(new URL("README.md", dir), "utf8");

/** 연결 스크립트가 만드는 역할·SA 중 끊기 절에 안 나온 것 */
function missingInDisconnect(doc: string): string[] {
  const sec = doc.slice(doc.indexOf("## 연결 끊기"));
  if (!doc.includes("## 연결 끊기")) return ["## 연결 끊기"];
  const roles = [...new Set([...sh.matchAll(/^ensure_role (platform_[a-z_]+)/gm)].map((m) => m[1]!))];
  const sas = [...new Set([...sh.matchAll(/^[A-Z_]*SA="(svc-[a-z]+)@\$\{(?:TARGET_)?PROJECT_ID\}/gm)].map((m) => m[1]!))].filter((x) => !/OLD/.test(x));
  const need = [...roles, ...sas, "remove-iam-policy-binding", "roles/iam.serviceAccountTokenCreator", "service-accounts delete", "roles delete", "delete-stack"];
  return need.filter((n) => !sec.includes(n));
}

test("FM-CON-26 정상: 끊기 절에 스크립트가 만드는 역할 6개·SA 3개·빌리기 허용 걷기·AWS 스택 삭제가 다 있음", () => {
  const roles = [...new Set([...sh.matchAll(/^ensure_role (platform_[a-z_]+)/gm)].map((m) => m[1]!))];
  assert.ok(roles.length >= 6, roles.join(","));
  assert.deepEqual(missingInDisconnect(readme), []);
});

test("FM-CON-26 거부: 역할 하나·빌리기 걷기 명령이 빠진 문서는 잡아냄", () => {
  assert.deepEqual(missingInDisconnect(readme.replace(/platform_operate_db_secret/g, "x")), ["platform_operate_db_secret"]);
  assert.ok(missingInDisconnect(readme.replace(/remove-iam-policy-binding/g, "x")).includes("remove-iam-policy-binding"));
  assert.deepEqual(missingInDisconnect(readme.replace("## 연결 끊기", "## 그 밖")), ["## 연결 끊기"]);
});
