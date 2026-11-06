// Z91: 실제 보안 점검. 진짜 aws·gcloud·kubectl 대신 같은 JSON 을 돌려주는 가짜 실행기로 판정 규칙을 시험한다
// (모양은 각 CLI 의 --output json / --format=json / -o json 응답 그대로의 일부)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertReadOnly, ReadOnlyViolation, runLiveChecks, ALL_KEYS, openIngress,
  type ExecRunner, type LiveTarget, type LiveSecurityReport,
} from "../src/live/index.js";

type Table = Record<string, unknown | ((args: string[]) => unknown)>;
// 명령 앞 낱말 3개로 응답을 고른다. 없으면 실패(종료 코드 254), "MISSING" 이면 CLI 없음
function fake(t: Table, calls: string[] = []): ExecRunner {
  return async (cmd, args) => {
    assertReadOnly(cmd, args);
    const pos = args.filter((a) => !a.startsWith("-"));
    const full = cmd === "kubectl" ? `kubectl get ${args[args.indexOf("get") + 1]}` : `${cmd} ${pos.join(" ")}`;
    const k = Object.keys(t).filter((x) => full === x || full.startsWith(`${x} `)).sort((a, b) => b.length - a.length)[0] ?? full;
    calls.push(k);
    if (t.MISSING) return { code: 127, stdout: "", stderr: "", missing: true };
    const v = t[k];
    if (v === undefined) return { code: 254, stdout: "", stderr: `An error occurred (AccessDenied) for 123456789012: ${k}` };
    return { code: 0, stdout: JSON.stringify(typeof v === "function" ? (v as (a: string[]) => unknown)(args) : v), stderr: "" };
  };
}
const by = (r: LiveSecurityReport, key: string) => { const c = r.checks.find((x) => x.key === key); assert.ok(c, key); return c; };
const NOW = () => new Date(Date.UTC(2026, 10, 7, 3, 0, 0));
const ENV = { SEC_KUBE_CONTEXT_AWS: "eks-ctx", SEC_KUBE_CONTEXT_GCP: "gke-ctx", SEC_KUBE_CONTEXT_ONPREM: "k3d-src", SEC_KUBE_NAMESPACE_ONPREM: "app-shop" };

const awsTarget = (tf: Record<string, string> = {}): LiveTarget => ({ side: "target", provider: "aws", envId: "e-aws", accountId: "123456789012",
  stubOutputs: false, tfOutputs: { db_address: "shop.abc.ap-northeast-2.rds.amazonaws.com", cluster_name: "finals-eks",
    app_role_arn: "arn:aws:iam::123456789012:role/app-shop", db_master_secret_arn: "arn:aws:secretsmanager:x", namespace: "app-shop", ...tf } });

const goodTrust = encodeURIComponent(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: "pods.eks.amazonaws.com" }, Action: ["sts:AssumeRole", "sts:TagSession"] }] }));
const k8sOk: Table = {
  "kubectl get services": { items: [{ metadata: { name: "shop" }, spec: { type: "ClusterIP" } }] },
  "kubectl get ingresses": { items: [] },
  "kubectl get pods": { items: [{ metadata: { name: "shop-1" }, spec: { containers: [
    { name: "app", image: "shop:1", env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db", key: "p" } } }, { name: "PORT", value: "8080" }] },
    { name: "tunnel", image: "cloudflare/cloudflared:2025.1.0" }] } }] },
  "kubectl get configmaps": { items: [{ metadata: { name: "cfg" }, data: { LOG: "info" } }] },
  "kubectl get rolebindings": { items: [{ metadata: { name: "app-read" }, roleRef: { name: "view" } }] },
  "kubectl get clusterrolebindings": { items: [] },
};
const awsGood = (over: Table = {}): Table => ({
  "aws sts get-caller-identity": { Account: "123456789012" },
  "aws rds describe-db-instances": { DBInstances: [{ DBInstanceIdentifier: "shop", Endpoint: { Address: "shop.abc.ap-northeast-2.rds.amazonaws.com" },
    PubliclyAccessible: false, StorageEncrypted: true, KmsKeyId: "arn:kms", VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-1" }],
    DBParameterGroups: [{ DBParameterGroupName: "pg16-shop" }], CACertificateIdentifier: "rds-ca-rsa2048-g1",
    MasterUserSecret: { SecretArn: "arn:aws:secretsmanager:x", SecretStatus: "active" } }] },
  "aws ec2 describe-security-groups": { SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [], UserIdGroupPairs: [{ GroupId: "sg-eks" }] }] }] },
  "aws rds describe-db-parameters": [{ ParameterName: "rds.force_ssl", ParameterValue: "1" }],
  "aws eks describe-cluster": { cluster: { name: "finals-eks", resourcesVpcConfig: { endpointPublicAccess: false, endpointPrivateAccess: true }, encryptionConfig: [{ resources: ["secrets"] }] } },
  "aws iam get-role": { Role: { RoleName: "app-shop", AssumeRolePolicyDocument: goodTrust } },
  "aws iam list-attached-role-policies": { AttachedPolicies: [] },
  "aws iam list-role-policies": { PolicyNames: ["db-secret"] },
  "aws iam get-role-policy": { PolicyDocument: { Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: "arn:aws:secretsmanager:x" }] } },
  ...k8sOk, ...over,
});

test("읽기 전용 가드: describe/get/list 만 통과, 쓰기 명령은 실행 전에 막는다", () => {
  assertReadOnly("aws", ["rds", "describe-db-instances", "--region", "ap-northeast-2"]);
  assertReadOnly("gcloud", ["sql", "instances", "describe", "db", "--project", "p", "--format=json"]);
  assertReadOnly("gcloud", ["projects", "get-iam-policy", "p", "--format=json"]);
  assertReadOnly("kubectl", ["--context", "c", "get", "pods", "-n", "x", "-o", "json"]);
  for (const [c, a] of [["aws", ["rds", "delete-db-instance"]], ["aws", ["ec2", "authorize-security-group-ingress"]], ["aws", ["s3", "rm"]],
    ["gcloud", ["sql", "instances", "delete", "db"]], ["gcloud", ["projects", "add-iam-policy-binding", "p"]],
    ["kubectl", ["delete", "pod", "x"]], ["kubectl", ["--context", "c", "apply", "-f", "x"]], ["terraform", ["apply"]], ["sh", ["-c", "rm"]],
    // Z38b 가 찾은 빈틈 (읽기 낱말이지만 비밀값을 꺼내거나 쓰기로 바뀌는 것)
    ["aws", ["secretsmanager", "get-secret-value", "--secret-id", "x"]], ["aws", ["ssm", "get-parameter", "--name", "x", "--with-decryption"]],
    ["aws", ["ecr", "get-login-password"]], ["aws", ["sts", "get-session-token"]], ["aws", ["rds", "describe-db-instances", "--profile", "other"]],
    ["aws", ["rds", "describe-db-instances", "--endpoint-url", "http://evil"]],
    ["kubectl", ["--context", "c", "get", "secrets", "-n", "x", "-o", "json"]], ["kubectl", ["--token", "t", "get", "delete", "pod", "x"]],
    ["kubectl", ["--context", "c", "get", "pods", "-n", "x", "-o", "json", "--raw", "/api"]], ["kubectl", ["--context", "c", "get", "pods", "--server", "https://x"]],
    ["gcloud", ["secrets", "versions", "access", "latest", "--secret", "x"]], ["gcloud", ["sql", "instances", "describe", "db", "--impersonate-service-account", "x"]],
    ["gcloud", ["auth", "print-access-token"]]] as const)
    assert.throws(() => assertReadOnly(c, [...a]), ReadOnlyViolation, `${c} ${a.join(" ")}`);
});

test("AWS 도착 정상: 12줄 전부 나오고 pass, 계정 번호 없음", async () => {
  const r = await runLiveChecks(awsTarget(), { run: fake(awsGood()), env: ENV, now: NOW });
  assert.equal(r.credentials, "ok");
  assert.deepEqual(r.checks.map((c) => c.key), ALL_KEYS);
  for (const c of r.checks) assert.equal(c.state, "pass", `${c.key}: ${c.evidence}`);
  assert.equal(r.summary.pass, 12);
  assert.doesNotMatch(JSON.stringify(r), /123456789012/);
  assert.equal(r.origin, "live");
});

test("AWS 위반: 공개 DB 0.0.0.0/0, 22번 세상 공개, 암호화 꺼짐, force_ssl 0, EKS 공개, 관리자 정책, 평문 비밀값, cluster-admin", async () => {
  const t = awsGood({
    "aws rds describe-db-instances": { DBInstances: [{ DBInstanceIdentifier: "shop", Endpoint: { Address: "shop.abc.ap-northeast-2.rds.amazonaws.com" },
      PubliclyAccessible: true, StorageEncrypted: false, VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-1" }], DBParameterGroups: [{ DBParameterGroupName: "g" }] }] },
    "aws ec2 describe-security-groups": { SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [
      { IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
      { IpProtocol: "tcp", FromPort: 22, ToPort: 22, Ipv6Ranges: [{ CidrIpv6: "::/0" }] }] }] },
    "aws rds describe-db-parameters": [{ ParameterName: "rds.force_ssl", ParameterValue: "0" }],
    "aws eks describe-cluster": { cluster: { name: "finals-eks", resourcesVpcConfig: { endpointPublicAccess: true, publicAccessCidrs: ["0.0.0.0/0"] } } },
    "aws iam list-attached-role-policies": { AttachedPolicies: [{ PolicyName: "AdministratorAccess", PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }] },
    "kubectl get pods": { items: [{ metadata: { name: "shop-1" }, spec: { containers: [{ name: "app", env: [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "X", value: "AKIAABCDEFGHIJKLMNOP" }] }] } }] },
    "kubectl get rolebindings": { items: [{ metadata: { name: "oops" }, roleRef: { name: "cluster-admin" } }] },
  });
  const r = await runLiveChecks(awsTarget(), { run: fake(t), env: ENV, now: NOW });
  for (const k of ["public_ports.db", "public_ports.network", "storage_encryption.db", "tls.db", "public_ports.cluster_api", "iam.app_identity", "secrets.workload", "iam.k8s_rbac"])
    assert.equal(by(r, k).state, "fail", `${k}: ${by(r, k).evidence}`);
  assert.equal(by(r, "storage_encryption.k8s_secrets").state, "warn");
  assert.equal(by(r, "secrets.db_credential").state, "warn");
  assert.match(by(r, "public_ports.network").evidence, /tcp\/22/);
  // 값은 응답에 없다 (env 이름만)
  assert.doesNotMatch(JSON.stringify(r), /hunter2|AKIAABCDEFGHIJKLMNOP/);
  assert.match(by(r, "secrets.workload").evidence, /DB_PASSWORD/);
});

test("데모 DB_PUBLIC: 공개 + 허용 목록 /32 만이면 warn (fail 아님)", async () => {
  const t = awsGood({
    "aws ec2 describe-security-groups": { SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: "203.0.113.7/32" }] }] }] },
  });
  const db = (t["aws rds describe-db-instances"] as { DBInstances: Record<string, unknown>[] }).DBInstances[0]!;
  db.PubliclyAccessible = true;
  const r = await runLiveChecks(awsTarget(), { run: fake(t), env: ENV, now: NOW });
  assert.equal(by(r, "public_ports.db").state, "warn");
  assert.equal(by(r, "public_ports.network").state, "pass");
  assert.equal(openIngress((t["aws ec2 describe-security-groups"] as { SecurityGroups: unknown[] }).SecurityGroups)[0]!.world, false);
});

test("자격 없음·CLI 없음·STUB 출력·자원 기록 없음 → 전부 unavailable + 이유, 클라우드를 더 부르지 않는다", async () => {
  const calls: string[] = [];
  const noCred = await runLiveChecks(awsTarget(), { run: fake({}, calls), env: ENV, now: NOW });
  assert.equal(noCred.credentials, "unavailable");
  assert.match(noCred.reason ?? "", /AWS 자격 없음/);
  assert.doesNotMatch(noCred.reason ?? "", /123456789012/);
  const awsCalls = calls.filter((c) => c.startsWith("aws"));
  assert.equal(awsCalls.length, 1);
  assert.ok(awsCalls[0]!.startsWith("aws sts get-caller-identity"));
  assert.ok(noCred.checks.filter((c) => c.key.startsWith("public_ports.db")).every((c) => c.state === "unavailable"));

  const missing = await runLiveChecks(awsTarget(), { run: fake({ MISSING: true }), env: ENV, now: NOW });
  assert.equal(missing.reason, "aws CLI 없음");

  const c2: string[] = [];
  const stub = await runLiveChecks({ ...awsTarget(), stubOutputs: true }, { run: fake(awsGood(), c2), env: ENV, now: NOW });
  assert.equal(c2.length, 0);
  assert.equal(stub.summary.unavailable, 12);
  assert.match(stub.reason ?? "", /STUB/);

  const none = await runLiveChecks({ ...awsTarget(), tfOutputs: null }, { run: fake(awsGood(), c2), env: ENV, now: NOW });
  assert.match(none.reason ?? "", /infra.ready/);
  assert.equal(c2.length, 0);
});

test("AWS 클러스터 없이 만든 이전(Z77): EKS·k8s 줄은 n_a, RDS 줄은 실제 판정", async () => {
  const r = await runLiveChecks(awsTarget({ cluster_name: "", app_role_arn: "" }), { run: fake(awsGood()), env: ENV, now: NOW });
  assert.equal(by(r, "public_ports.cluster_api").state, "n_a");
  assert.equal(by(r, "iam.k8s_rbac").state, "n_a");
  assert.equal(by(r, "iam.app_identity").state, "n_a");
  assert.equal(by(r, "storage_encryption.db").state, "pass");
});

const gcpTarget: LiveTarget = { side: "target", provider: "gcp", envId: "e-gcp", accountId: "finals-demo", stubOutputs: false,
  tfOutputs: { db_connection_name: "finals-demo:asia-northeast3:shop-db", cluster_name: "finals-gke", app_gsa_email: "app-shop@finals-demo.iam.gserviceaccount.com",
    db_password_secret_id: "shop-db-password", namespace: "app-shop" } };
const gcpGood = (over: Table = {}): Table => ({
  "gcloud projects get-iam-policy": { bindings: [{ role: "roles/cloudsql.client", members: ["serviceAccount:app-shop@finals-demo.iam.gserviceaccount.com"] }] },
  "gcloud sql instances": { name: "shop-db", settings: { ipConfiguration: { ipv4Enabled: false, sslMode: "ENCRYPTED_ONLY" } } },
  "gcloud container clusters": { name: "finals-gke", network: "finals-vpc", privateClusterConfig: { enablePrivateEndpoint: true }, databaseEncryption: { state: "ENCRYPTED" } },
  "gcloud compute firewall-rules": [{ name: "allow-internal", direction: "INGRESS", network: "https://x/networks/finals-vpc", sourceRanges: ["10.0.0.0/8"], allowed: [{ IPProtocol: "tcp" }] }],
  ...k8sOk, ...over,
});

test("GCP 도착: 정상이면 pass, 승인 네트워크 0.0.0.0/0·평문 허용·SSH 세상 공개·editor 는 fail", async () => {
  const ok = await runLiveChecks(gcpTarget, { run: fake(gcpGood()), env: ENV, now: NOW });
  for (const c of ok.checks) assert.equal(c.state, "pass", `${c.key}: ${c.evidence}`);
  const bad = await runLiveChecks(gcpTarget, { run: fake(gcpGood({
    "gcloud sql instances": { name: "shop-db", settings: { ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [{ value: "0.0.0.0/0" }], sslMode: "ALLOW_UNENCRYPTED_AND_ENCRYPTED" } } },
    "gcloud compute firewall-rules": [{ name: "ssh-all", direction: "INGRESS", network: "https://x/networks/finals-vpc", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["22"] }] },
      { name: "other-vpc", direction: "INGRESS", network: "https://x/networks/default", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["3389"] }] }],
    "gcloud container clusters": { name: "finals-gke", network: "finals-vpc" },
    "gcloud projects get-iam-policy": { bindings: [{ role: "roles/editor", members: ["serviceAccount:app-shop@finals-demo.iam.gserviceaccount.com"] }] },
  })), env: ENV, now: NOW });
  for (const k of ["public_ports.db", "tls.db", "public_ports.network", "public_ports.cluster_api", "iam.app_identity"]) assert.equal(by(bad, k).state, "fail", k);
  assert.match(by(bad, "public_ports.network").evidence, /ssh-all/);
  assert.doesNotMatch(by(bad, "public_ports.network").evidence, /other-vpc/);   // 다른 VPC 규칙은 이 클러스터와 무관
  assert.equal(by(bad, "storage_encryption.k8s_secrets").state, "warn");
});

// #317 가: 앱 신원 = KSA 주체 (gcp/root 출력 app_principal). 예전 출력(app_gsa_email)은 위 시험이 그대로 본다
test("GCP 도착 KSA 주체: 프로젝트 정책에서 principal:// 주체의 역할을 본다 (넓은 역할이면 fail), 출력 없으면 n_a", async () => {
  const P = "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/finals-demo.svc.id.goog/subject/ns/app-shop/sa/api";
  const { app_gsa_email: _old, ...rest } = gcpTarget.tfOutputs!;
  const t: LiveTarget = { ...gcpTarget, tfOutputs: { ...rest, app_principal: P } };
  const ok = await runLiveChecks(t, { run: fake(gcpGood({ "gcloud projects get-iam-policy": { bindings: [{ role: "roles/cloudsql.client", members: [P] }] } })), env: ENV, now: NOW });
  assert.equal(by(ok, "iam.app_identity").state, "pass");
  assert.equal(by(ok, "iam.app_identity").resource, "KSA app-shop/api");
  assert.match(by(ok, "iam.app_identity").evidence, /roles\/cloudsql\.client/);
  const bad = await runLiveChecks(t, { run: fake(gcpGood({ "gcloud projects get-iam-policy": { bindings: [{ role: "roles/editor", members: [P] }] } })), env: ENV, now: NOW });
  assert.equal(by(bad, "iam.app_identity").state, "fail");
  const none = await runLiveChecks({ ...gcpTarget, tfOutputs: rest }, { run: fake(gcpGood()), env: ENV, now: NOW });
  assert.equal(by(none, "iam.app_identity").state, "n_a");
  assert.match(by(none, "iam.app_identity").evidence, /app_principal/);
});

test("온프레 출발: CNPG·k8s 로만 보고, 클라우드 전용 줄은 n_a·unavailable(이유)", async () => {
  const t: LiveTarget = { side: "source", provider: "onprem", envId: "e-on", accountId: null, tfOutputs: null, stubOutputs: false };
  const r = await runLiveChecks(t, { run: fake({ ...k8sOk,
    "kubectl get clusters.postgresql.cnpg.io": { items: [{ metadata: { name: "shop-db" }, spec: { postgresql: { pg_hba: ["hostssl all all 0.0.0.0/0 scram-sha-256"] } } }] },
    "kubectl get services": { items: [{ metadata: { name: "db-rw" }, spec: { type: "NodePort" } }] } }), env: ENV, now: NOW });
  assert.equal(r.credentials, "n_a");
  assert.equal(by(r, "tls.db").state, "pass");
  assert.equal(by(r, "public_ports.services").state, "warn");   // k3d NodePort 30432 (데모 복제 경로)
  assert.equal(by(r, "storage_encryption.db").state, "unavailable");
  assert.equal(by(r, "iam.app_identity").state, "n_a");
  assert.equal(by(r, "tls.ingress").state, "pass");             // cloudflared Pod
  const noCtx = await runLiveChecks(t, { run: fake({}), env: {}, now: NOW });
  assert.ok(noCtx.checks.every((c) => c.state === "unavailable" || c.state === "n_a"));
  assert.match(noCtx.reason ?? "", /SEC_KUBE_CONTEXT_ONPREM/);
});

test("Azure Mock: 실제 자원이 없다고 정직하게 unavailable", async () => {
  const r = await runLiveChecks({ side: "target", provider: "azure_mock", envId: "e-az", accountId: null, tfOutputs: {}, stubOutputs: true }, { run: fake({}), env: ENV, now: NOW });
  assert.equal(r.summary.unavailable, 12);
  assert.match(r.reason ?? "", /모의/);
});

test("k8s 컨텍스트가 틀리면(연결 실패) k8s 4줄 unavailable, 클라우드 줄은 그대로", async () => {
  const t = awsGood();
  for (const k of Object.keys(t)) if (k.startsWith("kubectl")) delete t[k];
  const r = await runLiveChecks(awsTarget(), { run: fake(t), env: ENV, now: NOW });
  for (const k of ["public_ports.services", "tls.ingress", "secrets.workload", "iam.k8s_rbac"]) assert.equal(by(r, k).state, "unavailable", k);
  assert.equal(by(r, "tls.db").state, "pass");
});
