# Z64: 데모·로컬용 PgBouncer 이미지. 우분투 24.04 패키지 = PgBouncer 1.22.0 (Z64 가 실제로 시험한 판과 같다)
FROM ubuntu:24.04
# uid 1000 (= 우분투 이미지의 ubuntu 계정 = node:22-alpine 의 node 계정). 제어 옆차와 대상 줄 파일(공유 볼륨)을 같이 쓴다
RUN apt-get update && apt-get install -y --no-install-recommends pgbouncer && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/pgbouncer/dyn && chown -R 1000 /etc/pgbouncer
COPY pgbouncer.compose.ini /etc/pgbouncer/pgbouncer.ini
COPY entrypoint.sh /entrypoint.sh
USER 1000
EXPOSE 6432
ENTRYPOINT ["sh", "/entrypoint.sh"]
