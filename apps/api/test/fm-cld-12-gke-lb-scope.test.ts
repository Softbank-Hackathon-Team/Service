// FM-CLD-12: demo-day down 의 GKE LB 고아 지우기 — 같은 프로젝트에 다른 클러스터가 있으면 우리 노드를 가리키는 것만. 클라우드 호출 0 (가짜 gcloud)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const fn = readFileSync(join(ROOT, "tools/demo-day.sh"), "utf8").match(/^gcp_orphans\(\) \{[\s\S]*?^\}$/m)![0];
const OURS = "https://www.googleapis.com/compute/v1/projects/p/zones/asia-northeast3-a/instances/gke-platform-target-default-1a2b";
const THEIRS = "https://www.googleapis.com/compute/v1/projects/p/zones/asia-northeast3-b/instances/gke-other-team-pool-9z";

function run(clusters: string) {
  const d = mkdtempSync(join(tmpdir(), "cld12-"));
  const L = join(d, "calls");
  writeFileSync(join(d, "gcloud"), `#!/bin/sh
echo "$*" >> "${L}"
D="${L}.del"; touch "$D"
case "$*" in *" delete "*) set -- $*; echo "$4" >> "$D"; exit 0 ;; esac
case "$*" in *"container clusters list"*) [ "${clusters}" = FAIL ] && exit 1 ;; esac
{ case "$*" in
  *"container clusters list"*) printf '${clusters}' ;;
  *"target-pools list --filter=description"*"instances"*) printf 'a-ours\\tasia-northeast3\\t${OURS}\\na-theirs\\tasia-northeast3\\t${THEIRS}\\n' ;;
  *"target-pools list --filter=description"*) printf 'a-ours\\tasia-northeast3\\na-theirs\\tasia-northeast3\\n' ;;
  *"forwarding-rules list --filter=target~/targetPools/a-ours"*) printf 'fr-ours\\tasia-northeast3\\n' ;;
  *"forwarding-rules list --filter=description"*) printf 'fr-ours\\tasia-northeast3\\nfr-theirs\\tasia-northeast3\\n' ;;
  *"http-health-checks list"*) printf 'k8s-0123abcd-node\\n' ;;
  *"backend-services list"*) printf 'k8s2-xyz-svc\\tasia-northeast3\\n' ;;
  *"network-endpoint-groups list"*) printf 'k8s2-xyz-neg\\tasia-northeast3-b\\n' ;;
esac; } | while IFS= read -r l; do grep -qx "\${l%%	*}" "$D" || printf '%s\\n' "$l"; done
exit 0
`);
  chmodSync(join(d, "gcloud"), 0o755);
  const r = spawnSync("bash", ["-c", `GCP_PROJECT=p CLUSTER_NAME=platform-target\n${fn}\ngcp_orphans platform-target after`],
    { encoding: "utf8", env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
  const deletes = readFileSync(L, "utf8").split("\n").filter((l) => / delete /.test(l));
  return { rc: r.status, out: r.stdout, deletes };
}

test("FM-CLD-12 정상: 프로젝트에 우리 클러스터뿐이면 예전처럼 GKE LB 고아를 프로젝트 전체에서 지움", () => {
  const r = run("platform-target\\n");
  for (const n of ["fr-ours", "fr-theirs", "a-ours", "a-theirs", "k8s-0123abcd-node", "k8s2-xyz-svc", "k8s2-xyz-neg"])
    assert.ok(r.deletes.some((l) => l.includes(` ${n} `) || l.endsWith(` ${n}`) || l.includes(` delete ${n}`)), `${n} 안 지움`);
});

test("FM-CLD-12 거부: 다른 클러스터가 있거나 목록을 못 읽으면 남의 LB 는 delete 0, 우리 노드 풀·그 전달 규칙만", () => {
  for (const clusters of ["platform-target\\nother-team\\n", "FAIL"]) {
    const r = run(clusters);
    assert.match(r.out, clusters === "FAIL" ? /클러스터 목록을 못 읽음/ : /다른 GKE 클러스터 1개/);
    const names = r.deletes.map((l) => l.split(" ")[3]);
    assert.deepEqual(names.sort(), ["a-ours", "fr-ours"], r.deletes.join("\n"));
    assert.equal(r.rc, 0, r.out);
  }
});
