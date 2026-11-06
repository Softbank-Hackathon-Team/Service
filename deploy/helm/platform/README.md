# deploy/helm/platform: 플랫폼 비밀 연동 + 바깥 입구 + 샌드박스 호스트 가드

상태: AI 초안

플랫폼 EKS(`infra/modules/aws/platform`)에 아래를 올린다.

| 무엇 | 하는 일 |
|---|---|
| External Secrets (SecretStore + ExternalSecret) | Secrets Manager `platform/app` → 컴포넌트별 Secret `<이름>-env` (적은 키만), `platform/cloudflared` → `cloudflared-token` |
| cloudflared ×2 (general 노드) | 바깥에서 들어오는 유일한 길. 터널이 밖으로 연결을 열어서 공개 포트·로드밸런서가 없다 |
| OTel 게이트웨이 (이미지 값을 줄 때만, general 노드) | 고객 수집기의 지표를 지표 토큰으로 확인하고, 회사·환경 라벨을 덮어써서 Prometheus 로 넘긴다 |
| 서비스 계정 `worker`·`api`·`agent-worker` + 워커 Argo CD 권한 | AWS 권한은 Pod Identity(Terraform)가 이름으로 묶는다. 워커는 `argocd` 의 `applications` get·list·patch. agent-worker 는 클라우드 권한이 없다 |
| 앱 api·worker·agent-worker·web (`apps.image.registry`·`apps.image.tag` 를 줄 때만) | 이미지 `<registry>/svc-<이름>:<tag>`. Service 는 `api`(3000)·`web`(8080) 둘. worker 는 `cred` 노드 ×2, 나머지는 `general`. 아래 "앱 배포" 절 |
| 샌드박스 호스트 쪽 (`sandbox.enabled`, 기본 끔) | agent-worker 가 `sbx-*` 네임스페이스에 vCluster 를 하나씩 만들고 지우는 권한, 호스트 가드 VAP 6개(테넌트별 ECR 이미지 경로 포함), StorageClass `sbx-standard`, gVisor RuntimeClass(`sandbox.gvisor.enabled` 일 때만). `sandbox.imageRegistry` 가 꼭 있어야 한다. 아래 "샌드박스" 절 |

비밀값은 차트에 없다. 사람이 Secrets Manager 에 넣는다. 앱 Deployment 는 `envFrom: secretRef: <이름>-env` 로 여기서 만든 Secret 을 쓴다 (web 은 비밀이 없어 envFrom 이 없다).

## 이름이 맞물리는 곳 (바꾸면 같이 바꾼다)

| 차트 | Terraform (`aws/platform`) |
|---|---|
| ESO 컨트롤러 `external-secrets/external-secrets` | `aws_eks_pod_identity_association.eso` |
| `secrets.app` = `platform/app`, `secrets.cloudflared` = `platform/cloudflared` | `aws_secretsmanager_secret.platform` |
| cloudflared `nodeSelector pool: general` | `aws_eks_node_group.this` 라벨 `pool` |
| 서비스 계정 `platform/worker`, `platform/api` | `aws_eks_pod_identity_association.worker`·`.api` (`pod-identity.tf`) |
| 서비스 계정 `platform/worker` (GCP 교환 주체) | `infra/modules/gcp/platform-wif` 의 `worker_subject` |
| `sandbox.pool` = `sandbox` (파드 nodeSelector `pool`, taint `dedicated=sandbox:NoSchedule`) | `aws_eks_node_group.this["sandbox"]` 라벨 `pool`, taint `dedicated` |
| `sandbox.imageRegistry` = `<계정>.dkr.ecr.<리전>.amazonaws.com/sandbox` | 플랫폼 ECR 샌드박스 자리. worker 환경변수 `SANDBOX_IMAGE_REGISTRY` 와 같은 값 |

## 순서 (apply 뒤, 사람이 한 번)

```
# 1. ESO 컨트롤러 (공식 차트. 릴리스 이름 external-secrets → 서비스 계정 이름이 external-secrets)
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace

# 2. 비밀값 넣기 (값은 채팅·레포에 남기지 않는다)
aws secretsmanager put-secret-value --secret-id platform/app --secret-string file://<레포 밖 app.json>
#    app.json 키: DATABASE_URL, JWT_SECRET, PLATFORM_PRINCIPAL_ARN, AGENT_REPORT_MASTER_KEY, PUBLIC_API_URL, CONNECT_TEMPLATE_URL, GITOPS_REPO_URL, GITOPS_WRITE_TOKEN, GITOPS_PUSH, REPL_SECRET_MASTER_KEY, PLATFORM_EGRESS_CIDRS, ANTHROPIC_API_KEY
#    values.yaml secretKeys 에 적힌 키가 JSON 에 하나라도 없으면 그 컴포넌트의 비밀 동기화가 멈춘다 → 키를 더할 때는 값부터 넣고 helm upgrade
aws secretsmanager put-secret-value --secret-id platform/cloudflared --secret-string file://<레포 밖 cf.json>

# 3. 이 차트 (샌드박스 끔이 기본). 워커 Argo CD 권한이 argocd 네임스페이스에 생기므로 아래 "Argo CD 허브" 1번을 먼저 한다
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace

# 3-1. 리허설 샌드박스를 켤 때. imageRegistry 는 Terraform 출력 sandbox_image_registry 그대로 (없거나 모양이 틀리면 렌더가 멈춘다)
#      sandbox.enabled 는 호스트 권한·가드만 만든다. 리허설 자체는 sandbox.rehearsal.enabled (아래 "샌드박스 > 앱에 넣는 값")
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace \
  --set sandbox.enabled=true \
  --set sandbox.imageRegistry=<계정>.dkr.ecr.<리전>.amazonaws.com/sandbox \
  --set sandbox.rehearsal.enabled=true

# 3-2. 앱 4개를 올릴 때 (registry·tag 둘 다 있어야 만든다). 이미 설치한 뒤에는 --reset-then-reuse-values 를 꼭 붙인다 (--reuse-values 는 새 차트 기본값을 버린다)
#      빠지면 그동안 준 값이 사라져 워커가 GCP 로그인을 잃는다
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace --reset-then-reuse-values --set apps.image.registry=725072160743.dkr.ecr.ap-northeast-2.amazonaws.com --set apps.image.tag=<태그>
```

`platform/app` JSON 에 넣을 키: `components.*.secretKeys` 에 적은 것 전부 (`DATABASE_URL`, `JWT_SECRET`, `PLATFORM_PRINCIPAL_ARN`, `CONNECT_TEMPLATE_URL`, `ANTHROPIC_API_KEY` 등). 키를 늘리면 JSON 과 `secretKeys` 를 같이 고친다.

Cloudflare 쪽: Zero Trust 에서 원격 관리 터널을 만들고 토큰을 `platform/cloudflared` 에 넣는다. 공개 호스트 이름의 서비스는 `http://web.platform.svc.cluster.local:8080` (web 배포가 올라온 뒤), 지표 주소(예: metrics.<도메인>)는 `http://otel-gateway.platform.svc.cluster.local:4318`.

## Argo CD 허브 (이 차트와 따로 설치)

공식 차트 argo-cd 를 `argocd` 네임스페이스의 `cred` 노드에 올린다. 값은 `deploy/argocd/argo-cd.values.yaml`. 공개 주소 없이 port-forward 로만 본다.

워커는 배포 동기화를 이 클러스터의 Application 으로 읽는다. 차트가 worker 에만 `ARGO_SOURCE=k8s`·`ARGOCD_NAMESPACE`(values `argocd.namespace`, 기본 `argocd`)를 넣고, kubectl 은 context 없이 파드 서비스 계정 토큰으로 부른다. 권한은 `templates/worker-argocd-rbac.yaml` 의 Role 하나(같은 네임스페이스). Argo CD 를 다른 네임스페이스에 올렸으면 `argocd.namespace` 를 같이 바꾼다.

```
# 1. Argo CD
helm upgrade --install argocd oci://ghcr.io/argoproj/argo-helm/argo-cd --version 10.11.7 -n argocd --create-namespace -f deploy/argocd/argo-cd.values.yaml

# 2. gitops 레포 읽기 (비공개 레포). 토큰은 GITOPS_READ_TOKEN 값. 입력은 화면에 안 보인다 (값은 채팅·레포에 남기지 않는다)
read -rs TOKEN; kubectl create secret generic gitops-repo -n argocd --from-literal=type=git --from-literal=url=https://github.com/Softbank-Hackathon-Team/gitops.git --from-literal=username=x-access-token --from-literal=password="$TOKEN"; unset TOKEN
kubectl label secret gitops-repo -n argocd argocd.argoproj.io/secret-type=repository

# 3. 루트 앱 (gitops 레포에서). 루트 앱이 쓰는 울타리가 platform/ 안에 있어 먼저 넣는다
kubectl apply -f platform/project-platform-root.yaml
kubectl apply -f bootstrap/root-app.yaml

# 4. 확인: platform-root 가 Synced, ApplicationSet 4개, AppProject 가 보이면 된다
kubectl get applications,applicationsets,appprojects -n argocd

# 5. 보기. 아이디 admin, 비밀번호는 아래 값 → https://localhost:8443
kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d
kubectl port-forward svc/argocd-server -n argocd 8443:443
```

허브의 고객 GKE 로그인. 저장되는 키 없이, 플랫폼 EKS 토큰을 구글 토큰으로 바꿔 회사 전용 플랫폼 SA(`t-<28자>@`)로 들어간다. cluster Secret 은 워커가 배포 때 gitops 레포에 같이 올린다.

```
# 1. 플랫폼 GCP 프로젝트에 교환 창구: infra/modules/gcp/platform-wif 적용.
#    eks_oidc_issuer = aws/platform 출력 cluster_oidc_issuer. 출력 audience, provider_name, hub_principals 를 아래에 쓴다

# 2. 허브에 구글용 토큰 파일 더하기 (이미 깔린 허브도 같은 명령)
sed "s#<WIF_AUDIENCE>#$AUDIENCE#" deploy/argocd/argo-cd.gke-login.values.yaml > "$TMPDIR/gke-login.yaml"
helm upgrade --install argocd oci://ghcr.io/argoproj/argo-helm/argo-cd --version 10.11.7 -n argocd --create-namespace -f deploy/argocd/argo-cd.values.yaml -f "$TMPDIR/gke-login.yaml"

# 3. 회사마다: 허브에 그 회사 SA 가장 권한을 주고(HUB_PRINCIPALS = hub_principals 를 공백으로 이은 값, 나머지 값은 스크립트 머리말), 설정 파일을 하나 만든다
#    설정 파일은 어느 SA 로 들어갈지 적은 파일이고 키가 아니다. SA = tenants.gcp_platform_sa, 파일 이름 = t-<회사 uuid 앞 8글자>.json
HUB_PRINCIPALS="$HUB_PRINCIPALS" bash infra/onboarding/gcp-platform-tenant-sa.sh
gcloud iam workload-identity-pools create-cred-config "$PROVIDER_NAME" --service-account="$SA" --credential-source-file=/var/run/secrets/tokens/gcp/token --credential-source-type=text --output-file="gcp-creds/$SLUG.json"
kubectl create configmap argocd-gcp-creds -n argocd --from-file=gcp-creds/ --dry-run=client -o yaml | kubectl apply -f -
```

- ponytail: 3번은 회사마다 손으로 한다. 회사가 늘면 환경 연결 때 워커가 이 ConfigMap 을 고치게 한다.
- 고객 GKE 쪽 허용: `gcp-connect.sh` 가 회사 SA 에 `container.clusters.get` 만 주고, 앱 구역 Role·RoleBinding 은 apply 때 Terraform 이 만든다. 워커에 `GCP_PLATFORM_PROJECT` 가 있어야 회사 SA 를 넘긴다. 이미 연결한 고객은 `infra/onboarding/README.md` "이미 연결한 고객의 Argo CD 허브 권한" 을 따른다.

허브의 고객 EKS 로그인. 저장되는 키 없이, 허브 파드의 역할(Pod Identity `platform-argocd-hub`)로 고객 계정의 `svc-deploy` 를 빌려 EKS 토큰을 만든다 (`awsAuthConfig`).
cluster Secret(`tenants/<회사>/argocd/cluster-aws-eks.yaml`)과 앱 구역 RoleBinding 은 워커가 이전마다 만든다. 사람이 하는 것은 플랫폼에 한 번뿐이다.

```
# 1. 허브 역할 만들기: infra/modules/aws/platform 적용 (argocd-hub.tf: 역할 + argocd 의 application-controller·server Pod Identity 연결)
terraform -chdir=infra/modules/aws/platform plan     # 새 자원 4개(역할·정책·연결 2개)만 늘어나는지 본다
terraform -chdir=infra/modules/aws/platform apply
HUB_ROLE_ARN=$(terraform -chdir=infra/modules/aws/platform output -raw argocd_hub_role_arn)

# 2. 허브 다시 띄우기: 값 파일의 AWS 지역 변수를 받고, 새 Pod Identity 연결은 파드를 새로 만들어야 먹는다
helm upgrade --install argocd oci://ghcr.io/argoproj/argo-helm/argo-cd --version 10.11.7 -n argocd -f deploy/argocd/argo-cd.values.yaml [-f "$TMPDIR/gke-login.yaml"]
kubectl rollout restart -n argocd statefulset/argocd-application-controller deployment/argocd-server

# 3. api·worker 에 허브 역할 알려 주기 (api = 연결 링크가 고객 템플릿에 svc-deploy 를 만듦, worker = EKS 앱 구역 RoleBinding·cluster Secret)
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set argocd.hubRoleArn="$HUB_ROLE_ARN"

# 4. 확인: 허브 파드가 AWS 자격을 찾는지 (토큰은 서명만 하고 AWS 에 묻지 않는다. 실제 svc-deploy 빌리기는 첫 EKS 배포의 Argo 상태로 본다)
kubectl exec -n argocd argocd-application-controller-0 -- sh -c 'argocd-k8s-auth aws --cluster-name x >/dev/null && echo creds-found'
```

- 고객 쪽: 연결 템플릿을 `ArgoHubRoleArn` 과 함께 다시 적용하고 RBAC 두 파일을 한 번 적용한다 (`infra/onboarding/README.md` "이미 연결한 고객: 배포 역할 더하기"). 안 하면 그 고객의 EKS 배포는 Argo CD 로그인 실패로 멈춘다.
- 3번을 하지 않으면(값 없음) 예전과 같다: 워커는 EKS cluster Secret·RoleBinding 을 만들지 않고, 목적지는 사람이 등록한다.
- 연결 템플릿이 바뀌었으면(`svc-deploy` 신뢰의 TagSession, 관찰 `ec2:DescribeSubnets`) S3 객체도 바꾼다: `CTS_DRY=1 bash tools/connect-template-sync.sh` 로 보고 `bash tools/connect-template-sync.sh`.
- DRAFT(ai) 【추정】 4번의 `argocd-k8s-auth aws` 가 Pod Identity 자격을 읽는지는 실측 전이다. 못 읽으면 허브 파드에 IRSA 를 쓰는 길로 바꾼다.

## 워커의 GCP 로그인 (GCP 연결·가져오기·이전에 필요)

허브와 같은 교환 창구를 쓴다. 워커는 EKS 토큰을 구글 토큰으로 바꿔 `svc-worker@<플랫폼 프로젝트>` 로 시작하고, 거기서 회사 전용 SA(`t-<28자>@`), 고객 SA 순서로 빌린다. `svc-worker` 에는 프로젝트 역할이 없어서 회사 SA 를 빌리는 것 말고는 할 수 없다.

```
# 1. 플랫폼 전용 GCP 프로젝트를 만들고 결제 계정을 연결한다. 권한이 없으면 기존 프로젝트를 쓴다

# 2. infra/modules/gcp/platform-wif 적용 (svc-worker 도 여기서 만든다). 출력 audience, worker_principal 을 아래에 쓴다

# 3. 차트에 값 주기. 이후 helm upgrade 는 --reset-then-reuse-values 를 꼭 붙인다 (빠지면 값이 사라져 워커가 GCP 로그인을 잃는다)
#    Git Bash 는 //iam... 을 경로로 바꾸므로 앞에 MSYS_NO_PATHCONV=1 을 붙인다 (바뀌면 렌더가 멈춘다)
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set apps.image.registry=725072160743.dkr.ecr.ap-northeast-2.amazonaws.com --set apps.image.tag=$TAG --set otelGateway.image=725072160743.dkr.ecr.ap-northeast-2.amazonaws.com/svc-api:$TAG --set gcpPlatform.project=$PROJECT --set gcpPlatform.wifAudience=$AUDIENCE

# 4. 회사마다: 워커에 그 회사 SA 가장 권한을 준다 (위 허브 3번과 같은 스크립트, 같이 실행하면 된다). 진짜 플랫폼 회사 UUID 를 쓴다
WORKER_PRINCIPAL="$WORKER_PRINCIPAL" PLATFORM_PROJECT="$PROJECT" TENANT_ID="$TENANT" bash infra/onboarding/gcp-platform-tenant-sa.sh

# 5. 확인: 토큰이 나오면(출력은 버린다) svc-worker 로그인이 된 것이다
kubectl exec -n platform deploy/worker -- sh -c 'gcloud auth print-access-token >/dev/null && echo ok'
```

- TODO(human): 5번을 실제 환경에서 돌려 보지 않았다. gcloud 가 `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` 로 이 설정 파일을 못 읽으면 워커 시작 때 `gcloud auth login --cred-file` 을 부르는 길로 바꾼다.
- 고객 쪽은 회사 SA 이름이 바뀌므로 `gcp-connect.sh` 를 다시 실행한다.

## 관측 기본판 (이 차트와 따로 설치)

공식 차트 kube-prometheus-stack 으로 Prometheus·Grafana 를 `monitoring` 네임스페이스에 올린다. 값은 `deploy/observability/kube-prometheus-stack.values.yaml`.

```
# 1. Prometheus·Grafana
helm upgrade --install monitoring oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack --version 92.17.1 -n monitoring --create-namespace -f deploy/observability/kube-prometheus-stack.values.yaml

# 2. 이전 대시보드 (Grafana 가 라벨 grafana_dashboard=1 을 보고 읽는다)
kubectl create configmap svc-migrations-dashboard -n monitoring --from-file=deploy/observability/grafana/dashboards/migrations.json --dry-run=client -o yaml | kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f -

# 3. 보기 (공개 주소 없음). 아이디 admin, 비밀번호는 아래 값 (채팅·레포에 남기지 않는다) → http://localhost:3001
kubectl get secret monitoring-grafana -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d
kubectl port-forward svc/monitoring-grafana -n monitoring 3001:80
```

앱 배포에 넣을 것:

- api·worker 컨테이너에 이름이 `metrics` 인 포트 (api 9464, worker 9465). Prometheus 는 `platform` 네임스페이스에서 이 이름의 포트만 긁고, 라벨 `app.kubernetes.io/name` 을 job 으로 쓴다.
- 게이트웨이 이미지: `helm upgrade` 에 `--set otelGateway.image=<레지스트리>/api:<태그>`. api 이미지의 다른 진입점(`metrics-gateway.mjs`)이라 따로 빌드하지 않는다.
- 워커의 `PROM_URL=http://monitoring-kube-prometheus-prometheus.monitoring:9090` 은 고객 지표(`svc_ingress_*`)가 들어온 뒤에 켠다. 없으면 트래픽 전환(shift)이 가중치를 건드리기 전에 `TRAFFIC_NOT_CONFIGURED` 로 멈추고(가짜 지표로 판정하지 않는다. 시험 판 `MOCK_IAC=1`·`MOCK_TRAFFIC=1` 만 흉내), 켰는데 고객 지표가 없으면 표본 부족으로 기다리다가 판정 횟수 한도(기본 600번)를 넘겨 롤백한다.

## 고객 지표 받기 (OTel 게이트웨이)

```
고객 Collector → HTTPS + Bearer 지표 토큰 → Cloudflare → 터널 → otel-gateway → Prometheus → Grafana·트래픽 판정
```

- 토큰 발급: `POST /api/v1/environments/:id/metric-token` (연결된 환경만). 원문은 응답에 한 번만 나오고 DB 에는 sha256 만 남는다. 다시 발급하면 이전 토큰은 끊기고, 환경을 해제해도 끊긴다.
- 입구 컨테이너가 토큰으로 회사·환경을 찾고, Collector 가 보낸 쪽의 `tenant`·`environment` 를 그 값으로 덮어쓴다.
- 받는 지표: `svc_ingress_requests_total`(카운터), `svc_ingress_request_duration_seconds`(히스토그램). 다른 이름은 버린다.
- 보낸 쪽이 붙일 라벨: `env`(source 또는 target), `migration`(이전 번호), 요청 수에는 `code`, Ingress 가 여러 개면 파드마다 다른 `replica`. 형식이 틀리면 버리고, 정한 라벨 밖은 지운다.

온프레 도착은 수집기를 설치 묶음이 깐다: `tools/onprem-install.sh` 에 `METRICS_URL`(이 주소의 `/v1/metrics`)·`METRIC_TOKEN_FILE`(그 환경의 토큰 파일)을 주면 `deploy/helm/onprem-agent` 의 `svc-metrics` 가 이전마다 앱 차트 cloudflared(표시 `svc.platform/metrics`)의 상태 코드별 응답 수를 `svc_ingress_requests_total{env="target",migration,code,replica}` 로 보낸다. cloudflared 에는 요청 응답 시간 지표가 없어 지연 히스토그램은 안 보낸다 (판정은 오류율만).

고객 Collector 설정 (토큰은 파일이나 환경 변수로만 넣는다):

```yaml
extensions:
  bearertokenauth:
    token: ${env:SVC_METRIC_TOKEN}
exporters:
  otlphttp:
    metrics_endpoint: https://metrics.<도메인>/v1/metrics
    auth:
      authenticator: bearertokenauth
```

## 온프레 DB 이전 켜기 (ADR-019, 한 번)

온프레 도착 DB 로 복제하려면 worker 에 키 2개, 플랫폼 DB 에 표 하나(0050), 새 이미지가 있어야 한다. 순서가 중요하다.
facts 계약이 strict 라 **플랫폼(api)을 먼저 올리고 고객 Agent 를 나중에** 올린다 (새 Agent 가 보내는 `sealing`·`egressIp` 를 옛 api 는 거부한다).

```
# 1. 값 넣기. 기존 platform/app JSON 에 두 키만 더한다. 값은 화면·셸 기록에 안 남는다
#    REPL_SECRET_MASTER_KEY 가 이미 있으면 그대로 둔다 (바꾸면 진행 중인 이전의 비밀이 전부 달라진다)
#    PLATFORM_EGRESS_CIDRS = worker 가 나가는 NAT 공인 IP. 쉼표로 여러 개
aws ec2 describe-nat-gateways --filter Name=state,Values=available --query 'NatGateways[].NatGatewayAddresses[].PublicIp' --output text
umask 077; f=$(mktemp)
aws secretsmanager get-secret-value --secret-id platform/app --query SecretString --output text \
  | python3 -c 'import json,sys,secrets; d=json.load(sys.stdin); d.setdefault("REPL_SECRET_MASTER_KEY", secrets.token_hex(32)); d["PLATFORM_EGRESS_CIDRS"]=sys.argv[1]; json.dump(d, open(sys.argv[2],"w")); print(sorted(d))' "<NAT IP>/32" "$f"
aws secretsmanager put-secret-value --secret-id platform/app --secret-string "file://$f" >/dev/null; rm -f "$f"

# 2. 표 0050 (플랫폼 DB). 새 worker 이미지보다 먼저: 새 worker 는 클라우드 이전까지 모든 이전에서 이 표를 읽는다
#    임시 파드에서 db-migrate.sh 를 돌린다 (표 주인 비밀번호는 RDS 관리 비밀 → k8s Secret, 화면에 안 나옴). main 에서
bash tools/platform-db-migrate.sh status    # pending 이 0050_replication_endpoints.sql 하나인지 본다
bash tools/platform-db-migrate.sh apply     # 남은 것이 그 하나가 아니면 아무것도 안 넣고 멈춘다

# 3. 이미지: main 에 들어간 뒤 build-ecr 을 돌린다 (태그 sha-<커밋 7자>)
gh workflow run build-ecr.yml --ref main

# 4. 차트. --reuse-values 가 아니라 --reset-then-reuse-values (helm 3.14+).
#    --reuse-values 는 옛 릴리스의 값(옛 secretKeys 4개)이 새 기본값을 덮어 키 2개가 worker 로 안 간다. 이미 준 --set 값은 그대로 남는다 (위 3-2·GCP 값 주기도 같은 플래그)
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set apps.image.tag=<새 태그>
kubectl -n platform get externalsecret worker-env        # SecretSynced 가 아니면 1번 JSON 에 키가 빠진 것
kubectl -n platform get secret worker-env -o json | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)["data"]))'   # 키 이름만

# 5. 고객 온프레: 새 Agent 이미지 + 봉인 컨트롤러 (tools/onprem-install.sh 머리말 그대로 다시 돌린다)
```

확인: 고객 Agent 보고 뒤 `agent_reports` 의 facts 에 `sealing.certPem`·`egressIp` 가 있으면 이전 계획이 봉인 인증서와 중계 SSH 허용 IP 를 쓸 수 있다.

## 온프레 설치 한 줄 켜기 (한 번)

고객은 콘솔 연결 화면의 명령 한 줄(`curl -fsSL <플랫폼>/api/v1/install/onprem.sh | SVC_ENROLL_TOKEN=et_... bash`)만 자기 서버에서 실행한다. GitHub 작업은 고객이 하지 않는다.
등록 순간에 플랫폼이 회사 전용 gitops 레포(`gitops-t-<회사>`)를 만들고, 고객 서버가 만든 SSH 공개 키를 그 레포에만 읽기 전용 배포 키로 건다. 워커는 온프레 묶음을 그 레포로 복사한다.
그래서 고객 Argo CD 자격이 새도 그 회사 폴더만 보인다 (공용 gitops 레포 읽기 토큰을 고객에게 주지 않는다).

```bash
# 1. GitHub 조직 설정: Settings → Member privileges(또는 Repository) → Deploy keys 허용 (꺼져 있으면 등록이 TENANT_REPO_DEPLOY_KEY_DENIED 로 멈춘다)
# 2. 플랫폼용 GitHub 토큰 1개 (fine-grained, 조직 소유, 모든 레포: Administration 쓰기 + Contents 쓰기). 레포 만들기·배포 키 걸기(api)·회사 레포 push(worker)에 쓴다
# 3. Agent 이미지 공개: Actions → publish-onprem-agent 실행 → 조직 Packages 에서 svc-onprem-agent 를 Public 으로 (처음 한 번). 요약 끝의 이름@sha256 을 적어 둔다
# 4. platform/app JSON 에 키 넣기 (값은 채팅·레포에 남기지 않는다). secretKeys 보다 먼저 넣는다
#    GITOPS_TENANT_REPO_URL = https://github.com/<조직>/gitops-{tenant}.git   ({tenant} 그대로. 회사마다 바뀐다)
#    GITOPS_TENANT_TOKEN    = 2번 토큰
#    ONPREM_AGENT_IMAGE     = 3번 이름@sha256
#    ONPREM_METRICS_URL     = https://metrics.<도메인>/v1/metrics   (트래픽 판정 지표 수집기가 보낼 곳. 등록 응답에 지표 토큰이 같이 나간다)
# 5. helm upgrade 로 api·worker 가 새 키를 받게 한다 (기본 values 에는 안 넣었다: 다른 사람이 키 없이 upgrade 해도 동기화가 멈추지 않게)
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values \
  --set 'components.api.secretKeys={DATABASE_URL,JWT_SECRET,PLATFORM_PRINCIPAL_ARN,AGENT_REPORT_MASTER_KEY,PUBLIC_API_URL,CONNECT_TEMPLATE_URL,GITOPS_TENANT_REPO_URL,GITOPS_TENANT_TOKEN,ONPREM_AGENT_IMAGE,ONPREM_METRICS_URL}' \
  --set 'components.worker.secretKeys={DATABASE_URL,GITOPS_REPO_URL,GITOPS_WRITE_TOKEN,GITOPS_PUSH,REPL_SECRET_MASTER_KEY,PLATFORM_EGRESS_CIDRS,GITOPS_TENANT_REPO_URL,GITOPS_TENANT_TOKEN}'
# 6. 확인: 로그인 없이 스크립트가 나오면 된다 (503 이면 ONPREM_AGENT_IMAGE 가 없거나 모양이 틀림)
curl -fsS https://console.<도메인>/api/v1/install/onprem.sh | head -3
```

- 이미 설치된 고객(손으로 설치, 공용 레포 토큰)은 콘솔에서 새 등록 명령을 받아 `SVC_REENROLL=1` 을 앞에 붙여 다시 돌리면 회사 레포·배포 키로 바뀐다. 그 다음 그 서버의 공용 레포 토큰 파일은 지운다.
- 키를 안 넣으면 예전과 같다: 콘솔 명령은 레포 스크립트(`npm run agent:onprem -- --enroll`), 워커는 공용 레포에만 쓴다.

## worker Terraform 작업 폴더 디스크

자원 생성 작업은 worker 안 작업 폴더에 state·입력값·출력값·DB 비밀 파일을 둔다. 기본값(`/tmp`)이면 파드가 지워질 때 함께 사라져, 만든 자원을 Terraform 으로 지우지 못한다. 실제 자원을 만들기 전에 디스크를 켠다.

```bash
# 1. 플랫폼 Terraform apply 로 aws-ebs-csi-driver 애드온을 만든다
# 2. worker 를 1개로 줄이고 디스크를 켠다
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values \
  --set apps.worker.replicas=1 --set apps.worker.tfWorkDir.size=20Gi
```

- worker 는 1개만 뜬다. EBS 는 파드 하나만 붙기 때문이다. 재배포 때는 이전 파드를 먼저 내려 잠깐 작업이 멈춘다 (`Recreate`).
- 디스크는 첫 파드가 뜬 가용 영역에 묶인다. cred 노드가 다른 영역으로 바뀌면 파드가 `Pending` 이 된다. 그 영역에 노드를 늘리면 다시 뜬다.
- `helm uninstall` 이나 PVC 삭제로도 디스크는 남는다 (`resource-policy: keep`, `reclaimPolicy: Retain`). 지우는 것은 사람이 한다.

## 클라우드 도착 트래픽 지표 (AWS·GCP)

`trafficMetrics.endpoint` 를 주면 도착 cloudflared 파드 안에 수집기가 같이 뜬다. 배포 권한에 RBAC·NetworkPolicy 가 없어 온프레처럼 따로 띄우지 않는다. 비우면 아무것도 안 그린다.

```
# 1. 도착 환경의 지표 토큰 받기 (POST /api/v1/environments/:id/metric-token). 원문은 응답에 한 번만 나온다
# 2. 도착 비밀 저장소의 svc-metric-token 에 {"token": "<값>"} 넣기. 정확한 이름은 이전 계획의 경고 줄에 나온다
#    GCP 도착은 앱 층 apply 가 그릇(app-<앱>-svc-metric-token)을 값 없이 만들어 둔다. 손으로 만든 그릇은 ESO 가 못 읽으니 값(버전)만 넣는다 (infra/README.md "ESO 읽기 권한 (GCP)")
# 3. 차트 값 주기
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set trafficMetrics.endpoint=https://metrics.<도메인>/v1/metrics
# 4. 도착 지표가 Prometheus 에 들어오는 것을 본 뒤에 판정을 켠다. 먼저 켜면 표본 부족으로 롤백된다
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set trafficMetrics.promUrl=http://monitoring-kube-prometheus-prometheus.monitoring:9090
```

지표·전환기 없이 실측할 때만 `--set traffic.mock=true` 로 worker 에 `MOCK_TRAFFIC=1` 을 넣는다 (shifting 이 가짜 지표·mock 전환기로 넘어간다, `DEMO_MODE=1` 과 같이 못 씀). 기본은 끔이라 설정이 없으면 `TRAFFIC_NOT_CONFIGURED` 로 멈춘다.

GCP 도착에 GKE 가 없을 때 worker 가 환경 층을 만들게 하려면 `--set envLayer.auto=true` (worker `ENV_LAYER_AUTO=1`). 켠 뒤에 만든 계획부터 들어가므로 이전을 만들기 전에 켠다. 예전처럼 비밀 JSON·`secretKeys` 로 넣지 않는다.

- 값을 켜면 토큰은 필수다. 저장소에 없으면 배포가 커밋 전에 `SECRET_VALUES_MISSING` 으로 멈추고 어느 이름이 없는지 알려 준다. 넣고 재개하면 된다. 이때 트래픽은 아직 출발에 있다.
- 값을 켠 시점 이후 배포부터 수집기가 붙는다. 지문에는 안 들어가서 이미 승인한 계획도 그대로 간다.
- 응답 시간은 잴 수 없어 판정은 오류율로만 하고 "지연 미측정"으로 남는다.
- gitops 레포의 `charts/app` 을 이 레포와 같게 맞춰야 수집기가 그려진다.
- TODO(human): 토큰을 사람이 넣는다. worker 가 이전마다 발급해 넣는 길은 아직 없다.

## 아직 없는 것

- TODO(human): 비밀 JSON 에 들어 있는 비밀 아닌 키(`GITOPS_REPO_URL`·`GITOPS_PUSH`·`PLATFORM_EGRESS_CIDRS`·`PUBLIC_API_URL`·`CONNECT_TEMPLATE_URL`)를 `apps.<이름>.env` 로 옮길지. 옮기려면 같은 `helm upgrade` 에서 `secretKeys` 에서 빼고 `env` 에 넣는다 (둘 다 있으면 렌더가 멈춘다). 지금은 그대로 `platform/app` JSON 으로 받는다 (없으면 배포 작업이 `GITOPS_NOT_CONFIGURED` 로 멈춘다)
- 고객 쪽 Collector 설치와 Ingress 지표(`svc_ingress_*`) 만들기. 게이트웨이는 받을 준비만 되어 있다
- 지표 토큰을 콘솔 화면에서 받는 길. 지금은 API 만 있다
- TODO(human): Collector 설정(`templates/otel-gateway.yaml`)을 실제 Collector 0.164.0 으로 돌려 보지 않았다. 첫 설치 때 파드 로그와 라벨 덮어쓰기를 확인한다
- `monitoring` 접근 제한(NetworkPolicy). Prometheus 는 로그인이 없어 클러스터 안 파드면 읽을 수 있다
- 플랫폼 Terraform `aws-ebs-csi-driver` 애드온은 코드에 있다. apply 전에는 worker 작업 폴더 PVC, `sbx-standard` PVC, vCluster 제어판 PVC 가 묶이지 않는다
- TODO(human): sandbox 노드에 runsc 설치 (`main.tf` sandbox launch template). 그 전에는 `sandbox.gvisor.enabled=false` 로 두고, 수정 고리(remediation) 샌드박스 워크로드는 뜨지 않는다
- TODO(human): DATABASE_URL 의 TLS. RDS 는 TLS 만 받는다. `sslmode=require` 는 pg 가 인증서 검증까지 하므로 RDS CA 묶음(`NODE_EXTRA_CA_CERTS`)을 같이 줘야 한다.
- TODO(human): `0001_init.sql` 의 고정 `app_user` 비밀번호를 바꾼 뒤 `DATABASE_URL` 을 넣는다.

## 샌드박스 (vCluster 리허설·수정 고리)

agent-worker 결정 코드만 호스트 샌드박스 권한을 쥔다. worker 는 고객 자격을 쥐므로 샌드박스 권한을 받지 않는다. LLM 도구는 가상 클러스터 안 kubeconfig 만 받는다.

### agent-worker 가 하는 순서

1. 네임스페이스 `sbx-<이름>` 을 아래 라벨 다섯과 함께 만든다.
2. 그 안에 RoleBinding `sbx-operator` (ClusterRole `sbx-operator` → `platform/agent-worker`) 를 만든다.
3. vCluster 차트를 같은 네임스페이스에 helm 으로 올린다. 차트 Role 은 `vc-<릴리스>`, SA 도 `vc-<릴리스>` 다.
4. 끝나면 helm uninstall, 네임스페이스를 지운다. 만료 청소는 `platform.svc/expires-at` 이 지난 `platform.svc/sandbox=true` 네임스페이스를 지운다.

### 앱에 넣는 값 (차트가 values 에서 넣는다)

| values | 앱 | 들어가는 것 |
|---|---|---|
| `sandbox.rehearsal.enabled` (`sandbox.enabled` 필요, 없으면 렌더가 멈춘다) | worker | env `SANDBOX_REHEARSAL=on`, `SANDBOX_IMAGE_REGISTRY=<sandbox.imageRegistry>` |
| `sandbox.gvisor.enabled` | agent-worker | env `SANDBOX_RUNTIME_CLASS=<sandbox.gvisor.runtimeClass>` |
| `agentRemediation.gitopsRead` | agent-worker | `platform/app` 의 `GITOPS_REPO_URL`·`GITOPS_READ_TOKEN` (JSON 에 `GITOPS_READ_TOKEN` 을 먼저 넣는다) |
| `agentRemediation.sandboxMode` (`memory`·`vcluster`, 비우면 넣지 않음) | agent-worker | env `SANDBOX_MODE`. `vcluster` 는 `sandbox.enabled`·`sandbox.gvisor.enabled` 가 같이 켜져 있어야 렌더된다 (수정 실행 파드는 gVisor 만 받는다) |

- 복사 자리와 런타임 이름을 호스트 가드와 같은 값 하나에서 꺼낸다. 비밀 JSON 에 따로 넣어 두면 가드와 어긋날 수 있다. 같은 키가 JSON 에도 있으면 차트 env 가 이긴다.
- AI 점검에는 읽기 토큰만 준다. agent-worker 는 고객 로그를 LLM 에 넣는 곳이고, gitops 레포 `main` 에는 보호 규칙이 없어 쓰기 토큰이 새면 고객 클러스터 배포로 이어진다. 수정안은 원격에 push 하지 않고 패치로 남는다(`GITOPS_PUSH` 없음).
- 한 번 준 `--set` 은 이후 `helm upgrade --reset-then-reuse-values` 가 그대로 이어 쓴다. 이 칸이 없는 예전 릴리스 값으로 올려도 렌더는 돈다(꺼진 것으로 본다).

### 라벨 계약 (네임스페이스)

| 라벨 | 값 | 누가 본다 |
|---|---|---|
| `platform.svc/sandbox` | `true` | 파드·서비스·ingress 가드가 이 라벨로 네임스페이스를 고른다 |
| `platform.svc/sandbox-purpose` | `rehearsal` \| `remediation` | `remediation` 만 `sbx-runtimeclass-guard` 가 걸린다 |
| `platform.svc/expires-at` | 유닉스 초 10자리 | 만료 청소 |
| `pod-security.kubernetes.io/enforce` | `baseline` | PSA. vCluster 제어판이 root 라 restricted 는 안 된다. 가상 앱 파드 수준은 가상 API 서버가 따로 맡는다 |
| `platform.svc/tenant` | 테넌트 id. DB `tenants.id`(uuid)를 소문자 그대로 (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) | `sbx-pod-guard` 이미지 경로 규칙. 바꾸거나 지울 수 없다 |

agent-worker 는 이 다섯이 다 맞는 `sbx-` 네임스페이스만 만들고 지운다. 다른 라벨(예: 실행 번호)은 더 달아도 된다. 네임스페이스를 고치는(patch) 권한은 없어서 만든 뒤 라벨을 바꿀 수 없다. 테넌트 라벨은 다른 요청자(관리자 포함)도 바꾸거나 지울 수 없다 (`sbx-namespace-guard` UPDATE).

### 권한

| 이름 | 묶는 곳 | 내용 |
|---|---|---|
| ClusterRole `sbx-provisioner` | ClusterRoleBinding → `platform/agent-worker` | namespaces get·list·watch·create·delete, rolebindings create, clusterroles `sbx-operator` bind |
| ClusterRole `sbx-operator` | `sbx-*` 안 RoleBinding 으로만 | vCluster 0.37.6 Role `vc-<릴리스>` 규칙 전부 + helm 이 차트 자원과 릴리스 Secret 을 다루는 몫. statefulsets·deployments 는 만들고 지울 수 있다 (제어판 저장을 끄면 차트가 Deployment 를 그린다). 차트를 올리고 vCluster 값을 바꾸면 이 규칙이 모자랄 수 있다 (helm 이 403 으로 멈춘다) |
| (같은 `sbx-operator`) port-forward | `sbx-*` 안 RoleBinding 으로만 | `kubectl port-forward -n sbx-<이름> svc/<이름> 0:443` 에 필요한 services get, pods get·list, pods/portforward create 가 들어 있다. agent-worker 가 클러스터 밖(로컬)에서 SA 토큰으로 가상 API 에 붙을 때 쓴다. `sbx-*` 밖에서는 RBAC 가 막고, port-forward(CONNECT)를 보는 VAP 는 없다 |

### 호스트 가드 (ValidatingAdmissionPolicy, 바인딩 이름도 같다)

| 이름 | 대상 | 막는 것 |
|---|---|---|
| `sbx-namespace-guard` | namespaces CREATE·DELETE 는 요청자 agent-worker, UPDATE 는 요청자 누구든 `platform.svc/sandbox=true` 네임스페이스 | 만들기·지우기: `sbx-` 아닌 이름, 라벨 계약 위반. 고치기: `platform.svc/tenant` 값 바꾸기·지우기 |
| `sbx-rolebinding-guard` | rolebindings CREATE·UPDATE, 요청자 agent-worker | `sbx-` 밖, `sbx-operator`→agent-worker 와 `Role/vc-<이름>`→SA `vc-<이름>` 말고 다른 묶음 |
| `sbx-pod-guard` | pods, pods/ephemeralcontainers CREATE·UPDATE, `platform.svc/sandbox=true` | nodeSelector `pool=sandbox` 없음, 만들 때 nodeName, hostNetwork·hostPID·hostIPC, hostPath, hostPort, privileged, 테넌트 밖 플랫폼 계정 ECR 이미지 (아래), 동기화된 파드(`vcluster.loft.sh/managed-by`)의 `release=<그 값>` 과 `app=vcluster-snapshot` |
| `sbx-runtimeclass-guard` | pods CREATE, `platform.svc/sandbox-purpose=remediation` (`sandbox.gvisor.enabled=true` 면 `rehearsal` 도) | `runtimeClassName` 이 `sandbox.gvisor.runtimeClass` 가 아님. vCluster 제어판(`app=vcluster` 이면서 `vcluster.loft.sh/managed-by` 없음)만 뺀다 |
| `sbx-service-guard` | services CREATE·UPDATE, `platform.svc/sandbox=true` | ClusterIP 아닌 type, externalIPs |
| `sbx-ingress-guard` | ingresses, gateways·httproutes·tlsroutes·grpcroutes, `platform.svc/sandbox=true` | 만들기 전부 |

리허설은 gVisor 없이 runc 로 돈다. 전용 sandbox 노드에 한 번에 한 테넌트다. `sandbox.gvisor.enabled=false` 면 RuntimeClass 가 없어서 수정 고리 샌드박스 워크로드는 거부된다 (닫힌 쪽).

### 이미지 경로 규칙 (`sbx-pod-guard`)

sandbox 노드 IAM 역할(`<이름>-sandbox-node`, `AmazonEC2ContainerRegistryReadOnly`)은 계정 ECR 전체를 읽는다. 노드 역할을 회사별로 나눌 수 없으니 파드 이미지 경로를 입장(admission)에서 막는다.

- 대상: containers, initContainers, ephemeralContainers 의 `image`. 파드 CREATE·UPDATE 와 `pods/ephemeralcontainers`.
- 플랫폼 계정 ECR 이미지 = 호스트가 대소문자 무시 `^<계정>\.dkr[.-]` 로 시작하는 것. `<계정>` 은 `sandbox.imageRegistry` 의 앞 12자리다. 어느 리전이든, FIPS(`dkr.ecr-fips`), 듀얼스택(`dkr-ecr ... on.aws`), `:443` 을 붙인 표기도 여기에 든다.
- 플랫폼 계정 ECR 이미지는 `<sandbox.imageRegistry>/<네임스페이스 라벨 platform.svc/tenant>/` 로 (대소문자까지 그대로) 시작해야 한다. 이미지 복사 단계가 만드는 모양은 `<sandbox.imageRegistry>/<테넌트 id>/<이름>@sha256:<다이제스트>` 다.
- 네임스페이스에 `platform.svc/tenant` 가 없거나 모양이 틀리면 플랫폼 계정 ECR 이미지는 전부 거부한다 (닫힌 쪽).
- 다른 레지스트리 이미지는 통과한다. 지금 샌드박스 호스트에 뜨는 것은 공개·다이제스트 고정 이미지다: vCluster 제어판(`ghcr.io/loft-sh/vcluster-oss`, `ghcr.io/loft-sh/kubernetes`), 가상 CoreDNS, curl 확인용 파드, Postgres 대역. 다른 계정 ECR 은 이 노드 역할로 읽지 못한다.
- TODO(human): 제어판·CoreDNS 이미지를 플랫폼 ECR 로 옮기면 (agent-worker 설계 질문 7) 그 경로를 이 규칙에 허용으로 더해야 한다. 안 그러면 vCluster 가 뜨지 않는다.

### 동기화 라벨 (측정: kind 1.35.8, vCluster 0.37.6)

vCluster 차트 NetworkPolicy `vc-cp-<릴리스>`(`release=<릴리스>` 파드)와 `vc-snapshot-<릴리스>`(`app=vcluster-snapshot` 파드)는 아무 IP 로 443·8443·6443 을 연다. 동기화된 테넌트 파드는 `vc-work-<릴리스>`(`vcluster.loft.sh/managed-by=<릴리스>`)만 받아 가상 클러스터 안으로만 나간다. 테넌트 파드가 앞의 두 라벨을 얻으면 NetworkPolicy 가 더해져 바깥 443 이 열린다.

- 동기화는 `app`·`tier` 같은 라벨을 호스트 파드에 그대로 옮긴다. 가상 파드의 `app=vcluster-snapshot` 은 호스트에 그대로 내려온다 → `sbx-pod-guard` 가 거부한다.
- `release`, `vcluster.loft.sh/managed-by`, `vcluster.loft.sh/namespace` 키는 `vcluster.loft.sh/label-<릴리스>-x-<해시>` 로 바꿔 옮기고, `managed-by`·`namespace` 는 동기화가 제 값을 단다. 그래서 0.37.6 에서 가상 파드의 `release=<릴리스>` 는 호스트에 `release` 로 내려오지 않는다. `release` 규칙은 vCluster 가 이 번역을 바꿀 때를 위한 두 번째 겹이다. 보통 `release=foo` 는 된다.

## 앱 배포 (`templates/app.yaml`)

| 앱 | 노드 | 포트 | 검사 | 서비스 계정 |
|---|---|---|---|---|
| api ×2 | general | http 3000, metrics 9464 | 준비 `/readyz`(DB), 살아 있음 `/healthz` | `api` (Pod Identity), 토큰 안 붙임 |
| worker ×2 | cred (toleration `dedicated=cred`) | metrics 9465 | 살아 있음 `/metrics` | `worker` (Pod Identity + Argo CD Role) |
| agent-worker ×1 | general | 없음 | 살아 있음 `node healthcheck.mjs db` | `agent-worker` (클라우드 권한 없음, 샌드박스 권한) |
| web ×2 | general | http 8080 | `/nginx-health` | 없음 (default, 토큰 안 붙임) |

- 모두 비루트(node 1000, nginx 101), 뿌리 파일 시스템 읽기 전용, capabilities 전부 버림. 쓰기 자리는 `/tmp`(emptyDir), web 은 `/etc/nginx/conf.d` 도. node 앱은 `HOME=/tmp`.
- web 은 `/api/*` 를 `http://api:3000` 으로 보낸다 (`API_UPSTREAM`).

### 비밀 아닌 설정 (`apps.<이름>.env`)

시간 제한·동시 처리 수처럼 비밀이 아닌 값은 Secrets Manager JSON·`secretKeys` 를 거치지 않고 차트 값으로 준다. 그 앱 Deployment 의 `env` 맨 뒤에 그대로 붙고, 다른 앱에는 안 간다.

```bash
# worker 만: 가져오기 명령 제한 30초, 단계 큐 워커당 5건
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values \
  --set apps.worker.env.INVENTORY_TIMEOUT_MS=30000 --set apps.worker.env.STEP_CONCURRENCY=5
# 빼기: 그 이름을 null 로
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set apps.worker.env.STEP_CONCURRENCY=null
```

- 한 번 준 값은 이후 `--reset-then-reuse-values` 가 이어 쓴다. 이 칸이 없는 예전 릴리스 값으로 올려도 렌더는 돈다 (빈 맵으로 본다).
- 이름은 대문자·숫자·`_` 만. 값은 글자 하나로 넣는다 (`--set` 숫자·참거짓은 글자로 바뀐다. 값 파일의 큰 정수도 `1e+06` 이 아니라 `1000000`).
- 다음 이름은 렌더가 멈춘다 (`helm upgrade` 전에 막힌다).
  - 비밀처럼 보이는 이름: `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, `*DATABASE_URL`. 비밀은 `platform/app` JSON 에 넣고 `components.<이름>.secretKeys` 에 더한다.
  - 그 앱이 이미 비밀로 받는 이름 (`components.<이름>.secretKeys`, `agentRemediation.gitopsRead` 면 agent-worker 의 `GITOPS_REPO_URL` 도). `env` 가 `envFrom` 을 덮어 값이 두 곳이 되기 때문이다.
  - 차트가 넣는 이름. 아래 값으로 바꾼다 (켜기 값과 가드를 건너뛰지 못하게, 지금 꺼져 있어도 막는다).

| env | 바꾸는 값 |
|---|---|
| `HOME` | 없음 (node 앱 `/tmp` 고정) |
| `API_PORT`·`METRICS_PORT`, web `API_UPSTREAM`·`API_PREFIX` | `apps.api.port`·`apps.api.metricsPort` |
| `WORKER_METRICS_PORT`, `TF_WORK_DIR` | `apps.worker.metricsPort`, `apps.worker.tfWorkDir.size` |
| `ARGO_HUB_ROLE_ARN` | `argocd.hubRoleArn` |
| `GCP_PLATFORM_PROJECT`·`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` | `gcpPlatform.project` |
| `SANDBOX_REHEARSAL`·`SANDBOX_IMAGE_REGISTRY`, `SANDBOX_RUNTIME_CLASS`, `SANDBOX_MODE` | `sandbox.rehearsal.enabled`·`sandbox.imageRegistry`, `sandbox.gvisor`, `agentRemediation.sandboxMode` |
| `TRAFFIC_METRICS_ENDPOINT`·`PROM_URL`, `MOCK_TRAFFIC`, `ENV_LAYER_AUTO` | `trafficMetrics.endpoint`·`promUrl`, `traffic.mock`, `envLayer.auto` |
| `TARGET_TUNNEL_SECRET_ID` (worker 만, 기본 끔) | `targetTunnel.secretId` (`secretKey` 와 둘 다 채울 때만 넣는다) |
| `TARGET_TUNNEL_SECRET_KEY` (worker 만, 기본 끔) | `targetTunnel.secretKey` (`secretId` 와 둘 다 채울 때만 넣는다) |
| `METRIC_TOKEN_AUTOFILL` (worker 만, 기본 끔) | `ingressSecretFill.metricToken` (켜면 `1`) |

템플릿 env 블록에 이름을 더하면 `templates/app.yaml` 의 `$chartEnv` 에도 더한다. `deploy/ci/check-platform.sh` 가 템플릿의 env 이름을 뽑아 하나씩 넣어 보고, 막히지 않으면 실패한다.

### 크기 (`apps.<이름>.resources`)

worker 기본은 requests `cpu 500m`·`memory 512Mi`, 상한 `memory 2Gi` (CPU 상한 없음). 이전 여러 건이 동시에 돌 때 노드가 worker 몫을 비워 두게 했다. 바꾸려면 `--set apps.worker.resources.requests.cpu=<값>`.

- worker 는 cred 노드(t3.medium, Terraform `cred_nodes` 기본 1대, CPU 할당 가능 약 1930m)에 Argo CD 허브와 같이 뜬다. CPU requests 합: worker 2×500m + Argo CD 225m(`deploy/argocd/argo-cd.values.yaml`) + DaemonSet(kube-proxy·aws-node·ebs-csi-node 등) ≈ 1.4 코어 (약 73%).
- 롤링 업데이트는 새 파드를 하나 먼저 띄운다 (2개면 maxSurge 1·maxUnavailable 0). 그때 약 1.9 코어라 cred 1대에서는 새 파드가 `Pending` 으로 남을 수 있다. 그러면 옛 파드 2개가 계속 돌고 새 이미지가 안 올라간다. `kubectl -n platform get pods -l app.kubernetes.io/name=worker` 에서 `Pending` 이면 cred 노드를 2대로 늘리거나 requests 를 낮춘다.

## 검증 (클라우드 없이)

```
helm lint deploy/helm/platform
helm template platform deploy/helm/platform -n platform
```
기대: lint 0 failed, SecretStore 1·ExternalSecret 5·Deployment 1(cloudflared)·ServiceAccount 3·Role 1·RoleBinding 1, 그리고 샌드박스 켬(`sandbox.enabled=true`)이면 ClusterRole 2·ClusterRoleBinding 1·ValidatingAdmissionPolicy 6·ValidatingAdmissionPolicyBinding 6·StorageClass 1. `sandbox.gvisor.enabled=true` 면 RuntimeClass 1 이 더 생긴다. 샌드박스 켬이면 두 명령 모두 `--set sandbox.enabled=true --set sandbox.imageRegistry=000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox` 같은 값이 있어야 한다. `--set otelGateway.image=x` 를 주면 Deployment 2·Service 1·ConfigMap 1 이 된다. `--set apps.image.registry=x --set apps.image.tag=y` 를 주면 Deployment 4(api·worker·agent-worker·web)·Service 2(api·web) 가 더 생긴다. `gcpPlatform.project`·`gcpPlatform.wifAudience` 를 주면 ConfigMap `worker-gcp-cred` 가 더 생기고 worker 에 토큰·설정 파일이 붙는다.

세 벌 렌더 + kubeconform + 개수 확인 + `sandbox.imageRegistry` 없음·틀린 모양 거부는 `bash deploy/ci/check-platform.sh` 한 번이다 (CI `gitops` 작업).

로컬 kind 끝-끝 검사(호스트 가드를 kind 에 올리고 agent-worker 로 vCluster 를 만들고 지우며 허용·거부를 본다)는 `deploy/ci/sandbox-kind-e2e.sh` 다. 사용법은 파일 머리에 있다. CI 에서는 돌리지 않는다.

```
helm template monitoring oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack --version 92.17.1 -n monitoring -f deploy/observability/kube-prometheus-stack.values.yaml
```
기대: 오류 없음, Prometheus 1·Deployment 3·DaemonSet 1·Job 2 전부 `pool: general`, `prom-operator` 문자열 없음, Alertmanager 없음.
