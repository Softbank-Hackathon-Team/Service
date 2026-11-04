#!/bin/sh
# mask.sh 시험: 가짜 값 20종 이상이 0개 남고, 일반 숫자·해시·시각은 그대로, 두 번 지나도 같은 결과
# 실행: sh tools/real/mask-test.sh   (종료 코드 0 = 통과). 값은 전부 문서용 가짜(AWS 문서 예시 번호 등)
HERE="$(cd "$(dirname "$0")" && pwd)"
M="sh $HERE/mask.sh"
fail=0; n=0
leak() { # 이름 가짜값(여러 줄이면 첫 줄만 검사용) 입력
  n=$((n+1)); out=$(printf '%s\n' "$3" | $M)
  case "$out" in *"$2"*) echo "FAIL(남음) $1: $out"; fail=$((fail+1));; esac
}
keep() { # 이름 입력 — 출력이 입력과 같아야 함
  n=$((n+1)); out=$(printf '%s\n' "$2" | $M)
  [ "$out" = "$2" ] || { echo "FAIL(바뀜) $1: [$2] → [$out]"; fail=$((fail+1)); }
}
ACC=123456789012
leak "계정ID 단독"        "$ACC"              "account $ACC ok"
leak "계정ID 따옴표"      "$ACC"              "\"Account\": \"$ACC\""
leak "arn iam"            "$ACC"              "arn:aws:iam::$ACC:role/app-x"
leak "arn s3 아닌 sqs"    "$ACC"              "arn:aws:sqs:ap-northeast-2:$ACC:app-q"
leak "ecr 주소"           "$ACC"              "$ACC.dkr.ecr.ap-northeast-2.amazonaws.com/shop"
leak "gcp 프로젝트 번호"  "987654321098"      "projects/987654321098/locations/x"
leak "gcp sa 이메일"      "987654321098-compute" "987654321098-compute@developer.gserviceaccount.com"
leak "접두어-계정"        "$ACC"              "role-$ACC-x"
leak "대시 계정"          "1234-5678-9012"    "acct 1234-5678-9012"
leak "AKIA"               "AKIAIOSFODNN7EXAMPLE" "key AKIAIOSFODNN7EXAMPLE"
leak "ASIA"               "ASIAIOSFODNN7EXAMPLE" "key=ASIAIOSFODNN7EXAMPLE"
leak "secret 40자"        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" "aws secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end"
leak "secret= 환경변수"   "hunter2passw0rd"   "AWS_SECRET_ACCESS_KEY=hunter2passw0rd"
leak "json password"      "hunter2passw0rd"   "{\"password\": \"hunter2passw0rd\", \"port\": 5432}"
leak "session token"      "FwoGZXIvYXdz"      "aws_session_token = FwoGZXIvYXdzEXAMPLEtoken"
leak "이메일"             "dev.user+x@example.com" "mail dev.user+x@example.com sent"
leak "jwt"                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl" "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl"
leak "bearer"             "abcDEF123456xyz"   "Authorization: Bearer abcDEF123456xyz"
leak "gcp oauth"          "ya29.a0AfH6SMBexample1234567890" "x ya29.a0AfH6SMBexample1234567890"
leak "github"             "gh""p_abcdefghijklmnopqrstuvwxyz0123456789" "t gh""p_abcdefghijklmnopqrstuvwxyz0123456789"
leak "kubeconfig ca"      "LS0tLS1CRUdJTkNFUlRJRklDQVRF" "    certificate-authority-data: LS0tLS1CRUdJTkNFUlRJRklDQVRFLS0tLS0K"
leak "kubeconfig key"     "LS0tLS1CRUdJTktFWQ" "    client-key-data: LS0tLS1CRUdJTktFWQ=="
leak "kubeconfig token"   "k8s-aws-v1.aHR0cHM6Ly9zdHM" "    token: k8s-aws-v1.aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbQ"
leak "PEM 여러 줄"        "MIIBVgIBADANBgkqhkiG9w0" "$(printf -- '-----BEGIN PRIVATE'' KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\nAQEAxyz==\n-----END PRIVATE KEY-----')"
leak "api key 소문자 키"  "SuperSecretValue99" "db_password: SuperSecretValue99"
leak "long mixed base64"  "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUo" "blob Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUo"
# 그대로 두는 것
keep "포트"               "listening on 0.0.0.0:8080 db 5432 redis 6379"
keep "시각 ISO"           "2026-11-02T20:25:10Z started"
keep "epoch 10자리"       "ts=1762115110 elapsed 8254 ms"
keep "epoch ms 13자리"    "ts_ms=1762115110123"
keep "sha256 16진수"      "sha256:$(printf 'ab%.0s' $(seq 1 32))"
keep "sha1 40자 16진수"   "commit 8431587179b23e37b99b78d3f2f98238593bc7db"
keep "uuid"               "id 21178880-734b-4bbd-b39a-47c724e0bf78"
keep "uuid 끝 칸이 전부 숫자"  "tenant 11111111-1111-4111-8111-111111111111 env 22222222-2222-4222-8222-222222222222"
keep "IP·CIDR"            "ip 10.0.0.12 cidr 203.0.113.0/24"
keep "버전"               "kubernetes v1.31.2 terraform 1.12.2 pg 16.4"
keep "긴 소문자 경로"     "path /home/user/service/packages/adapters/test/some-very-long-file-name-here.test.ts"
keep "자원 이름"          "app-shopassets-1cf8b1 arn:aws:s3:::app-shopassets-1cf8b1"
keep "11자리·13자리 숫자" "n=12345678901 m=1234567890123"
# 멱등·빈 입력
n=$((n+1)); in="a $ACC AKIAIOSFODNN7EXAMPLE x@y.com"; o1=$(printf '%s\n' "$in" | $M); o2=$(printf '%s\n' "$o1" | $M)
[ "$o1" = "$o2" ] || { echo "FAIL(멱등) [$o1] → [$o2]"; fail=$((fail+1)); }
n=$((n+1)); [ -z "$(printf '' | $M)" ] || { echo "FAIL(빈 입력)"; fail=$((fail+1)); }
echo "mask-test: $n 건 중 실패 $fail"
[ "$fail" = 0 ]
