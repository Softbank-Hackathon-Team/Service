// FM-CLD-23: 도착 GCP 고정 루트가 쓰는 자원 종류는 전부 권한 표에 있고, API 켜기(serviceusage)는 실행 역할에 들어간다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gcp } from "../src/index.js";

const root = new URL("../../../infra/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const typesIn = (p: string) => [...read(p).matchAll(/resource "(google_[a-z_]+)"/g)].map((m) => m[1]!);

test("FM-CLD-23 정상: gcp root 모듈의 자원 종류 전부 권한 표에 있고 serviceusage 3개가 실행 역할 yaml 에 있음", () => {
  // env/ 은 환경 준비(사람 권한)라 제외. 워커 실행 역할이 도는 건 root/ 와 kinds/
  const used = new Set(typesIn("modules/gcp/root/main.tf"));
  for (const t of used) assert.ok(t in gcp.PERMS, `권한 표에 없음: ${t}`);
  const yaml = read("permissions/gcp-operate-custom-role.yaml");
  for (const p of ["serviceusage.services.enable", "serviceusage.services.get", "serviceusage.services.list"]) assert.ok(yaml.includes(`- ${p}\n`), p);
});

test("FM-CLD-23 거부: serviceusage 는 켜기만 — 끄기(disable)·와일드카드는 실행 역할에 없음", () => {
  const yaml = read("permissions/gcp-operate-custom-role.yaml");
  assert.ok(!/serviceusage\.services\.disable/.test(yaml), "API 끄기 권한이 들어감");
  assert.ok(!/serviceusage\.[a-z.]*\*/.test(yaml), "와일드카드");
  assert.deepEqual(gcp.PERMS.google_project_service!.remove, []);
});
