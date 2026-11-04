#!/usr/bin/env python3
# 사전 점검 ⑤ LITERAL (방법론 v1 L1): 스크립트에 박아 둔 "환경 사실" 리터럴을 지금 이 맥의 실제 사실과 맞춘다.
# 왜: F6(기본값 k3d-onprem ↔ 맥 k3s-onprem), F7(/shop_api ↔ terraform 이 만든 shop), F8(:role/ 만 받는 정규식 ↔ IAM 사용자)는
#   모두 "아무도 실제 값과 대조하지 않은 리터럴"이었다.
# 보는 리터럴 종류와 대응 사실 (사실은 up-preflight 가 읽기 전용 명령으로 모아 env 로 넘긴다. 값은 안 찍는다)
#   ctx     ${X:-k3s-…|k3d-…} 기본값           ↔ PREFLIGHT_KUBE_CONTEXTS (kubectl config get-contexts -o name)  없으면 FAIL
#   profile AWS_PROFILE 기본값                  ↔ PREFLIGHT_AWS_PROFILES (aws configure list-profiles)             없으면 FAIL
#   gcp     GCP_PROJECT 기본값                  ↔ PREFLIGHT_GCP_PROJECT (gcloud config get-value project)          다르면 WARN
#   uuid    ${X:-<uuid>} 기본값                 ↔ db/migrations 시드 SQL 에 있는 id                                 없으면 FAIL
#   arn     정규식·case 안의 :role/ (같은 줄에 user 없음) ↔ PREFLIGHT_ARN_KIND (sts 주체 종류)                    user 면 FAIL
#   dbname  postgres URL 끝의 고정 DB 이름(:5432/<이름>, platform 제외) ↔ terraform 이 앱 이름으로 만든다({tf:db_name})  FAIL
# --since <rev>: 그 판 뒤로 레포에 새로 들어온 줄 중 위 종류의 리터럴만 WARN 으로 보여 준다(탐지기 썩음 막기, 사람이 대응 사실을 정함)
# 쓰는 법: python3 -I tools/preflight-literals.py [--since <rev>] [더 볼 폴더 …]   끝 코드 0 = FAIL 없음
import glob, os, re, subprocess, sys

UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
RULES = [
    ("ctx", re.compile(r'\$\{[A-Z_]+:-(k3[sd]-[a-z0-9-]+)\}|"\$\{\d+:-(k3[sd]-[a-z0-9-]+)\}"')),
    ("profile", re.compile(r'AWS_PROFILE:?=?\$?\{?AWS_PROFILE:-([A-Za-z0-9_-]+)\}')),
    ("gcp", re.compile(r'GCP_PROJECT:-([a-z][a-z0-9-]{4,28}[a-z0-9])\}')),
    ("uuid", re.compile(r'\$\{[A-Z_]+:-(' + UUID + r')\}')),
    ("dbname", re.compile(r'postgres(?:ql)?://[^\s"\'`]*:5432/([A-Za-z_][A-Za-z0-9_]*)')),
]
# 받아들이는 검사(정규식·grep·AllowedPattern)만 본다. case 갈래(arn:…:role/*) …)는 나눠 처리하는 줄이라 뺀다 (다른 갈래가 user 를 받는다)
ARN_RE = re.compile(r'(=~|grep\b|RegExp|\.test\(|AllowedPattern|PATTERN|/\^arn|"\^arn|\'\^arn)[^\n]*:role')
# 플랫폼 주체가 아닌 칸은 역할만 받는 것이 맞다 (F8 은 플랫폼 주체 검사만 대상). 통합본 ID-1 의 ArgoHubRoleArn(Argo CD 허브 역할)이 그렇다
#   DRAFT(ai): 칸 이름이 다음 줄에 있어 줄 안의 표시 글("Argo 허브는 역할만")로 알아본다. 이런 칸이 더 생기면 여기에 더한다
ROLE_ONLY_OK = re.compile(r'ArgoHubRoleArn|Argo 허브는 역할만')


def files(extra):
    # 레포: 스크립트 + 주체 ARN 을 받는 두 곳(시작 설정 검사, 연결 템플릿 패턴)
    out = sorted(glob.glob("tools/*.sh") + glob.glob("tools/*.ts")) + ["packages/contracts/src/config.ts", "packages/adapters/scripts/aws-connect-template.ts"]
    for d in extra:
        out += sorted(glob.glob(os.path.join(d, "*.sh")) + glob.glob(os.path.join(d, "*/*.ts")) + glob.glob(os.path.join(d, "*.ts")))
    # preflight-selftest.sh 는 고치기 전 모양(역시험 조각)을 일부러 담고 있어 뺀다
    return [f for f in out if os.path.exists(f) and not f.endswith(".test.ts") and os.path.basename(f) != "preflight-selftest.sh"]


def seed_ids():
    ids = set()
    for f in glob.glob("db/migrations/*.sql"):
        ids |= set(re.findall(UUID, open(f).read()))
    return ids


def facts():
    e = os.environ
    return {
        # 빈 값 = 그 명령이 없거나 실패 → 대조 못 함(WARN). 없는 것을 "없음"으로 오판하지 않게
        "ctx": set(e.get("PREFLIGHT_KUBE_CONTEXTS", "").split()) or None,
        "profile": set(e.get("PREFLIGHT_AWS_PROFILES", "").split()) or None,
        "gcp": e.get("PREFLIGHT_GCP_PROJECT"),
        "arn": e.get("PREFLIGHT_ARN_KIND"),
        "uuid": seed_ids(),
    }


def scan_line(kind_hits, path, n, line):
    code = line.split(" # ")[0] if path.endswith(".sh") else line
    if re.match(r'^\s*(#|//)', code):
        return
    for kind, rx in RULES:
        for m in rx.finditer(code):
            val = next(g for g in m.groups() if g)
            if kind == "dbname" and val in ("platform", "postgres"):
                continue
            # ${VAR:-리터럴} 인데 VAR 가 지금 env 에 있으면 리터럴은 안 쓰인다 (up-preflight 가 demo-day 와 같은 값을 넘김)
            vm = re.search(r'\$\{([A-Z_][A-Z0-9_]*):-', m.group(0))
            if vm and os.environ.get(vm.group(1), "").strip() and kind != "uuid":
                continue
            kind_hits.append((kind, val, path, n))
    if ":role" in code and "user" not in code and ARN_RE.search(code) and not ROLE_ONLY_OK.search(code):
        kind_hits.append(("arn", "role-only", path, n))


def judge(hits, f):
    rows = []
    for kind, val, path, n in hits:
        where = f"{path}:{n}"
        if kind == "ctx":
            if f["ctx"] is None: rows.append(("WARN", kind, f"{where} 기본 컨텍스트 {val} — kube 컨텍스트 목록을 못 받아 대조 못 함"))
            elif val not in f["ctx"]: rows.append(("FAIL", kind, f"{where} 기본 컨텍스트 {val} 가 kubeconfig 에 없음 (F6) → 인자·env 로 주거나 기본값을 실제 이름으로"))
        elif kind == "profile":
            if f["profile"] is None: rows.append(("WARN", kind, f"{where} 기본 AWS 프로필 {val} — 프로필 목록을 못 받아 대조 못 함"))
            elif val not in f["profile"]: rows.append(("FAIL", kind, f"{where} 기본 AWS 프로필 {val} 가 aws configure list-profiles 에 없음"))
        elif kind == "gcp":
            if f["gcp"] and val != f["gcp"]: rows.append(("WARN", kind, f"{where} 기본 GCP 프로젝트 {val} ≠ gcloud 기본 프로젝트 (GCP_PROJECT 를 주는지 확인)"))
        elif kind == "uuid":
            if val not in f["uuid"]: rows.append(("FAIL", kind, f"{where} 기본 환경·회사 id {val[:8]}… 가 시드 SQL 에 없음 → 그 id 를 가진 줄이 DB 에 없음"))
        elif kind == "arn":
            if f["arn"] == "user": rows.append(("FAIL", kind, f"{where} ARN 검사가 :role/ 만 받음 — 지금 자격은 IAM 사용자 (F8)"))
            elif f["arn"] is None: rows.append(("WARN", kind, f"{where} ARN 검사가 :role/ 만 받음 — 주체 종류를 못 받아 대조 못 함"))
        elif kind == "dbname":
            rows.append(("FAIL", kind, f"{where} 접속 주소에 DB 이름 {val} 고정 (F7) → terraform 출력 {{tf:db_name}} 으로"))
    return rows


def since_rows(rev):
    try:
        diff = subprocess.run(["git", "diff", "-U0", rev, "--", "tools", "packages/contracts/src/config.ts", "packages/adapters/scripts"], capture_output=True, text=True, timeout=30).stdout
    except Exception as e:
        return [("WARN", "since", f"git diff {rev} 실패 ({type(e).__name__})")]
    rows, path, n = [], "?", 0
    for line in diff.split("\n"):
        if line.startswith("+++ b/"): path = line[6:]; continue
        m = re.match(r'^@@ -\d+(?:,\d+)? \+(\d+)', line)
        if m: n = int(m.group(1)); continue
        if line.startswith("+") and not line.startswith("+++"):
            hits = []
            scan_line(hits, path, n, line[1:])
            for kind, val, p, ln in hits:
                rows.append(("WARN", f"new-{kind}", f"{p}:{ln} {rev[:8]} 뒤 새 리터럴 {val if kind != 'uuid' else val[:8] + '…'} — 대응 사실이 위 표에 있는지 확인"))
            n += 1
    return rows


def main(argv):
    since, extra, it = None, [], iter(argv)
    for a in it:
        if a == "--since": since = next(it)
        else: extra.append(a)
    hits = []
    for p in files(extra):
        for n, line in enumerate(open(p, errors="replace").read().split("\n"), 1):
            scan_line(hits, p, n, line)
    f = facts()
    rows = judge(hits, f) + (since_rows(since) if since else [])
    # 기본값이 env 로 덮였으면 덮은 값(실제로 쓰일 값)을 대조한다
    ap = os.environ.get("AWS_PROFILE", "").strip()
    if ap and f["profile"] is not None and ap not in f["profile"]:
        rows.append(("FAIL", "profile", f"지금 AWS_PROFILE={ap} 가 aws configure list-profiles 에 없음"))
    for lvl, kind, msg in rows:
        print(f"{lvl:<4} literal:{kind} {msg}")
    nf = sum(1 for r in rows if r[0] == "FAIL")
    if nf == 0:
        print(f"OK   literal 환경 사실 리터럴 {len(hits)}개 대조 (ctx·profile·gcp·uuid·arn·dbname){' · ' + since + ' 뒤 새 것은 WARN' if since else ''}")
    return 1 if nf else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
