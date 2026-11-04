#!/usr/bin/env python3
# 사전 점검 ③ TFREQ: 스크립트가 terraform apply·destroy·plan 을 부르는 줄마다, 그 모듈의 "기본값 없는 변수"를 그 줄이 다 넘기는지.
# 왜: 1차 up 이 aws/env 필수 변수 expected_account_id 를 안 넘겨 GKE 만 만들고 멈췄다(F1). 예전 점검(check_vars)은 "넘기는 변수"를
#   사람이 손으로 적어 두는 방식이라, 스크립트 줄이 바뀌거나 새 줄이 생기면 못 잡는다. 여기서는 넘기는 값을 스크립트 줄에서 직접 읽는다.
# 넘기는 값으로 치는 것: 같은 줄(\ 이어진 줄 포함)의 -var "k=…"·-var k=…·-var 'k=…', TF_VAR_k=…, 같은 줄의 aws_account_var(=TF_VAR_expected_account_id)
#   일어나지 않는 것: 클라우드·terraform 호출 없음 (파일만 읽음). 끝 코드 0 = FAIL 없음
# 쓰는 법: python3 -I tools/preflight-tfvars.py [--plan <모듈>=<plan.json> …] [스크립트 …]   (기본 tools/demo-day.sh tools/ecs-source.sh)
# ④ TFOUT (같은 파일): 스크립트가 읽는 terraform 출력(tfout·tfjson·output -raw)이 그 모듈에 선언돼 있는지.
#   --plan 으로 terraform show -json 결과를 주면 plan 기준 값이 null(조건으로 안 만들어짐)인지도 본다 (F7 류: 생산자 출력 ≠ 소비자 가정)
import glob, re, sys

FUNCS_SETTING = {"aws_account_var": {"expected_account_id"}}   # 줄에서 부르면 이 TF_VAR_ 들을 export 하는 함수 (demo-day.sh)


def required_vars(mod):
    out = []
    for f in sorted(glob.glob(mod + "/*.tf")):
        s = open(f).read()
        for m in re.finditer(r'^variable\s+"([^"]+)"\s*\{', s, re.M):
            i, d = m.end(), 1
            while d and i < len(s):
                d += {"{": 1, "}": -1}.get(s[i], 0); i += 1
            body = re.sub(r'#.*', '', s[m.end():i - 1])
            if not re.search(r'^\s*default\s*=', body, re.M):
                out.append(m.group(1))
    return out


def logical_lines(text):
    buf, n0 = "", 0
    for n, line in enumerate(text.split("\n"), 1):
        if not buf:
            n0 = n
        if line.rstrip().endswith("\\"):
            buf += line.rstrip()[:-1] + " "; continue
        yield n0, buf + line
        buf = ""


def check(path):
    text = open(path).read()
    mods = {k: v for k, v in re.findall(r'^\s*([A-Z][A-Z0-9_]*)=(infra/modules/[A-Za-z0-9_/-]+)\s*$', text, re.M)}
    # ecs-source.sh 꼴: tf() { run terraform -chdir="$MOD" "$@"; } → "tf apply" 줄은 $MOD
    wrappers = {name: var for name, var in re.findall(r'^\s*([a-z_]+)\(\)\s*\{[^}]*terraform -chdir="\$([A-Z_]+)" "\$@"', text, re.M)}
    rows, n_lines = [], 0
    for n, line in logical_lines(text):
        code = re.sub(r'(^|\s)#.*$', '', line)
        if re.match(r'^\s*(echo|log)\b', code):
            continue
        targets = [(m.group(1), m.group(2)) for m in re.finditer(r'terraform -chdir="\$([A-Z_]+)"\s+(apply|destroy|plan)\b', code)]
        for w, var in wrappers.items():
            targets += [(var, m.group(1)) for m in re.finditer(r'(?:^|[\s;&|(])' + w + r'\s+(apply|destroy|plan)\b', code)]
        for var, cmd in targets:
            mod = mods.get(var)
            if not mod:
                rows.append(("WARN", f"tfreq:{path}:{n}", f"${var} 이 어느 모듈인지 모름 (VAR=infra/modules/… 줄이 없음)")); continue
            n_lines += 1
            given = set(re.findall(r'-var\s+["\']?([a-z_][a-z0-9_]*)=', code)) | set(re.findall(r'TF_VAR_([a-z_][a-z0-9_]*)=', code))
            for fn, vs in FUNCS_SETTING.items():
                if re.search(r'(^|[\s;&|(])' + fn + r'(\s|;|&|$)', code):
                    given |= vs
            miss = [v for v in required_vars(mod) if v not in given]
            if miss:
                rows.append(("FAIL", f"tfreq:{mod[len('infra/modules/'):]}", f"{path}:{n} {cmd} 이 필수 변수를 안 넘김: {' '.join(miss)}"))
    return rows, n_lines


def declared_outputs(mod):
    out = set()
    for f in glob.glob(mod + "/*.tf"):
        out |= set(re.findall(r'^output\s+"([^"]+)"', open(f).read(), re.M))
    return out


def check_outputs(path, plans):
    text = open(path).read()
    mods = {k: v for k, v in re.findall(r'^\s*([A-Z][A-Z0-9_]*)=(infra/modules/[A-Za-z0-9_/-]+)\s*$', text, re.M)}
    rows, uses = [], set()
    for m in re.finditer(r'tf(?:out|json) "\$([A-Z_]+)" ([a-z_][a-z0-9_]*)|-chdir="\$([A-Z_]+)" output (?:-raw |-json )?([a-z_][a-z0-9_]*)', text):
        var, key = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        if var in mods:
            uses.add((mods[var], key))
    for mod, key in sorted(uses):
        short = mod[len("infra/modules/"):]
        if key not in declared_outputs(mod):
            rows.append(("FAIL", f"tfout:{short}", f"{path} 가 읽는 출력 {key} 를 모듈이 안 내보냄")); continue
        pj = plans.get(mod)
        if pj is None:
            continue
        ch = (pj.get("output_changes") or {}).get(key) or {}
        if ch.get("after") is None and not ch.get("after_unknown"):
            rows.append(("FAIL", f"tfout:{short}", f"{path} 가 읽는 출력 {key} 가 plan 에서 null (조건으로 안 만들어짐) → 빈 값으로 진행"))
    return rows, len(uses)


def main(argv):
    import json
    plans, paths, it = {}, [], iter(argv)
    for a in it:
        if a == "--plan":
            mod, _, f = next(it).partition("=")
            try:
                plans[mod.rstrip("/")] = json.load(open(f))
            except Exception as e:
                print(f"WARN tfout:{mod} plan json 못 읽음 ({type(e).__name__}) → 선언만 봄")
        else:
            paths.append(a)
    paths = paths or ["tools/demo-day.sh", "tools/ecs-source.sh"]
    nf, total, nout = 0, 0, 0
    for p in paths:
        orows, no = check_outputs(p, plans)
        nout += no
        for lvl, item, msg in orows:
            nf += lvl == "FAIL"
            print(f"{lvl:<4} {item} {msg}")
    if nf == 0:
        print(f"OK   tfout 스크립트가 읽는 terraform 출력 {nout}개 모두 선언됨{' · plan 값 있음(' + ' '.join(m[len('infra/modules/'):] for m in plans) + ')' if plans else ''}")
    nf0 = nf
    for p in paths:
        rows, n = check(p)
        total += n
        for lvl, item, msg in rows:
            nf += lvl == "FAIL"
            print(f"{lvl:<4} {item} {msg}")
    if nf == nf0:
        print(f"OK   tfreq terraform apply·destroy·plan {total}줄 모두 필수 변수 넘김 ({' '.join(paths)})")
    return 1 if nf else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
