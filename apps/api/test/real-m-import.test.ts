// M-import 컨테이너 단위 시험 (상태: AI 초안). 맥 없이: 샘플 매니페스트 → 가짜 kubectl(JSON) → 진짜 discover·normalizeV2 → 대조 PASS,
//   그리고 Builder 산출물이 세 도착 모두 그려지는지. 거부: 비밀 값이 명세에 섞이면·링크가 없으면 FAIL
// 대상: tools/real/m-import (레포 안 실측 흐름). npm test 에 들어간다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { discoverOnprem, normalizeV2 } from "@svc/adapters";
import { checkImport, SAMPLE } from "../../../tools/real/m-import/check-import.js";
import { renderAll } from "../../../tools/real/m-import/render-v2.js";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../../tools/real/m-import");
const NS = "m-import-test";
const D = (c: string) => `sha256:${c.repeat(64)}`;
const SECRET = "s3cr3t-value-only-in-cluster-0123";

function manifests() {
  const tpl = readFileSync(join(here, "sample-3tier.yaml.tpl"), "utf8").replaceAll("__NS__", NS)
    .replaceAll("__WEB_IMAGE__", `docker.io/library/nginx@${D("a")}`).replaceAll("__API_IMAGE__", `docker.io/hashicorp/http-echo@${D("b")}`)
    .replaceAll("__PG_IMAGE__", "ghcr.io/cloudnative-pg/postgresql:16.6");
  return parseAllDocuments(tpl).map((d) => d.toJSON()).filter(Boolean) as Array<{ kind: string; metadata: { name: string } }>;
}

// kubectl get <종류> -n NS -o json → 매니페스트 중 그 종류. 클러스터가 실제로 갖는 것만 흉내 (ConfigMap 값·Secret 은 리더가 안 씀)
function fakeExec(extra: Array<{ kind: string }> = []) {
  const docs = [...manifests(), ...extra];
  const by: Record<string, string> = { deployments: "Deployment", services: "Service", ingresses: "Ingress", horizontalpodautoscalers: "HorizontalPodAutoscaler",
    cronjobs: "CronJob", networkpolicies: "NetworkPolicy", serviceaccounts: "ServiceAccount", configmaps: "ConfigMap", pods: "Pod",
    "clusters.postgresql.cnpg.io": "Cluster" };
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd !== "kubectl" || args[0] !== "get") return { code: 1, stdout: "", stderr: "읽기만", ms: 1 };
    if (args[1] === "nodes") return { code: 0, stdout: JSON.stringify({ items: [{ metadata: { name: "k3d-onprem-server-0" }, status: { nodeInfo: { kubeletVersion: "v1.31.5+k3s1" }, allocatable: { cpu: "4", memory: "8Gi" } } }] }), stderr: "", ms: 1 };
    const kind = by[args[1]!];
    if (!kind) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "", ms: 1 };
    return { code: 0, stdout: JSON.stringify({ items: docs.filter((d) => d.kind === kind) }), stderr: "", ms: 1 };
  };
  return { exec, calls };
}

async function importView(extra: Array<{ kind: string }> = []) {
  const { exec, calls } = fakeExec(extra);
  const inv = await discoverOnprem({ exec: exec as never, env: { ONPREM_KUBE_CONTEXT: "k3d-onprem", IMPORT_NAMESPACE: NS } }, {});
  const r = normalizeV2(inv).result;
  return { view: { specV2: r.spec, fieldMetaV2: r.fieldMeta }, calls, unmapped: r.unmapped };
}

test("정상: 샘플 3티어 매니페스트 → discover(v2)·normalizeV2 → 대조 전부 PASS, kubectl 은 get 만·지정 context", async () => {
  const { view, calls, unmapped } = await importView();
  // 읽기만: get 과 api-resources(목록 가능한 자원 종류 조회, 지금 discover 가 먼저 부름)
  assert.ok(calls.every((c) => / (get|api-resources) /.test(` ${c} `) && c.includes("--context k3d-onprem")), calls.join("\n"));
  const rows = checkImport(view, { namespace: NS, secretValue: SECRET, digests: { web: D("a"), api: D("b") } });
  const bad = rows.filter((r) => r.result === "FAIL");
  assert.deepEqual(bad, [], JSON.stringify(rows, null, 1));
  assert.ok(rows.filter((r) => r.result === "PASS").length >= 15);
  assert.deepEqual(unmapped, []);
});

test("정상: Builder v2 산출물 — aws·gcp·onprem 다 그려지고 파일 4개씩, 비밀 값 없음", async () => {
  const { view } = await importView();
  const out = mkdtempSync(join(tmpdir(), "m-import-"));
  const rows = renderAll(view.specV2, out, "11111111-1111-4111-8111-111111111111", {});
  assert.deepEqual(rows.map((r) => [r.provider, r.result]), [["aws", "PASS"], ["gcp", "PASS"], ["onprem", "PASS"]], JSON.stringify(rows));
  for (const p of ["aws", "gcp", "onprem"]) for (const f of ["terraform.tfvars.json", "values.json", "call.json", "missing.txt"]) assert.ok(existsSync(join(out, p, f)), `${p}/${f}`);
  // 사실이 없으면 aws 는 계정·VPC 등이 남음 → m-import.sh 가 plan 을 SKIP
  assert.ok(rows[0]!.missing.includes("accountId"));
  const v = JSON.parse(readFileSync(join(out, "onprem", "values.json"), "utf8"));
  // ChartWorkload 이름 칸은 name (= IR 부품 id). 옛 id 칸은 없어짐
  assert.deepEqual(v.workloads.map((w: { name: string }) => w.name).sort(), [SAMPLE.api, SAMPLE.web].sort());
  // TF_FACT_* 를 주면 채움
  const filled = renderAll(view.specV2, mkdtempSync(join(tmpdir(), "m-import-")), "t", { TF_FACT_ACCOUNT_ID: "000000000000" });
  assert.equal(filled[0]!.missing.includes("accountId"), false);
});

test("거부: 비밀 값이 명세에 섞이면 FAIL, 링크·digest 가 다르면 FAIL, 모양이 깨지면 FAIL", async () => {
  const { view } = await importView();
  const leaked = structuredClone(view) as { specV2: { components: Array<{ id: string; props: { env: unknown[] } }> } };
  leaked.specV2.components.find((c) => c.id === SAMPLE.api)!.props.env.push({ name: "LEAK", value: SECRET });
  const r1 = checkImport(leaked, { namespace: NS, secretValue: SECRET });
  assert.ok(r1.some((r) => r.result === "FAIL" && /Secret 값/.test(r.item)));
  const nolink = structuredClone(view) as { specV2: { links: unknown[] } };
  nolink.specV2.links = [];
  assert.ok(checkImport(nolink, { namespace: NS }).some((r) => r.result === "FAIL" && /DB 링크/.test(r.item)));
  assert.ok(checkImport(view, { namespace: NS, digests: { web: D("f") } }).some((r) => r.result === "FAIL" && /digest/.test(r.item)));
  assert.deepEqual(checkImport({ specV2: { nope: 1 } }, { namespace: NS }).map((r) => r.result), ["FAIL"]);
});
