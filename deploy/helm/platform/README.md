# deploy/helm/platform: 플랫폼 비밀 연동 + 바깥 입구

상태: AI 초안

플랫폼 EKS(`infra/modules/aws/platform`)에 아래를 올린다.

| 무엇 | 하는 일 |
|---|---|
| External Secrets (SecretStore + ExternalSecret) | Secrets Manager `platform/app` → 컴포넌트별 Secret `<이름>-env` (적은 키만), `platform/cloudflared` → `cloudflared-token` |
| cloudflared ×2 (general 노드) | 바깥에서 들어오는 유일한 길. 터널이 밖으로 연결을 열어서 공개 포트·로드밸런서가 없다 |
| OTel 게이트웨이 (이미지 값을 줄 때만, general 노드) | 고객 수집기의 지표를 지표 토큰으로 확인하고, 회사·환경 라벨을 덮어써서 Prometheus 로 넘긴다 |
| 서비스 계정 `worker`·`api` + 워커 Argo CD 권한 | AWS 권한은 Pod Identity(Terraform)가 이름으로 묶는다. 워커는 `argocd` 의 `applications` get·list·patch |

비밀값은 차트에 없다. 사람이 Secrets Manager 에 넣는다. 앱(api·worker·web) 배포는 이 차트에 아직 없다. 앱 Deployment 는 `envFrom: secretRef: <이름>-env` 로 여기서 만든 Secret 을 쓴다.

## 이름이 맞물리는 곳 (바꾸면 같이 바꾼다)

| 차트 | Terraform (`aws/platform`) |
|---|---|
| ESO 컨트롤러 `external-secrets/external-secrets` | `aws_eks_pod_identity_association.eso` |
| `secrets.app` = `platform/app`, `secrets.cloudflared` = `platform/cloudflared` | `aws_secretsmanager_secret.platform` |
| cloudflared `nodeSelector pool: general` | `aws_eks_node_group.this` 라벨 `pool` |
| 서비스 계정 `platform/worker`, `platform/api` | `aws_eks_pod_identity_association.worker`·`.api` (`pod-identity.tf`) |

## 순서 (apply 뒤, 사람이 한 번)

```
# 1. ESO 컨트롤러 (공식 차트. 릴리스 이름 external-secrets → 서비스 계정 이름이 external-secrets)
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace

# 2. 비밀값 넣기 (값은 채팅·레포에 남기지 않는다)
aws secretsmanager put-secret-value --secret-id platform/app --secret-string file://<레포 밖 app.json>
aws secretsmanager put-secret-value --secret-id platform/cloudflared --secret-string file://<레포 밖 cf.json>

# 3. 이 차트
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace
```

`platform/app` JSON 에 넣을 키: `components.*.secretKeys` 에 적은 것 전부 (`DATABASE_URL`, `JWT_SECRET`, `PLATFORM_PRINCIPAL_ARN`, `ANTHROPIC_API_KEY`). 키를 늘리면 JSON 과 `secretKeys` 를 같이 고친다.

Cloudflare 쪽: Zero Trust 에서 원격 관리 터널을 만들고 토큰을 `platform/cloudflared` 에 넣는다. 공개 호스트 이름의 서비스는 `http://web.platform.svc.cluster.local:8080` (web 배포가 올라온 뒤), 지표 주소(예: metrics.<도메인>)는 `http://otel-gateway.platform.svc.cluster.local:4318`.

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

## 아직 없는 것

- 앱(api·worker·agent-worker·web) 배포. 서비스 계정 `worker`·`api` 와 워커의 Argo CD Application 권한(`argocd` 네임스페이스 Role)은 있다
- 고객 쪽 Collector 설치와 Ingress 지표(`svc_ingress_*`) 만들기. 게이트웨이는 받을 준비만 되어 있다
- 지표 토큰을 콘솔 화면에서 받는 길. 지금은 API 만 있다
- TODO(human): Collector 설정(`templates/otel-gateway.yaml`)을 실제 Collector 0.164.0 으로 돌려 보지 않았다. 첫 설치 때 파드 로그와 라벨 덮어쓰기를 확인한다
- `monitoring` 접근 제한(NetworkPolicy). Prometheus 는 로그인이 없어 클러스터 안 파드면 읽을 수 있다
- TODO(human): DATABASE_URL 의 TLS. RDS 는 TLS 만 받는다. `sslmode=require` 는 pg 가 인증서 검증까지 하므로 RDS CA 묶음(`NODE_EXTRA_CA_CERTS`)을 같이 줘야 한다.
- TODO(human): `0001_init.sql` 의 고정 `app_user` 비밀번호를 바꾼 뒤 `DATABASE_URL` 을 넣는다.

## 검증 (클라우드 없이)

```
helm lint deploy/helm/platform
helm template platform deploy/helm/platform -n platform
```
기대: lint 0 failed, SecretStore 1·ExternalSecret 5·Deployment 1(cloudflared)·ServiceAccount 2·Role 1·RoleBinding 1. `--set otelGateway.image=x` 를 주면 Deployment 2·Service 1·ConfigMap 1 이 된다.

```
helm template monitoring oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack --version 92.17.1 -n monitoring -f deploy/observability/kube-prometheus-stack.values.yaml
```
기대: 오류 없음, Prometheus 1·Deployment 3·DaemonSet 1·Job 2 전부 `pool: general`, `prom-operator` 문자열 없음, Alertmanager 없음.
