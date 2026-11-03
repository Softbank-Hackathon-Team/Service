# deploy/helm/platform: 플랫폼 비밀 연동 + 바깥 입구

상태: AI 초안

플랫폼 EKS(`infra/modules/aws/platform`)에 두 가지를 올린다.

| 무엇 | 하는 일 |
|---|---|
| External Secrets (SecretStore + ExternalSecret) | Secrets Manager `platform/app` → 컴포넌트별 Secret `<이름>-env` (적은 키만), `platform/cloudflared` → `cloudflared-token` |
| cloudflared ×2 (general 노드) | 바깥에서 들어오는 유일한 길. 터널이 밖으로 연결을 열어서 공개 포트·로드밸런서가 없다 |
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

Cloudflare 쪽: Zero Trust 에서 원격 관리 터널을 만들고 토큰을 `platform/cloudflared` 에 넣는다. 공개 호스트 이름의 서비스는 `http://web.platform.svc.cluster.local:8080` (web 배포가 올라온 뒤).

## 아직 없는 것

- 앱(api·worker·agent-worker·web) 배포. 서비스 계정 `worker`·`api` 와 워커의 Argo CD Application 권한(`argocd` 네임스페이스 Role)은 있다
- TODO(human): DATABASE_URL 의 TLS. RDS 는 TLS 만 받는다. `sslmode=require` 는 pg 가 인증서 검증까지 하므로 RDS CA 묶음(`NODE_EXTRA_CA_CERTS`)을 같이 줘야 한다.
- TODO(human): `0001_init.sql` 의 고정 `app_user` 비밀번호를 바꾼 뒤 `DATABASE_URL` 을 넣는다.

## 검증 (클라우드 없이)

```
helm lint deploy/helm/platform
helm template platform deploy/helm/platform -n platform
```
기대: lint 0 failed, SecretStore 1·ExternalSecret 4·Deployment 1(cloudflared)·ServiceAccount 2·Role 1·RoleBinding 1.
