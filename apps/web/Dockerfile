# syntax=docker/dockerfile:1.7
# @svc/web 운영 이미지 = Vite 로 만든 정적 파일 + nginx(비루트, 8080). 빌드 문맥 = Service 루트
#   docker build -f apps/web/Dockerfile -t svc-web:dev .
# 실행 때 바꿀 값: API_UPSTREAM(기본 http://api:3000), API_PREFIX(기본 /api/v1)
ARG NODE_IMAGE=node:22.23.4-alpine3.24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31.7-alpine3.24

FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
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

FROM deps AS build
COPY apps/web ./apps/web
RUN npm run build -w @svc/web

FROM ${NGINX_IMAGE} AS runtime
ENV API_UPSTREAM=http://api:3000 \
    API_PREFIX=/api/v1
COPY deploy/docker/web-nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/web/dist/ /usr/share/nginx/html/
# 이 이미지는 이미 nginx 사용자(uid 101)로 돈다. 명시해 둔다
USER 101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-qO-", "http://127.0.0.1:8080/nginx-health"]
