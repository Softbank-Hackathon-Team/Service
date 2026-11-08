FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json items.mjs server.mjs ./
USER node
EXPOSE 8080
# CMD 가 아니라 ENTRYPOINT: 출발 템플릿의 args(http-echo 용 -listen=:8080 -text=ok)가 뒤에 붙어도 앱이 그대로 뜬다
ENTRYPOINT ["node", "/app/server.mjs"]
