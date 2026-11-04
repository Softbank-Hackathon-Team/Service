# M-import 샘플 3티어 (상태: AI 초안). m-import.sh 가 __NS__·__WEB_IMAGE__·__API_IMAGE__·__PG_IMAGE__ 를 채워 k3d 에 올린다.
# 비밀값은 이 파일에 없다: api-secrets 는 스크립트가 실행 때 랜덤으로 만든다 (kubectl create secret). DB 비밀은 CNPG 가 직접 만든다(<cluster>-app)
# 이미지는 digest 로 고정한다 (가져오기 매퍼가 digest 를 요구 → 스크립트가 맥에서 태그 → digest 로 바꿔 넣음)
apiVersion: v1
kind: Namespace
metadata:
  name: __NS__
  labels: { m-import: "1" }
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: shop-db
  namespace: __NS__
spec:
  instances: 1
  imageName: __PG_IMAGE__
  storage:
    size: 1Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
  namespace: __NS__
data:
  LOG_LEVEL: m-import-cfg-value-7
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: shop-api
  namespace: __NS__
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-api
  namespace: __NS__
  labels: { app: shop-api }
spec:
  replicas: 1
  selector:
    matchLabels: { app: shop-api }
  template:
    metadata:
      labels: { app: shop-api }
    spec:
      serviceAccountName: shop-api
      containers:
        - name: api
          image: __API_IMAGE__
          args: ["-listen=:8080", "-text=ok"]
          ports:
            - { name: http, containerPort: 8080 }
          resources:
            requests: { cpu: 100m, memory: 64Mi }
          readinessProbe:
            httpGet: { path: /, port: 8080 }
          env:
            - name: DB_HOST
              value: shop-db-rw.__NS__.svc
            - name: DB_PORT
              value: "5432"
            - name: LOG_LEVEL
              valueFrom:
                configMapKeyRef: { name: api-config, key: LOG_LEVEL }
            - name: API_TOKEN
              valueFrom:
                secretKeyRef: { name: api-secrets, key: API_TOKEN }
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef: { name: shop-db-app, key: password }
---
apiVersion: v1
kind: Service
metadata:
  name: shop-api
  namespace: __NS__
spec:
  selector: { app: shop-api }
  ports:
    - { name: http, port: 80, targetPort: 8080 }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-web
  namespace: __NS__
  labels: { app: shop-web }
spec:
  replicas: 1
  selector:
    matchLabels: { app: shop-web }
  template:
    metadata:
      labels: { app: shop-web }
    spec:
      containers:
        - name: web
          image: __WEB_IMAGE__
          ports:
            - { name: http, containerPort: 80 }
          resources:
            requests: { cpu: 50m, memory: 32Mi }
          readinessProbe:
            httpGet: { path: /, port: 80 }
          env:
            - name: API_URL
              value: http://shop-api.__NS__.svc
---
apiVersion: v1
kind: Service
metadata:
  name: shop-web
  namespace: __NS__
spec:
  selector: { app: shop-web }
  ports:
    - { name: http, port: 80, targetPort: 80 }
