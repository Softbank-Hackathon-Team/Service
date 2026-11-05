# syntax=docker/dockerfile:1.7
# 서버 앱 3개(api · worker · agent-worker) 운영 이미지와 온프레 Agent 이미지를 한 파일로 만든다 (Z75-17, W1). 빌드 문맥 = Service 루트
#   docker build -f deploy/docker/Dockerfile --target api          -t svc-api:dev .
#   docker build -f deploy/docker/Dockerfile --target worker       -t svc-worker:dev .
#   docker build -f deploy/docker/Dockerfile --target agent-worker -t svc-agent-worker:dev .
#   docker build -f deploy/docker/Dockerfile --target onprem-agent -t svc-onprem-agent:dev .   (고객 온프레 클러스터에서 도는 Agent)
# 단계: manifests(package.json만) → deps(npm ci, 셋이 같이 씀) → src → build-<앱>(esbuild 묶음) → <앱>(묶음 파일만)
# 이미지는 여전히 3개다. 앱마다 필요한 것만 담는다(api: 권한 파일·차트, worker: git·권한 파일, agent-worker: 묶음만)
# 예전엔 apps/<앱>/Dockerfile 3개에 같은 앞 단계 35줄이 세 번 있었다. 앞 단계를 고치면 세 곳을 같이 고쳐야 했다
# DRAFT(ai): 런타임에 node_modules 없음. 외부 패키지까지 main.mjs 하나에 묶는다(deploy/docker/bundle.mjs)
ARG NODE_IMAGE=node:22.23.4-alpine3.24
# worker 의 git. 바탕(alpine 3.24)과 같은 alpine 판으로 만든 공식 git 이미지에서 꺼내 온다 (apk 저장소에 안 닿아도 빌드된다)
ARG GIT_IMAGE=alpine/git:v2.54.0
# worker 의 crane (리허설 이미지 복사, apps/worker/src/rehearsal/image-mirror.ts). 공식 이미지의 정적 바이너리 하나만 꺼내 온다
#   판 v0.22.1, 다이제스트 = 여러 아키텍처 index (amd64·arm64 둘 다 같은 고정값으로 받는다)
ARG CRANE_IMAGE=gcr.io/go-containerregistry/crane:v0.22.1@sha256:1f968817b95790bed063f71175aa6b8ff879fa17064020415f3e18bb6e6a36e1
# W1: 온프레 Agent 의 kubectl. 공식 이미지(registry.k8s.io/kubectl)의 정적 바이너리 /bin/kubectl 하나만 꺼내 온다
#   판 v1.36.5 = 시연 온프레 k3s(v1.36.5+k3s1)와 같은 판. kubectl 은 서버와 위아래 1 minor 까지 지원한다
#   다이제스트 = 여러 아키텍처 index (amd64·arm64 둘 다 같은 고정값으로 받는다)
# DRAFT(ai): 고객 k3s 판이 1.35 미만·1.37 초과면 이 판을 같이 올려야 한다
#   agent-worker 의 KUBECTL_IMAGE(플랫폼 EKS 판)와 따로 둔다. 고객 클러스터 판에 맞추기 때문이다
ARG ONPREM_KUBECTL_IMAGE=registry.k8s.io/kubectl:v1.36.5@sha256:0667e3f3e6ef435d7cd4c16684244703ebd67314c17511c2a9f87ea44f6cdf6b
# agent-worker 의 helm (vCluster 차트를 sbx-* 네임스페이스에 올린다). git 과 같은 방식으로 이미지에서 꺼낸다. 다이제스트 고정
ARG HELM_IMAGE=alpine/helm:3.22.1@sha256:8191701ad1f82ee3695c87211fcbfe6d7b1bb7df92ac1c8de9ccdb0995a6a2c1
# agent-worker 의 kubectl (플랫폼 클러스터 밖에서 돌 때 가상 API 로 port-forward). helm 과 같은 방식, 다이제스트 고정. 플랫폼 EKS 1.35 와 같은 마이너
ARG KUBECTL_IMAGE=registry.k8s.io/kubectl:v1.35.10@sha256:4e1d541a3d62f74637974e4c71f3cea91b9a36ffd059ab45e355648898783837
# worker 의 gcloud (GCP 출발 가져오기: projects describe·container clusters list·get-credentials). 진짜 플랫폼 worker 에 클라우드 CLI 가 없어
#   출발이 무엇이든 가져오기가 IMPORT_SOURCE_UNAVAILABLE 로 멈췄다 (2026-11-05 실측). 공식 alpine 판은 musl 용 python 을 SDK 안에 담고 있어 바탕에 python 을 따로 안 넣는다
#   판 592.0.0, 다이제스트 = 여러 아키텍처 index (amd64·arm64)
ARG GCLOUD_IMAGE=gcr.io/google.com/cloudsdktool/google-cloud-cli:592.0.0-alpine@sha256:9040d28a6512f32c495322a3af6ea000f803a0ae001cec055937154efe5a2230
# worker 의 aws CLI (AWS 출발 가져오기·STS). 공식 설치본은 glibc 전용이라 musl 바탕에서 못 돈다 → alpine community 패키지
# DRAFT(ai): 2.34 계열로 고정. alpine 저장소는 같은 가지의 최신 판만 남겨서 정확한 판(-rN)으로 묶으면 나중에 빌드가 깨진다
ARG AWS_CLI_APK=aws-cli~2.34

FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
# 워크스페이스 package.json 만 남긴다 → 소스가 바뀌어도 npm ci 층은 캐시에서 재사용
# hadolint ignore=SC2016
RUN mkdir -p /out && cp package.json package-lock.json /out/ \
 && find . -name package.json -not -path "*/node_modules/*" -not -path "./package.json" \
      -exec sh -c 'for f; do mkdir -p "/out/${f%/*}" && cp "$f" "/out/$f"; done' _ {} +

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY --from=manifests /out/ ./
# 회사망처럼 TLS 를 가로채는 프록시 뒤라면 CA 를 비밀 마운트로 준다(없으면 건너뜀)
#   docker build --secret id=extra_ca,src=/경로/ca.crt ...
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm ci --no-audit --no-fund --ignore-scripts

# 묶음에 들어가는 원본. 앱별 build 단계는 자기 앱 폴더만 복사해서, 다른 앱 원본이 바뀌어도 이 앱 묶음은 캐시를 쓴다
FROM deps AS src
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY deploy/docker ./deploy/docker

FROM src AS build-api
COPY apps/api ./apps/api
# 문서 화면(/api/v1/docs/ui)용 명세. 이 층에서 코드로 만들고 bundle.mjs 가 dist/api/docs/ 로 복사한다 (Z51, Z75-02)
COPY tools/openapi ./tools/openapi
RUN npx tsx tools/openapi/gen-openapi.ts \
 && node deploy/docker/bundle.mjs api

FROM src AS build-worker
COPY apps/worker ./apps/worker
RUN node deploy/docker/bundle.mjs worker

FROM src AS build-agent-worker
COPY apps/agent-worker ./apps/agent-worker
RUN node deploy/docker/bundle.mjs agent-worker

# W1: 온프레 Agent 는 tools/onprem-agent.ts 하나가 진입점 (@svc/agent 의 kubectl 모으기 + 서명 보내기)
FROM src AS build-onprem-agent
COPY tools/onprem-agent.ts ./tools/onprem-agent.ts
RUN node deploy/docker/bundle.mjs onprem-agent

# git 과 git 이 쓰는 공유 라이브러리만 /out 에 모은다 (ldd 로 찾은 것 + 심볼릭 링크의 실제 파일)
FROM ${GIT_IMAGE} AS git
# SC2046: $(cat /tmp/libs) 는 파일 목록이라 일부러 쪼갠다 (따옴표로 묶으면 한 파일 이름이 된다)
# hadolint ignore=SC2016,SC2046,DL4006
RUN set -e; mkdir -p /out; \
    files="/usr/bin/git $(find /usr/libexec/git-core -type f)"; \
    libs=$(for f in $files; do ldd "$f" 2>/dev/null || true; done | awk '/=>/ {print $3}' | sort -u); \
    for l in $libs; do echo "$l"; readlink -f "$l"; done | sort -u > /tmp/libs; \
    tar -cf - /usr/bin/git /usr/libexec/git-core /usr/share/git-core $(cat /tmp/libs) 2>/dev/null | tar -xf - -C /out

FROM ${CRANE_IMAGE} AS crane
FROM ${HELM_IMAGE} AS helm
FROM ${KUBECTL_IMAGE} AS kubectl
FROM ${ONPREM_KUBECTL_IMAGE} AS onprem-kubectl
# GKE 클러스터 kubeconfig(get-credentials)는 gke-gcloud-auth-plugin 을 부른다. 기본 묶음에 없어 여기서 더한다.
#   bq·gsutil 은 가져오기가 안 쓴다 → 뺀다 (약 80MB). __pycache__ 는 남긴다 (worker 뿌리 파일 시스템이 읽기 전용이라 실행 때 못 만든다)
FROM ${GCLOUD_IMAGE} AS gcloud
RUN gcloud components install gke-gcloud-auth-plugin --quiet \
 && gcloud components remove bq gsutil --quiet \
 && rm -rf /google-cloud-sdk/.install/.backup \
 && gke-gcloud-auth-plugin --version

# 세 이미지 공통 바탕
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "main.mjs"]

FROM runtime AS api
ENV API_PORT=3000
# Z47: 컨테이너 안에서는 모든 주소에 붙어야 web·healthcheck 가 닿는다 (코드 기본값은 localhost)
ENV API_HOST=0.0.0.0
# Z66(3차): 보안 표가 읽는 최소 권한 파일·앱 차트. 묶음 파일 하나에는 안 들어가서 따로 복사.
#   없으면 apps/api/src/security/load.ts 가 못 읽어 "정적" 근거·LP-AWS-BOUNDARY 가 비고 prod e2e 2건 실패
COPY infra/permissions /app/infra/permissions
COPY gitops/charts /app/gitops/charts
ENV PERMISSIONS_DIR=/app/infra/permissions
ENV CHART_DIR=/app/gitops/charts/app
# 파일 주인은 root(읽기만 가능) → 앱이 자기 코드를 못 바꾼다
COPY --from=build-api /src/dist/api/ ./
# 이미지에 들어 있는 node 사용자(uid 1000). 루트로 돌지 않는다
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs", "http://127.0.0.1:3000/healthz"]

FROM runtime AS worker
# gitops 배포(N2)는 git 명령을 부른다. helm 은 gitops 레포 render 도구가 필요할 때만 (TODO(human): helm 바이너리 넣을지)
# Z75: apk add 대신 git 단계에서 복사(패키지 서버가 막힌 곳에서도 빌드됨). 바탕에 이미 있는 라이브러리(libz·libssl 등)는 덮어쓰지 않는다.
#      층에 임시 파일이 안 남게 bind 로 붙인다. WITH_GIT=0 은 git 없이 만드는 검증용(4차 apps/worker/Dockerfile 과 같은 뜻, 기본 1)
ARG WITH_GIT=1
# DL3003: /g 는 이 RUN 동안만 붙는 마운트라 WORKDIR 로 못 간다. DL4006: 마지막 줄은 grep 결과만 본다(! 로 뒤집음, pipefail 이면 ldd 실패에 뒤집혀 통과해 버린다)
# hadolint ignore=SC2044,DL3003,DL4006
RUN --mount=type=bind,from=git,source=/out,target=/g set -e; [ "$WITH_GIT" = "1" ] || exit 0; cd /g; \
    for f in $(find . -type f -o -type l); do \
      [ -e "/$f" ] || [ -L "/$f" ] || { mkdir -p "/${f%/*}"; cp -a "$f" "/$f"; }; \
    done; git --version; \
    # R7-3: https(push·clone)는 git-remote-https 가 libcurl 사슬을 따로 읽는다. 빠진 라이브러리가 있으면 빌드에서 멈춘다
    ! ldd /usr/libexec/git-core/git-remote-https 2>&1 | grep -q "not found"
# 리허설 이미지 복사 도구. 정적 Go 바이너리라 라이브러리가 필요 없다 (TLS 루트는 바탕의 /etc/ssl/certs)
COPY --from=crane /ko-app/crane /usr/local/bin/crane
# 가져오기(discover)·사전 점검·역할 빌리기가 부르는 클라우드 CLI (packages/adapters/src/discover/index.ts, precheck/cloud-precheck.ts)
#   kubectl = EKS·GKE 안의 Deployment·Service 읽기 (플랫폼 EKS 와 같은 판 단계를 같이 쓴다)
#   설정·캐시는 HOME(/tmp, 차트가 emptyDir 로 준다) 아래에 쓴다. 사용 통계·업데이트 확인은 끈다 (바깥으로 나가는 호출을 줄인다)
COPY --from=gcloud /google-cloud-sdk /opt/google-cloud-sdk
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
ENV PATH=/opt/google-cloud-sdk/bin:$PATH \
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true \
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true \
    AWS_CLI_AUTO_PROMPT=off
ARG AWS_CLI_APK
# openssl = 이전별 CNPG 서버 인증서 발급 (apps/worker/src/gitops/migration-secrets.ts issueServerCert). Node 에 X.509 만드는 API 가 없다
# hadolint ignore=DL3018
RUN apk add --no-cache "$AWS_CLI_APK" openssl \
 && aws --version && gcloud --version >/dev/null && kubectl version --client >/dev/null && gke-gcloud-auth-plugin --version >/dev/null \
 && openssl version
# 최소 권한 파일(J2): 묶음 파일 하나에는 안 들어가서 따로 복사. 없으면 실행 역할 발급이 전부 거부된다
COPY infra/permissions /app/infra/permissions
ENV PERMISSIONS_DIR=/app/infra/permissions
COPY --from=build-worker /src/dist/worker/ ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs", "db"]

FROM runtime AS agent-worker
# vCluster 리허설: helm·kubectl(정적 바이너리) + 차트 묶음·CRD (apps/agent-worker/vendor). 체크섬이 다르면 빌드가 멈춘다
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY apps/agent-worker/vendor /app/vendor
WORKDIR /app/vendor
RUN sha256sum -c SHA256SUMS && helm version --short && kubectl version --client
WORKDIR /app
COPY --from=build-agent-worker /src/dist/agent-worker/ ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs", "db"]

# W1: 고객 온프레 클러스터에서 도는 Agent. 클러스터를 읽고(kubectl) 서명한 보고를 플랫폼 API 로 보낸다 (밖으로 443 만)
#   클러스터 안에서는 kubectl 이 파드의 ServiceAccount 토큰으로 자동 인증한다 (kubeconfig 를 넣지 않는다)
#   필요한 환경변수: AGENT_REPORT_URL, AGENT_KEY_ID, AGENT_KEY_SECRET (키 두 개는 Secret 에서. 설치 차트 W2)
#   읽기 전용 루트 파일시스템으로 돌려도 된다: 쓰는 곳이 없다 (--enroll 은 --out 을 쓰기 가능한 마운트로 준다)
#   docker run --rm svc-onprem-agent:dev --help
FROM runtime AS onprem-agent
COPY --from=onprem-kubectl /bin/kubectl /usr/local/bin/kubectl
COPY --from=build-onprem-agent /src/dist/onprem-agent/ ./
USER node
ENTRYPOINT ["node", "--enable-source-maps", "main.mjs"]
# 30초마다 heartbeat, 10번에 1번 security (tools/onprem-agent.ts loop)
CMD ["loop", "--every", "30"]
