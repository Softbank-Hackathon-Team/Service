import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppSpec, Provider } from "@svc/contracts";
import { adapterFor, DEMO_INVENTORY } from "../src/index.js";

// 어댑터 toTerraform() 결과를 tfvars.json으로 쓴다 → terraform test -var-file 로 모듈과 맞물리는지 확인
// 실행: npx tsx packages/adapters/scripts/write-tfvars.ts <출력 폴더>
const outDir = process.argv[2] ?? "tfvars";
mkdirSync(outDir, { recursive: true });
// 데모용 가짜 연결 정보 (자리표시를 채운 상태 = apply 직전 모양)
const extras = { tenantId: "t-demo", migrationId: "m-demo", accountId: "111122223333", projectId: "demo-proj",
  networkId: "projects/demo-proj/global/networks/platform-target", vpcId: "vpc-0123456789abcdef0",
  subnetIds: ["subnet-0aaa", "subnet-0bbb"], clusterName: "platform-target", clusterLocation: "asia-northeast3-a" };
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-platform";
const AZURE_FAKE: Record<string, string> = {
  resource_group: "rg-platform",
  delegated_subnet_id: `${SUB}/providers/Microsoft.Network/virtualNetworks/vnet/subnets/pg`,
  private_dns_zone_id: `${SUB}/providers/Microsoft.Network/privateDnsZones/platform.postgres.database.azure.com`,
  azure_tenant_id: "00000000-0000-0000-0000-000000000000",
  aks_oidc_issuer_url: "https://oidc.example.com/",
};
for (const p of Provider.options) {
  const src = p === "azure_mock" ? "aws" : p;
  const spec = AppSpec.parse(adapterFor(src).normalize(DEMO_INVENTORY[src]).spec);
  const t = { envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", ...extras };
  const { vars } = adapterFor(p).toTerraform(spec, t);
  // 아직 남은 자리표시(Azure 부트스트랩 값)는 모양만 맞춘 가짜 값으로
  const filled = Object.fromEntries(Object.entries(vars).map(([k, v]) =>
    [k, typeof v === "string" && v.startsWith("<env:") ? (AZURE_FAKE[k] ?? "mock") : v]));
  writeFileSync(join(outDir, `${p}.tfvars.json`), JSON.stringify(filled, null, 2));
}
console.log(`tfvars → ${outDir}`);
