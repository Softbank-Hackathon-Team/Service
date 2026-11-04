#!/usr/bin/env python3
# APP-20: 고객 쪽 도구 — 출발 k8s Secret 값을 도착 비밀 저장소(GCP Secret Manager / AWS Secrets Manager)에 새 버전으로 넣는다.
#   상태: AI 초안. ADR-072 유지: 플랫폼(api·워커)은 값을 복사하지 않는다. 이 도구는 고객(=데모에선 팀)이 자기 자격으로 손 대신 친다.
#   값은 화면·파일·명령줄 어디에도 안 나온다: kubectl 출력 → 이 프로세스 메모리 → gcloud/aws 의 stdin 으로만 (임시 파일 0, ps 에 안 보임).
#   찍는 것은 비밀 이름·키 이름·개수·결과(올림|같음|실패)뿐.
# 도착 이름 규칙은 Builder 와 같다 (packages/adapters/src/target/{gcp,aws}.ts remoteKey):
#   gcp  app-<앱>-<비밀 이름 소문자, [^a-z0-9-] → ->      aws  platform/<회사>/<앱>/<비밀 이름>
#   원격 값 = {키: 값} JSON 한 덩어리 (차트 externalsecret.yaml 이 키마다 property 로 읽음)
# 비밀 저장소 항목(빈 껍데기)은 도착 terraform 이 만든다 → 없으면 만들지 않고 실패로 알림 (apply 뒤에 칠 것)
# 사용:
#   python3 tools/secret-copy.py --to gcp --app shop --project <도착 프로젝트> --context <출발 kube 컨텍스트> --namespace <ns> [--secrets a,b] [--dry]
#   python3 tools/secret-copy.py --to aws --app shop --tenant <회사 번호> --region ap-northeast-2 --context … --namespace …
# 비밀 목록: --secrets 가 없으면 네임스페이스의 Opaque 비밀 전부 (서비스 계정 토큰·helm 기록·도커 로그인은 뺀다)
# 종료: 0 전부 올림·같음  1 하나라도 실패  2 인자 잘못
import argparse, base64, json, re, subprocess, sys

def sh(cmd, data=None):
    """명령 실행. 값이 든 stdout 은 돌려주기만 하고 절대 찍지 않는다. stderr 도 값이 섞일 수 있어 첫 줄 앞 120자만 (가림)"""
    p = subprocess.run(cmd, input=data, capture_output=True)
    return p.returncode, p.stdout, p.stderr

def short_err(b):
    s = b.decode("utf-8", "replace").strip().splitlines()
    s = s[-1] if s else ""
    return re.sub(r"\d{12}", "<계정>", s)[:120]

def remote_key(to, app, tenant, name):
    if to == "gcp": return f"app-{app}-{re.sub(r'[^a-z0-9-]', '-', name.lower())}"
    return f"platform/{tenant}/{app}/{name}"

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--to", choices=["gcp", "aws"], required=True)
    a.add_argument("--app", required=True)
    a.add_argument("--context", required=True)
    a.add_argument("--namespace", required=True)
    a.add_argument("--project"); a.add_argument("--tenant"); a.add_argument("--region")
    a.add_argument("--secrets", default="")
    a.add_argument("--dry", action="store_true")
    o = a.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", o.app): print("--app 모양이 아님 (소문자·숫자·-)", file=sys.stderr); return 2
    if o.to == "gcp" and not o.project: print("--to gcp 는 --project 필요", file=sys.stderr); return 2
    if o.to == "aws" and not (o.tenant and o.region): print("--to aws 는 --tenant·--region 필요", file=sys.stderr); return 2
    k = ["kubectl", "--context", o.context, "-n", o.namespace]
    names = [s.strip() for s in o.secrets.split(",") if s.strip()]
    if not names:
        rc, out, err = sh(k + ["get", "secrets", "-o", "json"])
        if rc: print(f"출발 비밀 목록을 못 읽음: {short_err(err)}", file=sys.stderr); return 1
        names = sorted(i["metadata"]["name"] for i in json.loads(out).get("items", []) if i.get("type", "Opaque") == "Opaque")
    if not names: print("올릴 비밀 없음 (Opaque 0개)"); return 0
    fails = 0
    for n in names:
        rk = remote_key(o.to, o.app, o.tenant, n)
        rc, out, err = sh(k + ["get", "secret", n, "-o", "json"])
        if rc: print(f"실패  {n} → {rk}: 출발 비밀을 못 읽음 ({short_err(err)})"); fails += 1; continue
        data = json.loads(out).get("data") or {}
        payload, bad = {}, []
        for key, b64 in sorted(data.items()):
            try: payload[key] = base64.b64decode(b64).decode("utf-8")
            except (ValueError, UnicodeDecodeError): bad.append(key)
        del out, data
        if bad: print(f"실패  {n} → {rk}: 글자가 아닌(바이너리) 키 {','.join(bad)} — 차트는 글자 값만 받음, 사람이 확인"); fails += 1; continue
        if not payload: print(f"실패  {n} → {rk}: 키 0개"); fails += 1; continue
        if o.to == "gcp":
            exists = ["gcloud", "secrets", "describe", rk, "--project", o.project, "--format=value(name)"]
            cur = ["gcloud", "secrets", "versions", "access", "latest", "--secret", rk, "--project", o.project]
            put = ["gcloud", "secrets", "versions", "add", rk, "--project", o.project, "--data-file=-"]
        else:
            exists = ["aws", "secretsmanager", "describe-secret", "--secret-id", rk, "--region", o.region, "--query", "Name", "--output", "text"]
            cur = ["aws", "secretsmanager", "get-secret-value", "--secret-id", rk, "--region", o.region, "--query", "SecretString", "--output", "text"]
            put = ["aws", "secretsmanager", "put-secret-value", "--secret-id", rk, "--region", o.region, "--secret-string", "file:///dev/stdin"]
        rc, _, err = sh(exists)
        if rc: print(f"실패  {n} → {rk}: 도착 비밀 저장소 항목이 없음 (도착 terraform apply 뒤에 다시. 이 도구는 항목을 만들지 않음)"); fails += 1; continue
        rc, curv, _ = sh(cur)
        same = False
        if rc == 0:
            try: same = json.loads(curv.decode("utf-8")) == payload
            except (ValueError, UnicodeDecodeError): same = False
        del curv
        if same: print(f"같음  {n} → {rk} (키 {len(payload)}개)"); continue
        if o.dry: print(f"dry-run: 올릴 것  {n} → {rk} (키 {len(payload)}개: {','.join(sorted(payload))})"); continue
        rc, _, err = sh(put, json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        if rc: print(f"실패  {n} → {rk}: 새 버전 못 넣음 ({short_err(err)})"); fails += 1; continue
        print(f"올림  {n} → {rk} (키 {len(payload)}개: {','.join(sorted(payload))})")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
