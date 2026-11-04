# deploy/helm/platform: 플랫폼 비밀 연동 + 바깥 입구 + 샌드박스 호스트 가드

상태: AI 초안

플랫폼 EKS(`infra/modules/aws/platform`)에 아래를 올린다.

| 무엇 | 하는 일 |
|---|---|
| External Secrets (SecretStore + ExternalSecret) | Secrets Manager `platform/app` → 컴포넌트별 Secret `<이름>-env` (적은 키만), `platform/cloudflared` → `cloudflared-token` |
| cloudflared ×2 (general 노드) | 바깥에서 들어오는 유일한 길. 터널이 밖으로 연결을 열어서 공개 포트·로드밸런서가 없다 |
| 서비스 계정 `worker`·`api`·`agent-worker` + 워커 Argo CD 권한 | AWS 권한은 Pod Identity(Terraform)가 이름으로 묶는다. 워커는 `argocd` 의 `applications` get·list·patch. agent-worker 는 클라우드 권한이 없다 |
| 샌드박스 호스트 쪽 (`sandbox.enabled`) | agent-worker 가 `sbx-*` 네임스페이스에 vCluster 를 하나씩 만들고 지우는 권한, 호스트 가드 VAP 6개, StorageClass `sbx-standard`, gVisor RuntimeClass(`sandbox.gvisor.enabled` 일 때만). 아래 "샌드박스" 절 |

비밀값은 차트에 없다. 사람이 Secrets Manager 에 넣는다. 앱(api·worker·web) 배포는 이 차트에 아직 없다. 앱 Deployment 는 `envFrom: secretRef: <이름>-env` 로 여기서 만든 Secret 을 쓴다.

## 이름이 맞물리는 곳 (바꾸면 같이 바꾼다)

| 차트 | Terraform (`aws/platform`) |
|---|---|
| ESO 컨트롤러 `external-secrets/external-secrets` | `aws_eks_pod_identity_association.eso` |
| `secrets.app` = `platform/app`, `secrets.cloudflared` = `platform/cloudflared` | `aws_secretsmanager_secret.platform` |
| cloudflared `nodeSelector pool: general` | `aws_eks_node_group.this` 라벨 `pool` |
| 서비스 계정 `platform/worker`, `platform/api` | `aws_eks_pod_identity_association.worker`·`.api` (`pod-identity.tf`) |
| `sandbox.pool` = `sandbox` (파드 nodeSelector `pool`, taint `dedicated=sandbox:NoSchedule`) | `aws_eks_node_group.this["sandbox"]` 라벨 `pool`, taint `dedicated` |

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

- 앱(api·worker·agent-worker·web) 배포. 서비스 계정 `worker`·`api`·`agent-worker`, 워커의 Argo CD Application 권한(`argocd` 네임스페이스 Role), agent-worker 샌드박스 권한은 있다
- TODO(human): 플랫폼 Terraform 에 `aws-ebs-csi-driver` addon 이 없다. 없으면 `sbx-standard`(provisioner `ebs.csi.aws.com`) PVC 와 vCluster 제어판 PVC 가 묶이지 않는다
- TODO(human): sandbox 노드에 runsc 설치 (`main.tf` sandbox launch template). 그 전에는 `sandbox.gvisor.enabled=false` 로 두고, 수정 고리(remediation) 샌드박스 워크로드는 뜨지 않는다
- TODO(human): DATABASE_URL 의 TLS. RDS 는 TLS 만 받는다. `sslmode=require` 는 pg 가 인증서 검증까지 하므로 RDS CA 묶음(`NODE_EXTRA_CA_CERTS`)을 같이 줘야 한다.
- TODO(human): `0001_init.sql` 의 고정 `app_user` 비밀번호를 바꾼 뒤 `DATABASE_URL` 을 넣는다.

## 샌드박스 (vCluster 리허설·수정 고리)

agent-worker 결정 코드만 호스트 샌드박스 권한을 쥔다. worker 는 고객 자격을 쥐므로 샌드박스 권한을 받지 않는다. LLM 도구는 가상 클러스터 안 kubeconfig 만 받는다.

### agent-worker 가 하는 순서

1. 네임스페이스 `sbx-<이름>` 을 아래 라벨 넷과 함께 만든다.
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

agent-worker 는 이 넷이 다 맞는 `sbx-` 네임스페이스만 만들고 지운다. 네임스페이스를 고치는(patch) 권한은 없어서 만든 뒤 라벨을 바꿀 수 없다.

### 권한

| 이름 | 묶는 곳 | 내용 |
|---|---|---|
| ClusterRole `sbx-provisioner` | ClusterRoleBinding → `platform/agent-worker` | namespaces get·list·watch·create·delete, rolebindings create, clusterroles `sbx-operator` bind |
| ClusterRole `sbx-operator` | `sbx-*` 안 RoleBinding 으로만 | vCluster 0.37.6 Role `vc-<릴리스>` 규칙 전부 + helm 이 차트 자원과 릴리스 Secret 을 다루는 몫. 차트를 올리고 vCluster 값을 바꾸면 이 규칙이 모자랄 수 있다 (helm 이 403 으로 멈춘다) |

### 호스트 가드 (ValidatingAdmissionPolicy, 바인딩 이름도 같다)

| 이름 | 대상 | 막는 것 |
|---|---|---|
| `sbx-namespace-guard` | namespaces CREATE·DELETE, 요청자 agent-worker | `sbx-` 아닌 이름, 라벨 계약 위반 |
| `sbx-rolebinding-guard` | rolebindings CREATE·UPDATE, 요청자 agent-worker | `sbx-` 밖, `sbx-operator`→agent-worker 와 `Role/vc-<이름>`→SA `vc-<이름>` 말고 다른 묶음 |
| `sbx-pod-guard` | pods, pods/ephemeralcontainers CREATE·UPDATE, `platform.svc/sandbox=true` | nodeSelector `pool=sandbox` 없음, 만들 때 nodeName, hostNetwork·hostPID·hostIPC, hostPath, hostPort, privileged |
| `sbx-runtimeclass-guard` | pods CREATE, `platform.svc/sandbox-purpose=remediation` | `runtimeClassName` 이 `sandbox.gvisor.runtimeClass` 가 아님. vCluster 제어판(`app=vcluster` 이면서 `vcluster.loft.sh/managed-by` 없음)만 뺀다 |
| `sbx-service-guard` | services CREATE·UPDATE, `platform.svc/sandbox=true` | ClusterIP 아닌 type, externalIPs |
| `sbx-ingress-guard` | ingresses, gateways·httproutes·tlsroutes·grpcroutes, `platform.svc/sandbox=true` | 만들기 전부 |

리허설은 gVisor 없이 runc 로 돈다. 전용 sandbox 노드에 한 번에 한 테넌트다. `sandbox.gvisor.enabled=false` 면 RuntimeClass 가 없어서 수정 고리 샌드박스 워크로드는 거부된다 (닫힌 쪽).

## 검증 (클라우드 없이)

```
helm lint deploy/helm/platform
helm template platform deploy/helm/platform -n platform
```
기대: lint 0 failed, SecretStore 1·ExternalSecret 4·Deployment 1(cloudflared)·ServiceAccount 3·Role 1·RoleBinding 1, 그리고 샌드박스 켬(기본)이면 ClusterRole 2·ClusterRoleBinding 1·ValidatingAdmissionPolicy 6·ValidatingAdmissionPolicyBinding 6·StorageClass 1. `sandbox.gvisor.enabled=true` 면 RuntimeClass 1 이 더 생긴다.

세 벌 렌더 + kubeconform + 개수 확인은 `bash deploy/ci/check-platform.sh` 한 번이다 (CI `gitops` 작업).
