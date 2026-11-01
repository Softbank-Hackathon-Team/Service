# Z64: PgBouncer 제어 옆차 (워커 훅과 같은 /pause /resume 계약). 빌드 문맥 = packages/dbproxy
FROM node:22-alpine
WORKDIR /ctl
RUN npm init -y >/dev/null && npm i --no-audit --no-fund pg@8.23.1
COPY src/pgbouncer-control.ts ./pgbouncer-control.ts
ENV NODE_NO_WARNINGS=1
USER node
CMD ["node", "pgbouncer-control.ts"]
