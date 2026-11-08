# DRAFT(ai): 출발 샘플 기본 web 이미지(nginx:1.27-alpine)와 같은 기반. 화면 한 장 + API 넘기기 설정만 더한다
FROM nginx:1.27-alpine
COPY 05-wait-api.sh /docker-entrypoint.d/05-wait-api.sh
RUN chmod 755 /docker-entrypoint.d/05-wait-api.sh
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
# 로컬 실행 때 값이 없으면 nginx 가 못 뜨므로 기본값. 클러스터에서는 템플릿의 API_URL 이 덮는다
ENV API_URL=http://shop-api
