// DRAFT(ai): 온프레 어댑터(packages/adapters onprem)가 만드는 Helm 값과 Terraform 변수를 그대로 뽑는다.
// Service 루트에서 실행: npx tsx <이 파일> <출력 폴더>
// 데모용 앱 = shop-api (어댑터 fixtures의 온프레 원본과 같은 모양) + Postgres 16 (CNPG)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "@svc/adapters";
import type { AppSpec } from "@svc/contracts";

const onpremAdapter = adapterFor("onprem");
const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });

// 데모 이미지: 로컬 k3d 레지스트리(scripts/01-cluster-up.sh가 만든다)에 올린 podinfo.
// imageRef는 "레지스트리/platform/<테넌트>/<저장소>@<digest>" 규칙이라 digest가 필요하다.
// 04-app-deploy.sh가 실제 digest로 IMAGE_DIGEST를 넘긴다. 없으면 0으로 채운 자리표시
const digest = process.env.IMAGE_DIGEST ?? "sha256:" + "0".repeat(64);

const spec: AppSpec = {
  schemaVersion: "1",
  app: { name: "shop" },
  service: {
    image: `docker.io/stefanprodan/podinfo@${digest}`,
    port: 9898, healthPath: "/healthz", replicas: 1,
    cpu: "250m", memory: "512Mi",
    env: [{ name: "PODINFO_UI_MESSAGE", value: "onprem k3s demo" }],
    secretRefs: [],
  },
  database: { engine: "postgres", majorVersion: "16", storageGb: 1 },
  ingress: { hostname: "shop.onprem.local", entry: "cloudflare-lb" },
} as AppSpec;

const target = {
  envId: "00000000-0000-0000-0000-0000000000e3",
  provider: "onprem" as const,
  region: "local",
  tenantId: process.env.DEMO_TENANT ?? "dev",
  registryHost: process.env.REGISTRY_HOST ?? "k3d-onprem-registry.localhost:5111",
};

const tf = onpremAdapter.toTerraform(spec, target);
const values = onpremAdapter.toHelmValues(spec, {}, target);
writeFileSync(join(out, "onprem.tfvars.json"), JSON.stringify(tf.vars, null, 2) + "\n");
writeFileSync(join(out, "onprem.values.json"), JSON.stringify(values, null, 2) + "\n");
console.log(JSON.stringify({ moduleRef: tf.moduleRef, image: (values as any).image.ref }));
