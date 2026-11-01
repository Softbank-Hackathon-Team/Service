#!/usr/bin/env python3
# 대본-실측 표 (z75-41, 작업 Z78). 리허설 한 회차의 장면 기계 시간과 5분 대본 문단 읽기 시간을 나란히 놓는다.
#   python3 tools/measure/talk-timing.py <대본.md> <리허설 run-N 폴더> <출력.md> [초당 글자 5.5] [누적 기준 300]
# 대본: "### 문단 N. 제목 [..] · S4 …" 아래의 "> " 줄(한 줄 = 한 문장)만 읽는다. "## 2." 부터는 안 읽는다.
# 글자 수: 한글 음절·영문자·숫자 (빈칸·문장부호 뺌). 읽기 초 = 글자 ÷ 초당 글자.
# 장면 기계 초: run-N/times.txt 의 그 문단 장면(제목 줄의 첫 S 번호) 시간.
# 큰 값 = 둘 중 큰 쪽(그 문단이 실제로 차지하는 시간), 누적 = 큰 값의 합.
# 기준: 누적 ≤ 300초, "기계 초 > 읽기 초" 문단 0개 (화면이 말보다 늦게 끝나면 말이 멈춘다).
# 마지막 줄 "판정 PASS|FAIL …". 끝 코드 0 = PASS, 1 = FAIL, 2 = 파일 없음.
import os, re, sys

if len(sys.argv) < 4:
    print(__doc__ or "인자: 대본 run폴더 출력", file=sys.stderr); sys.exit(2)
talk, rdir, out = sys.argv[1], sys.argv[2], sys.argv[3]
cps = float(sys.argv[4]) if len(sys.argv) > 4 else 5.5
limit = float(sys.argv[5]) if len(sys.argv) > 5 else 300.0
if not os.path.exists(talk) or not os.path.exists(os.path.join(rdir, "times.txt")):
    print(f"SKIP 대본({talk}) 또는 times.txt 없음"); sys.exit(2)

paras, cur = [], None
for ln in open(talk, encoding="utf-8"):
    if ln.startswith("## ") and not ln.startswith("## 1."):
        if paras: break
        continue
    m = re.match(r"### 문단 (\d+)\.\s*([^\[]+?)\s*\[.*?·\s*(S\d+)", ln)
    if m:
        cur = {"n": int(m.group(1)), "title": m.group(2).strip(), "scene": m.group(3), "chars": 0, "lines": 0}
        paras.append(cur); continue
    if cur and ln.startswith("> "):
        cur["chars"] += len(re.findall(r"[가-힣A-Za-z0-9]", ln[2:])); cur["lines"] += 1

mach = {}
for ln in open(os.path.join(rdir, "times.txt")):
    p = ln.split()
    if len(p) >= 2: mach[p[0]] = int(p[1]) / 1000

rows, cum, slow = [], 0.0, []
for p in paras:
    read = p["chars"] / cps
    m = mach.get(p["scene"])
    big = max(read, m or 0)
    cum += big
    if m is not None and m > read: slow.append(f"문단 {p['n']}")
    rows.append(f"| {p['n']}. {p['title']} | {p['scene']} | {p['lines']} | {p['chars']} | {read:.1f} | "
                f"{'-' if m is None else f'{m:.2f}'} | {big:.1f} | {cum:.1f} |")

bad = []
if cum > limit: bad.append(f"누적 {cum:.1f}초 > {limit:.0f}초")
if slow: bad.append("기계 초 > 읽기 초: " + ", ".join(slow))
if not paras: bad.append("대본에서 문단을 못 읽음")
verdict = f"판정 {'PASS' if not bad else 'FAIL'}: 누적 {cum:.1f}초 (기준 ≤{limit:.0f}), 기계가 말보다 느린 문단 {len(slow)}개" + ("" if not bad else " / " + "; ".join(bad))
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    f.write(f"# 대본-실측 표 ({os.path.basename(os.path.normpath(rdir))})\n\n")
    f.write(f"문서 상태: rehearse.sh 가 자동으로 만든 표. 대본 {os.path.basename(talk)}, 리허설 {rdir}, 읽기 속도 초당 {cps}자.\n\n")
    f.write("| 문단 | 장면 | 문장 | 글자 | 읽기 초 | 기계 초 | 큰 값 | 누적 |\n|---|---|---|---|---|---|---|---|\n")
    f.write("\n".join(rows) + "\n\n")
    f.write("- 큰 값 = 읽기 초와 기계 초 중 큰 쪽. 누적은 화면 전환·대체 여유를 넣지 않은 값이다.\n")
    f.write(f"- {verdict}\n")
print(verdict)
sys.exit(0 if not bad else 1)
