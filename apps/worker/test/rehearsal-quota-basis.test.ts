// 리허설이 도착 할당량을 세는 칸(input.ts QUOTA_BASIS)이 도착 네임스페이스 ResourceQuota 의 hard 칸과 같은지.
//   클라우드·온프레 Terraform = infra/modules/<aws|gcp|onprem>/kinds/namespace/main.tf, 온프레 git 바닥 = gitops/charts/app/templates/floor.yaml
//   도착 네임스페이스에 LimitRange 가 없다는 전제도 같이 본다 (있으면 빈 칸 컨테이너가 기본값을 받아 거부되지 않는다, agent originalUsage)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { RehearsalTarget } from "@svc/contracts";
import { QUOTA_BASIS } from "../src/rehearsal/input.js";

const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const MODULES: Record<RehearsalTarget, string> = {
  "aws-eks": "infra/modules/aws/kinds/namespace/main.tf",
  "gcp-gke": "infra/modules/gcp/kinds/namespace/main.tf",
  "onprem-k3s": "infra/modules/onprem/kinds/namespace/main.tf",
};

test("도착 할당량 기준 = 네임스페이스 모듈의 hard 칸, LimitRange 없음", () => {
  for (const [target, path] of Object.entries(MODULES) as Array<[RehearsalTarget, string]>) {
    const text = repoFile(path);
    const keys = [...text.matchAll(/"((?:requests|limits)\.(?:cpu|memory))"\s*=/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, [`${QUOTA_BASIS[target]}.cpu`, `${QUOTA_BASIS[target]}.memory`], path);
    assert.doesNotMatch(text, /limit_range|LimitRange/, path);
  }
});

test("온프레 git 바닥 floor.yaml 도 같은 기준, 앱 차트에 LimitRange 없음", () => {
  const floor = repoFile("gitops/charts/app/templates/floor.yaml");
  const keys = [...floor.matchAll(/^\s+((?:requests|limits)\.(?:cpu|memory)):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [`${QUOTA_BASIS["onprem-k3s"]}.cpu`, `${QUOTA_BASIS["onprem-k3s"]}.memory`]);
  for (const f of readdirSync(new URL("../../../gitops/charts/app/templates/", import.meta.url)))
    assert.doesNotMatch(repoFile(`gitops/charts/app/templates/${f}`), /kind:\s*LimitRange/, f);
});
