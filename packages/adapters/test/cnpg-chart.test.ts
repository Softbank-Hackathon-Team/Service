// CNPG 차트 회귀: cnpg.yaml 에 옛 v1 블록($db)과 v2 블록($pg)이 같이 남아 lint 가 깨졌던 일을 다시 막는다.
// 정적 검사(helm 없어도 돎) + helm 있으면 렌더해서 postgres[] mode cnpg 한 줄당 Cluster 가 정확히 하나인지 본다. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChartValues } from "@svc/contracts";

const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const SRC = readFileSync(join(CHART, "templates/cnpg.yaml"), "utf8");
const HELM = process.env.HELM_BIN ?? "helm";
const hasHelm = (() => { try { execFileSync(HELM, ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();

// 템플릿 문자열에서 주석을 빼고 블록 열고 닫힘을 센다 (어긋나면 helm 이 `unexpected {{end}}` 를 낸다)
const blockDepth = (s: string) => {
  const body = s.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "");
  let d = 0, min = 0;
  for (const m of body.matchAll(/\{\{-?\s*(range|if|with|define|block|end)\b/g)) { d += m[1] === "end" ? -1 : 1; min = Math.min(min, d); }
  return { d, min };
};
const clusterKinds = (s: string) => (s.match(/^kind: Cluster$/gm) ?? []).length;

const base = (postgres: unknown[]) => ChartValues.parse({
  app: { name: "shop" }, namespace: "shop", labels: {}, workloads: [],
  externalSecrets: { store: { kind: "ClusterSecretStore", name: "store" }, secrets: [] },
  postgres, warnings: [],
});
const cnpg = (name: string) => ({ id: name, mode: "cnpg", name, instances: 1, majorVersion: "16", storageGb: 10,
  host: `${name}-rw`, port: 5432, passwordSecret: `${name}-app`, database: "app", owner: "app" });
const render = (v: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "cnpg-")); const f = join(dir, "values.json"); writeFileSync(f, JSON.stringify(v));
  return execFileSync(HELM, ["template", "rel", CHART, "-f", f, "--show-only", "templates/cnpg.yaml"], { encoding: "utf8" });
};

test("CNPG 정적: cnpg.yaml 은 Cluster 를 한 군데서만 그리고, 블록 열고 닫힘이 맞는다 (옛 $db 블록 없음)", () => {
  assert.equal(clusterKinds(SRC), 1);
  assert.equal((SRC.match(/range \$\w+ := \(?\.Values\.(postgres|database)\b/g) ?? []).length, 1);
  assert.doesNotMatch(SRC, /range \$db\b/);
  assert.deepEqual(blockDepth(SRC), { d: 0, min: 0 });
});

test("CNPG 정적 거부: 옛 블록이 겹쳐 남은 모양은 검사가 잡는다", () => {
  const dup = SRC + "\n{{- end }}\n---\nkind: Cluster\n";
  assert.equal(clusterKinds(dup), 2);
  assert.ok(blockDepth(dup).min < 0);
});

test("CNPG helm: mode cnpg 한 줄 = Cluster 하나 (두 줄이면 두 개, 이름 그대로)", { skip: hasHelm ? false : "helm 없음" }, () => {
  const one = render(base([cnpg("orders-db")]));
  assert.equal(clusterKinds(one), 1, one);
  assert.match(one, /^  name: orders-db$/m);
  const two = render(base([cnpg("orders-db"), cnpg("users-db")]));
  assert.equal(clusterKinds(two), 2, two);
  assert.match(two, /^  name: users-db$/m);
});

test("CNPG helm 거부: external(관리형) 만 있으면 Cluster 를 안 그린다", { skip: hasHelm ? false : "helm 없음" }, () => {
  const ext = base([{ id: "rds", mode: "external", host: "db.example.internal", port: 5432, passwordSecret: "x", secretName: "rds-app" }]);
  let out = "";
  try { out = render(ext); } catch (e: any) { out = String(e.stdout ?? ""); assert.match(String(e.stderr ?? ""), /could not find template|no template/i); }
  assert.equal(clusterKinds(out), 0, out);
});
