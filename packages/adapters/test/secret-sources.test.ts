// SS-V: k8s Secret 밖 비밀 저장소(ESO ExternalSecret·Vault Agent 주입) 출발 읽기 → IR secretSources + 계획 사람 확인 줄. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { v2Blockers } from "../src/target/shared.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "cd".repeat(32);
type Raw = Record<string, any>;
const run = (items: Raw[]) => normalizeV2({ provider: "onprem", coverage: {}, items } as RawInventory).result;
const dep = (name: string, c: Raw = {}, podAnnotations?: Record<string, string>): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
    ...(podAnnotations ? { podAnnotations } : {}), containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], ...c }] } } },
});
const es = (name: string, target: string | undefined, store = { kind: "ClusterSecretStore", name: "aws-sm" }): Raw => ({
  kind: "k8s.externalSecret", metadata: { name, namespace: "shop" },
  spec: { store, target: target ?? name, data: [{ key: "password", remote: "prod/shop/db", property: "password" }], dataFrom: [] },
});
const wl = (r: ReturnType<typeof run>, id: string) => r.spec.components.find((c) => c.id === id) as any;

test("SS-V ESO: ExternalSecret 이 만드는 Secret 을 쓰는 워크로드 → secretSources(via eso, store·원격 키) + 계획 사람 확인 줄", () => {
  const r = run([
    dep("api", { env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db-cred", key: "password" } } }] }),
    es("db-cred", undefined),
    { ...es("local", "local-cred", { kind: "SecretStore", name: "vault-local" }) },
    { kind: "k8s.secretStore", metadata: { name: "vault-local", namespace: "shop" }, provider: "vault" },
  ]);
  assert.equal(ImportResultV2.safeParse(r).success, true, JSON.stringify(ImportResultV2.safeParse(r).error?.issues?.slice(0, 3)));
  assert.deepEqual(wl(r, "api").props.secretSources, [{ via: "eso", secret: "db-cred", store: "ClusterSecretStore/aws-sm", refs: [{ key: "password", remote: "prod/shop/db", property: "password" }] }]);
  assert.equal(r.fieldMeta["components.api.secretSources.db-cred"]!.needs_review, true);
  // 아무도 안 쓰는 ExternalSecret 은 unmapped B
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.externalSecret:shop/local" && u.grade === "B"));
  const b = v2Blockers(AppSpecV2.parse(r.spec), []);
  assert.ok(b.needsHuman.some((l) => /^api: 출발 비밀이 외부 저장소\(ESO ClusterSecretStore\/aws-sm\)/.test(l)), b.needsHuman.join("\n"));
  assert.ok(!b.unsupported.some((l) => /secretSources/.test(l)));
});

test("SS-V Vault Agent: 주입 annotation → secretSources(via vault-agent, role·파일→경로)", () => {
  const r = run([dep("api", {}, {
    "vault.hashicorp.com/agent-inject": "true", "vault.hashicorp.com/role": "shop-api",
    "vault.hashicorp.com/agent-inject-secret-db.txt": "secret/data/shop/db" })]);
  assert.equal(ImportResultV2.safeParse(r).success, true);
  const s = wl(r, "api").props.secretSources;
  assert.equal(s.length, 1);
  assert.equal(s[0].via, "vault-agent");
  assert.equal(s[0].role, "shop-api");
  assert.deepEqual(s[0].refs, [{ key: "db.txt", remote: "secret/data/shop/db" }]);
  assert.ok(v2Blockers(AppSpecV2.parse(r.spec), []).needsHuman.some((l) => /Vault Agent role shop-api/.test(l)));
});

test("SS-V 거부: 외부 저장소가 없으면 secretSources 를 만들지 않고 사람 확인 줄도 없음 (agent-inject=false 포함)", () => {
  const r = run([dep("api", { env: [{ name: "X", valueFrom: { secretKeyRef: { name: "plain", key: "x" } } }] }, { "vault.hashicorp.com/agent-inject": "false" })]);
  assert.equal(wl(r, "api").props.secretSources, undefined);
  assert.ok(!v2Blockers(AppSpecV2.parse(r.spec), []).needsHuman.some((l) => /외부 저장소/.test(l)));
});

test("SS-V discover: ESO CRD 가 있으면 ExternalSecret·SecretStore 를 읽고 (CRD 목록엔 안 넣음) store 인증 칸은 안 담음", async () => {
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    const out = (o: unknown) => ({ code: 0, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "", ms: 1 });
    if (/^kubectl api-resources /.test(line)) return out("externalsecrets.external-secrets.io\nsecretstores.external-secrets.io\n");
    if (/^kubectl get deployments /.test(line)) return out({ items: [{ metadata: { name: "api", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, template: { metadata: { labels: { app: "api" },
      annotations: { "vault.hashicorp.com/agent-inject": "true", "vault.hashicorp.com/agent-inject-secret-db": "secret/db" } }, spec: { containers: [{ name: "api", image: `ghcr.io/demo/api@${D}` }] } } } }] });
    if (/^kubectl get externalsecrets\.external-secrets\.io -n shop /.test(line))
      return out({ items: [{ metadata: { name: "db-cred", namespace: "shop" }, spec: { secretStoreRef: { name: "vault-local", kind: "SecretStore" }, data: [{ secretKey: "password", remoteRef: { key: "shop/db", property: "pw" } }] } }] });
    if (/^kubectl get secretstores\.external-secrets\.io -n shop /.test(line))
      return out({ items: [{ metadata: { name: "vault-local", namespace: "shop" }, spec: { provider: { vault: { server: "https://vault", auth: { tokenSecretRef: { name: "t", key: "token" } } } } } }] });
    if (/^kubectl get \S+ -n /.test(line)) return out({ items: [] });
    return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
  };
  const r = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: "shop" } }, []);
  const e = r.items.find((i) => i.kind === "k8s.externalSecret") as any;
  assert.deepEqual(e.spec, { store: { kind: "SecretStore", name: "vault-local" }, target: "db-cred", data: [{ key: "password", remote: "shop/db", property: "pw" }], dataFrom: [] });
  const s = r.items.find((i) => i.kind === "k8s.secretStore") as any;
  assert.equal(s.provider, "vault");
  assert.ok(!JSON.stringify(s).includes("token"));
  assert.ok(!r.items.some((i) => i.kind === "k8s.crdObject"));
  // Vault 주입 annotation 은 버려지지 않고 파드 annotation 으로 남음
  const d = r.items.find((i) => i.kind === "k8s.deployment") as any;
  assert.equal(d.spec.template.spec.podAnnotations["vault.hashicorp.com/agent-inject-secret-db"], "secret/db");
});
