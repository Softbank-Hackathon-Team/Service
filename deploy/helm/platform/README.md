# deploy/helm/platform: 플랫폼 비밀 연동 + 바깥 입구 + 샌드박스 호스트 가드

상태: AI 초안

플랫폼 EKS(`infra/modules/aws/platform`)에 아래를 올린다.

| 무엇 | 하는 일 |
|---|---|
| External Secrets (SecretStore + ExternalSecret) | Secrets Manager `platform/app` → 컴포넌트별 Secret `<이름>-env` (적은 키만), `platform/cloudflared` → `cloudflared-token` |
| cloudflared ×2 (general 노드) | 바깥에서 들어오는 유일한 길. 터널이 밖으로 연결을 열어서 공개 포트·로드밸런서가 없다 |
| 서비스 계정 `worker`·`api`·`agent-worker` + 워커 Argo CD 권한 | AWS 권한은 Pod Identity(Terraform)가 이름으로 묶는다. 워커는 `argocd` 의 `applications` get·list·patch. agent-worker 는 클라우드 권한이 없다 |
| 샌드박스 호스트 쪽 (`sandbox.enabled`) | agent-worker 가 `sbx-*` 네임스페이스에 vCluster 를 하나씩 만들고 지우는 권한, 호스트 가드 VAP 6개(테넌트별 ECR 이미지 경로 포함), StorageClass `sbx-standard`, gVisor RuntimeClass(`sandbox.gvisor.enabled` 일 때만). `sandbox.imageRegistry` 가 꼭 있어야 한다. 아래 "샌드박스" 절 |

비밀값은 차트에 없다. 사람이 Secrets Manager 에 넣는다. 앱(api·worker·web) 배포는 이 차트에 아직 없다. 앱 Deployment 는 `envFrom: secretRef: <이름>-env` 로 여기서 만든 Secret 을 쓴다.

## 이름이 맞물리는 곳 (바꾸면 같이 바꾼다)

| 차트 | Terraform (`aws/platform`) |
|---|---|
| ESO 컨트롤러 `external-secrets/external-secrets` | `aws_eks_pod_identity_association.eso` |
| `secrets.app` = `platform/app`, `secrets.cloudflared` = `platform/cloudflared` | `aws_secretsmanager_secret.platform` |
| cloudflared `nodeSelector pool: general` | `aws_eks_node_group.this` 라벨 `pool` |
| 서비스 계정 `platform/worker`, `platform/api` | `aws_eks_pod_identity_association.worker`·`.api` (`pod-identity.tf`) |
| `sandbox.pool` = `sandbox` (파드 nodeSelector `pool`, taint `dedicated=sandbox:NoSchedule`) | `aws_eks_node_group.this["sandbox"]` 라벨 `pool`, taint `dedicated` |
| `sandbox.imageRegistry` = `<계정>.dkr.ecr.<리전>.amazonaws.com/sandbox` | 플랫폼 ECR 샌드박스 자리. worker 환경변수 `SANDBOX_IMAGE_REGISTRY` 와 같은 값 |

## 순서 (apply 뒤, 사람이 한 번)

```
# 1. ESO 컨트롤러 (공식 차트. 릴리스 이름 external-secrets → 서비스 계정 이름이 external-secrets)
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace

# 2. 비밀값 넣기 (값은 채팅·레포에 남기지 않는다)
aws secretsmanager put-secret-value --secret-id platform/app --secret-string file://<레포 밖 app.json>
aws secretsmanager put-secret-value --secret-id platform/cloudflared --secret-string file://<레포 밖 cf.json>

# 3. 이 차트 (sandbox.imageRegistry 는 sandbox.enabled 면 꼭 넣는다. 없거나 모양이 틀리면 렌더가 멈춘다)
helm upgrade --install platform deploy/helm/platform -n platform --create-namespace \
  --set sandbox.imageRegistry=<계정>.dkr.ecr.<리전>.amazonaws.com/sandbox
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
| `sbx-runtimeclass-guard` | pods CREATE, `platform.svc/sandbox-purpose=remediation` | `runtimeClassName` 이 `sandbox.gvisor.runtimeClass` 가 아님. vCluster 제어판(`app=vcluster` 이면서 `vcluster.loft.sh/managed-by` 없음)만 뺀다 |
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

## 검증 (클라우드 없이)

```
helm lint deploy/helm/platform
helm template platform deploy/helm/platform -n platform
```
기대: lint 0 failed, SecretStore 1·ExternalSecret 4·Deployment 1(cloudflared)·ServiceAccount 3·Role 1·RoleBinding 1, 그리고 샌드박스 켬(기본)이면 ClusterRole 2·ClusterRoleBinding 1·ValidatingAdmissionPolicy 6·ValidatingAdmissionPolicyBinding 6·StorageClass 1. `sandbox.gvisor.enabled=true` 면 RuntimeClass 1 이 더 생긴다. 샌드박스 켬이면 두 명령 모두 `--set sandbox.imageRegistry=000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox` 같은 값이 있어야 한다.

세 벌 렌더 + kubeconform + 개수 확인 + `sandbox.imageRegistry` 없음·틀린 모양 거부는 `bash deploy/ci/check-platform.sh` 한 번이다 (CI `gitops` 작업).

로컬 kind 끝-끝 검사(호스트 가드를 kind 에 올리고 agent-worker 로 vCluster 를 만들고 지우며 허용·거부를 본다)는 `deploy/ci/sandbox-kind-e2e.sh` 다. 사용법은 파일 머리에 있다. CI 에서는 돌리지 않는다.
