# apps/agent-worker/vendor: 이미지에 넣는 vCluster 차트와 CRD

상태: AI 초안

agent-worker 이미지(`deploy/docker/Dockerfile` 의 `agent-worker` 단계)가 이 폴더를 `/app/vendor` 로 복사하고 `SHA256SUMS` 를 확인한다. 하나라도 다르면 빌드가 멈춘다.

| 파일 | 출처 | 쓰는 곳 |
|---|---|---|
| `vcluster-0.37.6.tgz` | `https://charts.loft.sh/charts/vcluster-0.37.6.tgz` (차트 저장소 index 의 digest 와 같은 값) | `SANDBOX_VCLUSTER_CHART` 기본값. 리허설·수정 고리가 실행마다 helm 으로 올린다 |
| `crds/externalsecrets.external-secrets.io-v2.14.0.yaml` | External Secrets v2.14.0 `config/crds/bases` | 리허설이 원본 `ExternalSecret` 을 가상 클러스터에서 스키마로 dry-run 한다 |
| `crds/clusters.postgresql.cnpg.io-1.30.1.yaml` | CloudNativePG v1.30.1 릴리스 매니페스트에서 `clusters` CRD 한 문서 | 원본 CNPG `Cluster` dry-run (온프레 도착) |
| `crds/sealedsecrets.bitnami.com-v0.40.0.yaml` | sealed-secrets v0.40.0 릴리스 `controller.yaml` 에서 `sealedsecrets.bitnami.com` CRD 한 문서 (원본 sha256 은 파일 머리 주석) | 원본 `SealedSecret` dry-run (온프레 DB 이전: 역할 비밀번호·터널 키·CNPG 서버 인증서). 적용은 워커가 같은 이름의 가짜 Secret 으로 바꾼다 |

CRD 파일은 차트 묶음 옆 `crds/` 에서 읽는다 (`packages/agent/src/ai/select.ts` `loadVendorCrds`). 버전을 바꾸면 파일을 바꾸고 `shasum -a 256 vcluster-0.37.6.tgz crds/*.yaml > SHA256SUMS` 를 다시 만든다.

TODO(human): 도착 클러스터의 ESO·CNPG 버전과 맞출지. 지금 레포는 ESO 를 버전 없이 설치한다 (`infra/onprem/bootstrap.sh`).
