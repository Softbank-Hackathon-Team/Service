// 온프레 CNPG 이전 값: 이전 전용 역할(superuser 없음)·서버 인증서·DB 터널·봉인 비밀 (차트 cnpg.yaml·db-tunnel.yaml·sealedsecret.yaml)
//   helm template 만 쓴다 (클러스터·클라우드 호출 0). 봉인 값·호스트 키는 렌더 전용 가짜 글자
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChartValues, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor } from "../src/index.js";

const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const HELM = process.env.HELM_BIN ?? "helm";
const hasHelm = (() => { try { execFileSync(HELM, ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasHelm ? false : "helm 없음";

type Raw = Record<string, any>;
const IMAGE = "alpine/git:v2.54.0@sha256:ac6c828f15d82775d204d3d75112e1d34af8945da80ccf922713c9891ba68e7a";
const KNOWN = "203.0.113.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForRenderOnly";
const pg = (replication?: Raw, extra: Raw = {}) => ({ id: "db", mode: "cnpg", name: "shop-db", instances: 1, majorVersion: "16", storageGb: 10,
  host: "shop-db-rw", port: 5432, passwordSecret: "shop-db-app", database: "shop", owner: "app", ...(replication ? { replication } : {}), ...extra });
const values = (extra: Raw = {}, postgres: unknown[] = [pg({ enabled: true })]) => ({
  app: { name: "shop" }, namespace: "app-shop", labels: { "managed-by": "platform" }, workloads: [],
  externalSecrets: { store: { kind: "ClusterSecretStore", name: "store" }, secrets: [] }, warnings: [], postgres, ...extra,
});
const tunnel = (over: Raw = {}) => ({
  relay: { host: "203.0.113.7", port: 22, knownHosts: KNOWN }, keySecret: "db-tunnel-key",
  forward: { target: "shop.abc123.ap-northeast-2.rds.amazonaws.com:5432" }, reverse: { enabled: true, cnpgName: "shop-db" }, image: IMAGE, ...over,
});
const render = (v: unknown, ...only: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-")); const f = join(dir, "values.json"); writeFileSync(f, JSON.stringify(v));
  return execFileSync(HELM, ["template", "rel", CHART, "-f", f, ...only.flatMap((o) => ["--show-only", `templates/${o}`])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};
const renderErr = (v: unknown) => { try { render(v); return ""; } catch (e: any) { return String(e.stderr ?? e.message); } };
const docs = (s: string) => s.split(/^---$/m).filter((d) => /^kind: /m.test(d));
const kindOf = (d: string) => /^kind: (\S+)/m.exec(d)?.[1];

test("이전 역할: replication 켜면 svc_migrate 하나 (pg_create_subscription + 소유 역할), superuser·pg_read_all_data·<name>-repl 없음", { skip }, () => {
  const out = render(values({}, [pg({ enabled: true, validUntil: "2026-11-30T00:00:00Z" })]), "cnpg.yaml");
  assert.doesNotMatch(out, /enableSuperuserAccess/);
  assert.doesNotMatch(out, /pg_read_all_data|shop-db-repl/);
  assert.match(out, /- name: "svc_migrate"\n\s+ensure: present\n\s+login: true\n\s+replication: true\n\s+createrole: true\n\s+inherit: true\n/);
  assert.match(out, /inRoles: \[pg_create_subscription, "app"\]/);
  assert.match(out, /passwordSecret: \{ name: "shop-db-migrate" \}/);
  assert.match(out, /validUntil: "2026-11-30T00:00:00Z"/);
  assert.match(out, /max_replication_slots: "10"/);
  assert.equal((out.match(/^\s+- name: /gm) ?? []).length, 1, "역할은 하나");
  // 이름·비밀을 값으로 바꾸면 그대로
  const own = render(values({}, [pg({ enabled: true, role: "mig", passwordSecret: "custom-pw" })]), "cnpg.yaml");
  assert.match(own, /- name: "mig"/); assert.match(own, /passwordSecret: \{ name: "custom-pw" \}/);
  // 꺼지면 역할·슬롯 설정 없음
  const off = render(values({}, [pg()]), "cnpg.yaml");
  assert.doesNotMatch(off, /managed:|max_replication_slots|enableSuperuserAccess/);
});

test("이전 역할 정리: ensure absent 면 ensure: absent 만 (비밀 참조·권한 칸 없음)", { skip }, () => {
  const out = render(values({}, [pg({ enabled: true, ensure: "absent" })]), "cnpg.yaml");
  assert.match(out, /- name: "svc_migrate"\n\s+ensure: absent\n/);
  assert.doesNotMatch(out, /ensure: present|passwordSecret: \{ name: "shop-db-migrate"|inRoles/);
});

test("이전 역할 거부: ensure 오타·RFC3339 아닌 validUntil 은 렌더 실패", { skip }, () => {
  assert.match(renderErr(values({}, [pg({ enabled: true, ensure: "gone" })])), /ensure 는 present 또는 absent/);
  assert.match(renderErr(values({}, [pg({ enabled: true, validUntil: "2026-11-30" })])), /validUntil 은 RFC3339/);
});

test("인증서: certificates 를 주면 Cluster spec.certificates 두 칸, 없으면 안 그림", { skip }, () => {
  const out = render(values({}, [pg({ enabled: true }, { certificates: { serverCASecret: "shop-db-ca", serverTLSSecret: "shop-db-tls" } })]), "cnpg.yaml");
  assert.match(out, /certificates:\n\s+serverCASecret: "shop-db-ca"\n\s+serverTLSSecret: "shop-db-tls"/);
  assert.doesNotMatch(render(values(), "cnpg.yaml"), /certificates:/);
  assert.match(renderErr(values({}, [pg({ enabled: true }, { certificates: { serverCASecret: "shop-db-ca" } })])), /certificates\.serverTLSSecret/);
});

test("DB 터널: Deployment·Service·NetworkPolicy·ConfigMap, 보안 모양 = onprem-db-tunnel 차트와 같음", { skip }, () => {
  const out = render(values({ dbTunnel: tunnel() }), "db-tunnel.yaml");
  const ds = docs(out);
  assert.deepEqual(ds.map(kindOf).sort(), ["ConfigMap", "Deployment", "NetworkPolicy", "Service"]);
  const dep = ds.find((d) => kindOf(d) === "Deployment")!;
  for (const n of ["runAsNonRoot: true", "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false", "drop: [ALL]",
    "automountServiceAccountToken: false", "StrictHostKeyChecking=yes", "ExitOnForwardFailure=yes", "RuntimeDefault",
    "-L 0.0.0.0:5432:shop.abc123.ap-northeast-2.rds.amazonaws.com:5432", "-R 0.0.0.0:5432:shop-db-rw:5432", "tunnel@203.0.113.7", "secretName: db-tunnel-key"])
    assert.ok(dep.includes(n), `Deployment 에 ${n} 없음`);
  assert.doesNotMatch(dep, /accept-new|StrictHostKeyChecking=no/);
  const svc = ds.find((d) => kindOf(d) === "Service")!;
  assert.match(svc, /name: db-tunnel\n/); assert.match(svc, /type: ClusterIP/);
  const np = ds.find((d) => kindOf(d) === "NetworkPolicy")!;
  assert.match(np, /policyTypes: \[Ingress, Egress\]/);
  const [ing, eg] = np.split("egress:");
  assert.match(ing!, /cnpg\.io\/cluster: shop-db, cnpg\.io\/podRole: instance/);
  assert.match(eg!, /cidr: 203\.0\.113\.7\/32/);
  assert.match(eg!, /cnpg\.io\/cluster: shop-db/, "역방향이면 CNPG 5432 로 나감");
  assert.match(ds.find((d) => kindOf(d) === "ConfigMap")!, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForRenderOnly/);
  // 역방향 끔: -R 없음, CNPG 로 나가는 규칙 없음. cnpgName 이 없으면 cnpg 한 줄의 이름
  const fwd = render(values({ dbTunnel: tunnel({ reverse: { enabled: false } }) }), "db-tunnel.yaml");
  assert.doesNotMatch(fwd, /-R 0\.0\.0\.0/);
  assert.equal((fwd.split("egress:")[1]!.match(/cnpg\.io\/cluster/g) ?? []).length, 0);
  assert.match(fwd.split("egress:")[0]!, /cnpg\.io\/cluster: shop-db/);
  // 이름 중계: 나가는 22 는 포트만 (NetworkPolicy 는 이름을 못 받는다)
  const named = render(values({ dbTunnel: tunnel({ relay: { host: "relay.example.net", knownHosts: KNOWN } }) }), "db-tunnel.yaml");
  assert.doesNotMatch(named, /ipBlock/); assert.match(named, /-p 22 /);
  // 값이 없으면 아무것도 안 그림
  assert.equal(docs(render(values())).filter((d) => /name: db-tunnel/.test(d)).length, 0);
});

test("DB 터널 거부: knownHosts 없음·태그만 이미지·5432 아닌 목적지·Cluster 를 못 정함은 렌더 실패", { skip }, () => {
  assert.match(renderErr(values({ dbTunnel: tunnel({ relay: { host: "203.0.113.7" } }) })), /dbTunnel\.relay\.knownHosts 가 필요하다/);
  assert.match(renderErr(values({ dbTunnel: tunnel({ image: "alpine/git:v2.54.0" }) })), /다이제스트/);
  assert.match(renderErr(values({ dbTunnel: tunnel({ forward: { target: "10.0.0.10:22" } }) })), /forward\.target/);
  assert.match(renderErr(values({ dbTunnel: tunnel({ keySecret: undefined }) })), /dbTunnel\.keySecret/);
  assert.match(renderErr(values({ dbTunnel: tunnel({ reverse: { enabled: false } }) }, [pg(), { ...pg(), name: "other-db" }])), /cnpgName 이 필요하다/);
});

test("봉인 비밀: SealedSecret (template 이름 = name, type 그대로, 범위 주석 없음 = strict) / 빈 encryptedData 는 거부", { skip }, () => {
  const out = render(values({ sealedSecrets: [
    { name: "shop-db-migrate", type: "kubernetes.io/basic-auth", encryptedData: { username: "AgBfake1", password: "AgBfake2" } },
    { name: "db-tunnel-key", encryptedData: { id: "AgBfake3" } }] }), "sealedsecret.yaml");
  const ds = docs(out);
  assert.equal(ds.length, 2);
  assert.ok(ds.every((d) => /apiVersion: bitnami\.com\/v1alpha1\nkind: SealedSecret/.test(d)));
  assert.match(ds[0]!, /encryptedData:\n\s+password: AgBfake2\n\s+username: AgBfake1\n\s+template:\n\s+metadata:\n\s+name: shop-db-migrate/);
  assert.match(ds[0]!, /type: "kubernetes\.io\/basic-auth"/);
  assert.doesNotMatch(out, /sealedsecrets\.bitnami\.com\/(cluster|namespace)-wide/);
  assert.match(renderErr(values({ sealedSecrets: [{ name: "x", encryptedData: {} }] })), /sealedSecrets\[x\]\.encryptedData 가 비었다/);
});

test("계약: ChartValues 가 이전 칸을 받고, 다이제스트 없는 터널 이미지·빈 봉인 값·ensure 오타는 거부", () => {
  const full = values({ dbTunnel: tunnel(), sealedSecrets: [{ name: "db-tunnel-key", encryptedData: { id: "AgB" } }] },
    [pg({ enabled: true, role: "svc_migrate", passwordSecret: "shop-db-migrate", validUntil: "2026-11-30T00:00:00Z", ensure: "present" },
      { certificates: { serverCASecret: "ca", serverTLSSecret: "tls" } })]);
  assert.doesNotThrow(() => ChartValues.parse(full));
  assert.throws(() => ChartValues.parse(values({ dbTunnel: tunnel({ image: "alpine/git:v2.54.0" }) })));
  assert.throws(() => ChartValues.parse(values({ sealedSecrets: [{ name: "x", encryptedData: {} }] })));
  assert.throws(() => ChartValues.parse(values({}, [pg({ enabled: true, ensure: "gone" })])));
  assert.throws(() => ChartValues.parse(values({}, [pg({ enabled: true, validUntil: "2026-11-30" })])));
});

// 어댑터: v2 온프레 값은 postgres 가 있으면 CNPG 마다 이전 역할을 켠다. 터널·봉인 비밀·인증서는 안 낸다 (워커 몫)
const D = "sha256:" + "ab".repeat(32);
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items } as unknown as RawInventory);
const dep = (name: string): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], resources: { requests: { cpu: "300m", memory: "768Mi" } },
    env: [{ name: "DB_HOST", value: "shop-db-rw.shop.svc" }] }] } } },
});
const cnpgItem: Raw = { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: "shop" },
  spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "5Gi" }, instances: 1 } };
const TT = { envId: "33333333-3333-4333-8333-333333333333", provider: "onprem", region: "default", migrationId: "44444444-4444-4444-8444-444444444444" } as TargetEnv;
const onpremValues = (items: Raw[]) => targetBuilderFor("onprem").toWorkloadValues(normalizeV2(inv(items)).result.spec, {}, TT) as Raw;

test("어댑터: postgres 가 있으면 CNPG 마다 replication {enabled, svc_migrate, <cnpg>-migrate}, 터널·봉인 비밀·인증서는 안 냄", () => {
  const v = onpremValues([cnpgItem, dep("api")]);
  assert.ok(v.postgres.length >= 1);
  for (const p of v.postgres) assert.deepEqual(p.replication, { enabled: true, role: "svc_migrate", passwordSecret: `${p.name}-migrate` });
  assert.equal(v.dbTunnel, undefined); assert.equal(v.sealedSecrets, undefined);
  assert.ok(v.postgres.every((p: Raw) => p.certificates === undefined));
  assert.doesNotThrow(() => ChartValues.parse(v));
});

test("어댑터 거부: postgres 가 없는 명세는 replication 칸 자체가 없다", () => {
  const v = onpremValues([dep("api")]);
  assert.equal((v.postgres ?? []).length, 0);
  assert.doesNotMatch(JSON.stringify(v), /svc_migrate|"replication"/);
});
