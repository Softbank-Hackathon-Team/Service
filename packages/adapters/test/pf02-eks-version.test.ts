// PF02 FM-CLD-11: 출발 EKS(aws/env) 기본 버전이 연장 지원이 아니고, 이미 있는 클러스터 버전은 안 건드리며, up-preflight 가 연장 지원을 FAIL 로 막는다
// (terraform 레지스트리가 막힌 곳에서도 도는 글자 검사. 진짜 plan 은 맥 terraform test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const def = (tf: string, v: string) => tf.match(new RegExp(`variable "${v}" \\{[^}]*default\\s*=\\s*"([^"]+)"`))?.[1];

test("aws/env 기본 k8s_version = aws/platform 과 같고 1.33(연장 지원) 아님, 새 클러스터는 STANDARD", () => {
  const env = read("infra/modules/aws/env/main.tf"), plat = read("infra/modules/aws/platform/main.tf");
  assert.equal(def(env, "k8s_version"), def(plat, "k8s_version"));
  assert.notEqual(def(env, "k8s_version"), "1.33");
  const cluster = env.slice(env.indexOf('resource "aws_eks_cluster" "this"'), env.indexOf('resource "aws_eks_node_group"'));
  assert.match(cluster, /upgrade_policy\s*\{\s*support_type\s*=\s*"STANDARD"/);
});

test("거부(안전): 이미 있는 클러스터는 버전·지원 정책을 바꾸지 않음 (ignore_changes), node group 은 버전 고정 없음", () => {
  const env = read("infra/modules/aws/env/main.tf");
  const cluster = env.slice(env.indexOf('resource "aws_eks_cluster" "this"'), env.indexOf('resource "aws_eks_node_group"'));
  assert.match(cluster, /ignore_changes\s*=\s*\[version,\s*upgrade_policy\]/);
  const ng = env.slice(env.indexOf('resource "aws_eks_node_group" "default"'), env.indexOf('resource "aws_eks_addon"'));
  assert.ok(!/\bversion\s*=/.test(ng));
});

test("up-preflight: 연장 지원은 FAIL (ALLOW_EKS_EXTENDED=1 일 때만 WARN), 기본값 대체도 1.35", () => {
  const sh = read("tools/up-preflight.sh");
  const line = sh.split("\n").find((l) => l.includes("EXTENDED_SUPPORT)"))!;
  assert.match(line, /ALLOW_EKS_EXTENDED/);
  assert.match(sh, /else fail eks-version "EKS \$k8sv 연장 지원/);
  assert.match(sh, /k8sv=\$\{k8sv:-1\.35\}/);
});
