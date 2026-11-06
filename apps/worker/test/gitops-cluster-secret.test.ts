// 허브가 고객 도착 클러스터에 들어가는 Argo cluster Secret (gitops/bundle.ts clusterAccess·clusterSecret). 레포·git 없이 순수 함수만
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AWS_DEPLOY_ROLE_NAME, awsHubEnabled, clusterAccess, clusterName, clusterSecret, clusterSecretFile } from "../src/gitops/bundle.js";

const TENANT = "t-9f8e7d6c";
const EKS_OUT = {
  cluster_endpoint: "https://ABCDEF0123.gr7.ap-northeast-2.eks.amazonaws.com",
  cluster_ca_certificate: "LS0tLS1CRUdJTg==",
  cluster_name: "customer-eks",
};

test("EKS: 허브를 켠 플랫폼은 svc-deploy 를 빌리는 awsAuthConfig Secret 을 그린다 (앱 구역만, 중복 없이 정렬)", () => {
  const a = clusterAccess("aws-eks", EKS_OUT, { accountId: "111122223333", awsHub: true });
  assert.ok(a);
  const s = clusterSecret(TENANT, a, ["app-shop", "app-blog", "app-shop"]);
  assert.equal(s.metadata.name, "t-9f8e7d6c-aws-eks");
  assert.equal(s.metadata.namespace, "argocd");
  assert.equal(s.metadata.labels["argocd.argoproj.io/secret-type"], "cluster");
  assert.equal(s.stringData.server, "https://ABCDEF0123.gr7.ap-northeast-2.eks.amazonaws.com", "EKS 주소는 https:// 를 두 번 붙이지 않는다");
  assert.equal(s.stringData.namespaces, "app-blog,app-shop");
  assert.deepEqual(JSON.parse(s.stringData.config), {
    awsAuthConfig: { clusterName: "customer-eks", roleARN: "arn:aws:iam::111122223333:role/svc-deploy" },
    tlsClientConfig: { insecure: false, caData: "LS0tLS1CRUdJTg==" },
  });
  assert.equal(clusterSecretFile(a.env), "cluster-aws-eks.yaml");
});

test("EKS: Secret 이름 = plan.json 목적지 클러스터 이름 (ApplicationSet destination.name)", () => {
  const a = clusterAccess("aws-eks", EKS_OUT, { accountId: "111122223333", awsHub: true })!;
  assert.equal(clusterSecret(TENANT, a, ["app-shop"]).stringData.name, clusterName({ tenant: TENANT, app: "shop", env: "aws-eks" }));
});

test("EKS: 허브를 안 켰거나 재료가 모자라면 Secret 을 만들지 않는다 (사람이 등록한 목적지를 덮지 않음)", () => {
  assert.equal(clusterAccess("aws-eks", EKS_OUT, { accountId: "111122223333", awsHub: false }), undefined);
  assert.equal(clusterAccess("aws-eks", EKS_OUT, { accountId: null, awsHub: true }), undefined);
  assert.equal(clusterAccess("aws-eks", { ...EKS_OUT, cluster_name: "" }, { accountId: "111122223333", awsHub: true }), undefined);
  assert.equal(clusterAccess("aws-eks", { ...EKS_OUT, cluster_ca_certificate: "" }, { accountId: "111122223333", awsHub: true }), undefined);
  assert.equal(clusterAccess("onprem-k3s", EKS_OUT, { accountId: "111122223333", awsHub: true }), undefined);
});

test("GKE: 예전 Secret 모양 그대로 (IP 에 https://, argocd-k8s-auth gcp, 회사별 설정 파일)", () => {
  const a = clusterAccess("gcp-gke", { cluster_endpoint: "34.0.0.1", cluster_ca_certificate: "Y2E=" }, { accountId: "demo-project", awsHub: false });
  assert.ok(a);
  const s = clusterSecret(TENANT, a, ["app-shop"]);
  assert.equal(s.metadata.name, "t-9f8e7d6c-gcp-gke");
  assert.equal(s.stringData.server, "https://34.0.0.1");
  const cfg = JSON.parse(s.stringData.config);
  assert.deepEqual(cfg.execProviderConfig.args, ["gcp"]);
  assert.equal(cfg.execProviderConfig.env.GOOGLE_APPLICATION_CREDENTIALS, "/var/run/gcp-cred/t-9f8e7d6c.json");
  assert.equal(cfg.awsAuthConfig, undefined);
  assert.equal(clusterSecretFile(a.env), "cluster-gcp-gke.yaml");
});

test("배포 역할 이름 = 연결 템플릿 DeployRole 이름 (다르면 허브가 없는 역할을 빌린다)", () => {
  const t = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
  assert.equal(t.Resources.DeployRole.Properties.RoleName, AWS_DEPLOY_ROLE_NAME);
});

test("허브 스위치: ARGO_HUB_ROLE_ARN 이 있을 때만 켜짐", () => {
  assert.equal(awsHubEnabled({ ARGO_HUB_ROLE_ARN: "arn:aws:iam::111122223333:role/platform-argocd-hub" }), true);
  assert.equal(awsHubEnabled({ ARGO_HUB_ROLE_ARN: " " }), false);
  assert.equal(awsHubEnabled({}), false);
});
