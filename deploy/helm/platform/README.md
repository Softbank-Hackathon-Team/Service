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
#    app.json 키: DATABASE_URL, JWT_SECRET, PLATFORM_PRINCIPAL_ARN, AGENT_REPORT_MASTER_KEY, PUBLIC_API_URL, GITOPS_REPO_URL, GITOPS_WRITE_TOKEN, GITOPS_PUSH, REPL_SECRET_MASTER_KEY, PLATFORM_EGRESS_CIDRS, ANTHROPIC_API_KEY
#    values.yaml secretKeys 에 적힌 키가 JSON 에 하나라도 없으면 그 컴포넌트의 비밀 동기화가 멈춘다 → 키를 더할 때는 값부터 넣고 helm upgrade
aws secretsmanager put-secret-value --secret-id platform/cloudflared --secret-string file://<레포 밖 cf.json>

# 3. 이 차트 (샌드박스 끔이 기본). 워커 Argo CD 권한이 argocd 네임스페이스에 생기므로 아래 "Argo CD 허브" 1번을 먼저 한다
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace

# 3-1. 리허설 샌드박스를 켤 때. imageRegistry 는 Terraform 출력 sandbox_image_registry 그대로 (없거나 모양이 틀리면 렌더가 멈춘다)
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace \
  --set sandbox.enabled=true \
  --set sandbox.imageRegistry=<계정>.dkr.ecr.<리전>.amazonaws.com/sandbox

# 3-2. 앱 4개를 올릴 때 (registry·tag 둘 다 있어야 만든다). 이미 설치한 뒤에는 --reset-then-reuse-values 를 꼭 붙인다 (--reuse-values 는 새 차트 기본값을 버린다)
#      빠지면 그동안 준 값이 사라져 워커가 GCP 로그인을 잃는다
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace --reset-then-reuse-values --set apps.image.registry=725072160743.dkr.ecr.ap-northeast-2.amazonaws.com --set apps.image.tag=<태그>
```

`platform/app` JSON 에 넣을 키: `components.*.secretKeys` 에 적은 것 전부 (`DATABASE_URL`, `JWT_SECRET`, `PLATFORM_PRINCIPAL_ARN`, `ANTHROPIC_API_KEY`). 키를 늘리면 JSON 과 `secretKeys` 를 같이 고친다.

Cloudflare 쪽: Zero Trust 에서 원격 관리 터널을 만들고 토큰을 `platform/cloudflared` 에 넣는다. 공개 호스트 이름의 서비스는 `http://web.platform.svc.cluster.local:8080` (web 배포가 올라온 뒤), 지표 주소(예: metrics.<도메인>)는 `http://otel-gateway.platform.svc.cluster.local:4318`.

## Argo CD 허브 (이 차트와 따로 설치)

공식 차트 argo-cd 를 `argocd` 네임스페이스의 `cred` 노드에 올린다. 값은 `deploy/argocd/argo-cd.values.yaml`. 공개 주소 없이 port-forward 로만 본다.

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
- TODO(human): 허브가 고객 EKS 에 들어가는 권한과 cluster Secret. 이게 없으면 EKS 고객 Application 은 동기화되지 않는다.

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
- 워커의 `PROM_URL=http://monitoring-kube-prometheus-prometheus.monitoring:9090` 은 고객 지표(`svc_ingress_*`)가 들어온 뒤에 켠다. 없으면 트래픽 전환이 가짜 정상 지표로 판정하고, 켰는데 고객 지표가 없으면 표본 부족으로 기다리다가 판정 횟수 한도(기본 600번)를 넘겨 롤백한다.

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

## 클라우드 도착 트래픽 지표 (AWS·GCP)

`trafficMetrics.endpoint` 를 주면 도착 cloudflared 파드 안에 수집기가 같이 뜬다. 배포 권한에 RBAC·NetworkPolicy 가 없어 온프레처럼 따로 띄우지 않는다. 비우면 아무것도 안 그린다.

```
# 1. 도착 환경의 지표 토큰 받기 (POST /api/v1/environments/:id/metric-token). 원문은 응답에 한 번만 나온다
# 2. 도착 비밀 저장소의 svc-metric-token 에 {"token": "<값>"} 넣기. 정확한 이름은 이전 계획의 경고 줄에 나온다
# 3. 차트 값 주기
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set trafficMetrics.endpoint=https://metrics.<도메인>/v1/metrics
# 4. 도착 지표가 Prometheus 에 들어오는 것을 본 뒤에 판정을 켠다. 먼저 켜면 표본 부족으로 롤백된다
helm upgrade platform deploy/helm/platform -n platform --reset-then-reuse-values --set trafficMetrics.promUrl=http://monitoring-kube-prometheus-prometheus.monitoring:9090
```

- 값을 켜면 토큰은 필수다. 저장소에 없으면 배포가 커밋 전에 `SECRET_VALUES_MISSING` 으로 멈추고 어느 이름이 없는지 알려 준다. 넣고 재개하면 된다. 이때 트래픽은 아직 출발에 있다.
- 값을 켠 시점 이후 배포부터 수집기가 붙는다. 지문에는 안 들어가서 이미 승인한 계획도 그대로 간다.
- 응답 시간은 잴 수 없어 판정은 오류율로만 하고 "지연 미측정"으로 남는다.
- gitops 레포의 `charts/app` 을 이 레포와 같게 맞춰야 수집기가 그려진다.
- TODO(human): 토큰을 사람이 넣는다. worker 가 이전마다 발급해 넣는 길은 아직 없다.

## 아직 없는 것

- TODO(human): worker 의 비밀 아닌 설정(`PROM_URL`, `TF_WORK_DIR` 등)을 차트로 넘기는 길. 지금 앱 Deployment 는 `<이름>-env` 비밀과 포트·`HOME` 만 준다
  - 배포에 꼭 필요한 `GITOPS_REPO_URL`·`GITOPS_PUSH` 는 우선 `GITOPS_WRITE_TOKEN` 과 같이 `platform/app` JSON 으로 받는다 (`values.yaml` worker `secretKeys`). 없으면 배포 작업이 `GITOPS_NOT_CONFIGURED` 로 멈춘다
- 고객 쪽 Collector 설치와 Ingress 지표(`svc_ingress_*`) 만들기. 게이트웨이는 받을 준비만 되어 있다
- 지표 토큰을 콘솔 화면에서 받는 길. 지금은 API 만 있다
- TODO(human): Collector 설정(`templates/otel-gateway.yaml`)을 실제 Collector 0.164.0 으로 돌려 보지 않았다. 첫 설치 때 파드 로그와 라벨 덮어쓰기를 확인한다
- `monitoring` 접근 제한(NetworkPolicy). Prometheus 는 로그인이 없어 클러스터 안 파드면 읽을 수 있다
- TODO(human): 플랫폼 Terraform 에 `aws-ebs-csi-driver` addon 이 없다. 없으면 `sbx-standard`(provisioner `ebs.csi.aws.com`) PVC 와 vCluster 제어판 PVC 가 묶이지 않는다
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
