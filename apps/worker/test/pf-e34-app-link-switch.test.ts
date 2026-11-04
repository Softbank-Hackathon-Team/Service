// PF-E34 APP-22 (가) DECISION(team, 11/4 01:57Z): 컷오버 전까지 도착 앱은 출발 DB, 컷오버 때 도착 DB 로. DB 없이 판정만
//   - 사전 점검: 도착 앱 → 출발 DB 경로가 없으면 block (PC-APPLINK-PATH)
//   - 컷오버: 바꿀 길이 없으면 울타리 전에 멈춤 (cutoverAppLinkBlock)
//   - PF RV-28: 진짜 판 + postgres 명세면 출발 복제 점검을 못 본 채 통과시키지 않음
import { test } from "node:test";
import assert from "node:assert/strict";
import { appLinkPrecheck, replSourcePrecheck } from "../src/jobs/precheck.js";
import { appLinkMeans, cutoverAppLinkBlock } from "../src/app-link.js";

const BASE = { REPL_SOURCE_URL: "postgres://u:p@src.example:5432/shop", GITOPS_REPO_DIR: "/tmp/gitops-e34" };
const ids = (xs: { id: string; level: string }[]) => xs.map((x) => `${x.id}:${x.level}`);

test("PF-E34 정상: 경로(SOURCE_DB_LINK=real 또는 닿는 APP_LINK_SOURCE_URL)와 GitOps 가 있으면 점검 통과, 컷오버도 진행", () => {
  assert.deepEqual(appLinkPrecheck({ ...BASE, SOURCE_DB_LINK: "real" }, { terraformRuntime: false, targetProvider: "gcp" }), []);
  assert.deepEqual(appLinkPrecheck({ ...BASE, APP_LINK_SOURCE_URL: "postgres://10.20.0.5:5432/shop" }, { terraformRuntime: false, targetProvider: "gcp" }), []);
  // 기본 켬 (APP_LINK 를 안 줘도)
  assert.equal(appLinkMeans({}).on, true);
  assert.equal(cutoverAppLinkBlock({ on: true, proxy: false, appKind: "gitops", bundle: true }), null);
  assert.equal(cutoverAppLinkBlock({ on: true, proxy: false, appKind: "no_app", bundle: false }), null, "앱을 안 올린 이전은 바꿀 게 없음");
  assert.equal(cutoverAppLinkBlock({ on: true, proxy: true, appKind: "terraform_runtime", bundle: false }), null, "프록시가 있으면 빠른 길");
});

test("PF-E34 거부: 경로가 없거나 못 닿는 주소·전환 수단 없음이면 block, 컷오버는 울타리 전에 멈춤", () => {
  assert.deepEqual(ids(appLinkPrecheck(BASE, { terraformRuntime: false, targetProvider: "gcp" })), ["PC-APPLINK-PATH:block"]);
  assert.deepEqual(ids(appLinkPrecheck({ ...BASE, APP_LINK_SOURCE_URL: "postgres://localhost:5432/shop" }, { terraformRuntime: false, targetProvider: "aws" })), ["PC-APPLINK-PATH:block"]);
  assert.deepEqual(ids(appLinkPrecheck({ ...BASE, APP_LINK_SOURCE_URL: "postgres://{tf:db_address}:5432/shop" }, { terraformRuntime: false, targetProvider: "gcp" })), ["PC-APPLINK-PATH:block"]);
  // Terraform 실행 방식은 손으로 준 경로에 계정·비밀번호·DB 이름이 있어야 한다 (도착 그릇에 넣을 값)
  assert.deepEqual(ids(appLinkPrecheck({ REPL_SOURCE_URL: BASE.REPL_SOURCE_URL, APP_LINK_SOURCE_URL: "postgres://10.0.0.5:5432/shop" }, { terraformRuntime: true, targetProvider: "aws" })), ["PC-APPLINK-PATH:block"]);
  // 끄면(시험 전용) 안 본다
  assert.deepEqual(appLinkPrecheck({ ...BASE, APP_LINK: "0" }, { terraformRuntime: false, targetProvider: "gcp" }), []);
  assert.match(String(cutoverAppLinkBlock({ on: true, proxy: false, appKind: "gitops", bundle: false })), /no GitOps bundle/);
  assert.match(String(cutoverAppLinkBlock({ on: true, proxy: false, appKind: "terraform_runtime", bundle: true })), /terraform runtime/);
  assert.deepEqual(appLinkPrecheck({ REPL_SOURCE_URL: BASE.REPL_SOURCE_URL, APP_LINK_SOURCE_URL: "postgres://u:p@10.0.0.5:5432/shop" }, { terraformRuntime: true, targetProvider: "aws" }), []);
});

test("PF RV-28: 진짜 판 + postgres 명세면 출발 주소 없음·접속 실패가 block (예전: 0개·warn 으로 통과)", async () => {
  assert.deepEqual(ids(await replSourcePrecheck({}, { required: true })), ["PC-REPL-CONN:block"]);
  assert.deepEqual(ids(await replSourcePrecheck({ REPL_SOURCE_URL: "postgres://u:p@127.0.0.1:1/x" }, { required: true })), ["PC-REPL-CONN:block"]);
  assert.deepEqual(await replSourcePrecheck({}), []);
});
