"""이전 한 건의 감사 기록(JSON, stdin) → 단계별 소요 시간 표.

    python3 timing_report.py <runs 폴더>     표를 찍고 <runs>/<id8>-<출발>-to-<도착>.md 로 저장
    python3 timing_report.py --tail <N>     N번째 이후 새 전이만 stderr 로 한 줄씩, stdout 에는 새 N

시간 구분 (DRAFT(ai): 측정용 분류, 팀 합의 전):
  자동   = 플랫폼이 일하는 시간 (가져오기·점검·자원 생성·배포·복제·트래픽·컷오버·정리)
  사람   = 사람이 누르기를 기다린 시간 (명세 확정·계획 승인)
  멈춤   = paused. 원인을 고치고 재개할 때까지 (사람 + 고치는 시간)
  고정   = rollback_window. 설정값만큼 일부러 기다림
"""
import json
import sys
from datetime import datetime

HUMAN = {"spec_review", "awaiting_approval"}
BLOCKED = {"paused", "failed"}   # failed 도 재시도를 누를 때까지 멈춘 시간이다 (끝 상태일 때는 칸이 안 생긴다)
FIXED = {"rollback_window"}
TERMINAL = {"completed", "failed", "rolled_back", "cancelled"}
NAMES = {
    "draft": "생성", "importing": "가져오기", "spec_review": "명세 확정 대기", "prechecking": "사전 점검",
    "planning": "계획 만들기", "awaiting_approval": "계획 승인 대기", "approved": "승인됨", "provisioning": "자원 생성",
    "deploying": "앱 배포", "paused": "멈춤", "syncing": "DB 복제", "shifting": "트래픽 이동", "cutover": "DB 컷오버",
    "rollback_window": "롤백 대기", "cleanup": "정리", "rolling_back": "롤백 중", "failed": "실패(재시도 대기)",
}


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def dur(sec):
    sec = int(round(sec))
    return f"{sec // 60}분 {sec % 60:02d}초" if sec >= 60 else f"{sec}초"


def kst(t):
    return t.astimezone().strftime("%H:%M:%S")


def kind(state):
    return "사람" if state in HUMAN else "멈춤" if state in BLOCKED else "고정" if state in FIXED else "자동"


def transitions(ev):
    return [e for e in ev if isinstance(e["detail"], dict) and e["detail"].get("to") and e["detail"].get("from") is not None]


def tail_mode(doc, seen):
    tr = transitions(doc["ev"])
    for e in tr[seen:]:
        d = e["detail"]
        extra = f"  [{d['failureCode']}]" if d.get("failureCode") else ""
        print(f"{kst(ts(e['at']))}  {NAMES.get(d['from'], d['from'])} -> {NAMES.get(d['to'], d['to'])}{extra}", file=sys.stderr, flush=True)
    print(len(tr))


def segments(doc):
    m, tr = doc["m"], transitions(doc["ev"])
    out, start, state = [], ts(m["created"]), "draft"
    for e in tr:
        t = ts(e["at"])
        out.append({"state": state, "start": start, "sec": (t - start).total_seconds(), "code": None})
        state, start = e["detail"]["to"], t
        if state in BLOCKED:
            out[-1]["next_code"] = e["detail"].get("failureCode")
    if state not in TERMINAL:   # 아직 진행 중: 지금까지
        out.append({"state": state, "start": start, "sec": (datetime.now(start.tzinfo) - start).total_seconds(), "running": True})
    for i, s in enumerate(out):   # 멈춤 칸에 원인 코드
        if s["state"] in BLOCKED and i > 0:
            s["code"] = out[i - 1].get("next_code")
    return out, state


def first(ev, action):
    return next((e for e in ev if e["action"] == action), None)


def inner(doc, segs):
    ev, lines = doc["ev"], []
    # 자원 생성: terraform 단계별 (apply 결과 detail.terraform.steps) + 중계기
    ap = first(ev, "apply.deploying")
    prov = sum(s["sec"] for s in segs if s["state"] == "provisioning")
    # 시도마다 terraform 기록: 실패한 시도는 apply.failed 의 steps·elapsedMs, 성공한 시도는 apply.deploying 의 terraform
    tries = [(e, e["detail"]) for e in ev if e["action"] == "apply.failed" and isinstance(e["detail"], dict) and e["detail"].get("steps")]
    if ap and (ap["detail"].get("terraform") or {}).get("steps"):
        tries.append((ap, ap["detail"]["terraform"]))
    if ap and tries:
        tf_ms = sum(t.get("elapsedMs", 0) for _, t in tries)
        for e, t in tries:
            ok = e["action"] == "apply.deploying"
            parts = " · ".join(f"{s['step']} {dur(s['ms'] / 1000)}" for s in t["steps"])
            lines.append(f"- 자원 생성 시도 {kst(ts(e['at']))} {'성공' if ok else '실패'}: terraform {dur(t.get('elapsedMs', 0) / 1000)} ({parts})")
        lines.append(f"- **자원 생성 {dur(prov)}** = terraform 합 {dur(tf_ms / 1000)} (시도 {len(tries)}번)"
                     + (f" + 그 밖(중계기 EC2 등) 약 {dur(prov - tf_ms / 1000)} (추정: 차이로 계산)" if ap["detail"].get("relay") else ""))
    elif ap:
        lines.append(f"- **자원 생성 {dur(prov)}**: terraform 단계 기록 없음 (온프레 도착은 클라우드 자원을 안 만든다)"
                     + ("; 중계기 EC2 생성이 대부분 (추정)" if ap["detail"].get("relay") else ""))
    # 앱 배포: 시도마다 리허설·대기·멈춤
    dep = [s for s in segs if s["state"] == "deploying"]
    if dep:
        lines.append(f"- **앱 배포 {dur(sum(s['sec'] for s in dep))}** (시도 {len(dep)}번: " + ", ".join(dur(s["sec"]) for s in dep) + ")")
        for e in ev:
            d = e["detail"] if isinstance(e["detail"], dict) else {}
            if e["action"] == "sandbox.rehearsal":
                t = d.get("timingsMs") or {}
                lines.append(f"  - {kst(ts(e['at']))} 리허설 {d.get('status')}: " + " · ".join(f"{k} {dur(v / 1000)}" for k, v in t.items())
                             + f" (합 {dur(sum(t.values()) / 1000)})")
            elif e["action"] == "deploy.retry_scheduled":
                r = d.get("rehearsal") or {}
                lines.append(f"  - {kst(ts(e['at']))} 리허설 {r.get('status', '?')} → {d.get('delaySec', '?')}초 뒤 다시 확인 (폴링 대기)")
            elif e["action"] == "deploy.paused":
                lines.append(f"  - {kst(ts(e['at']))} 멈춤 {d.get('failureCode')}")
        sy = first(ev, "deploy.syncing")
        if sy:
            st = (sy["detail"].get("deploy") or {}).get("status")
            lines.append(f"  - 배포 확인 결과: {st}")
    # 트래픽 이동: 진짜 LB 였는지
    sh = first(ev, "shift.cutover")
    if sh:
        d = sh["detail"]
        stub = d.get("trafficStub")
        steps = " → ".join(f"{s.get('stepPct')}%" for s in (d.get("stepShares") or []))
        lines.append(f"- **트래픽 이동**: 제공자 {d.get('trafficProvider')}, 흉내={'예 (실제 사용자 트래픽은 안 옮김)' if stub else '아니오'}, 단계 {steps}, 단계마다 {d.get('planHoldSec')}초 유지"
                     + (f", 100% 관측 {d.get('observedSecAt100')}초" if d.get("observedSecAt100") is not None else ""))
    # 복제·컷오버 측정값
    for action, label in (("sync.shifting", "DB 복제"), ("cutover.rollback_window", "DB 컷오버")):
        e = first(ev, action)
        ms = (e or {}).get("detail", {}).get("measurements") or []
        if ms:
            keep = [x for x in ms if "#" not in x["name"]]
            lines.append(f"- **{label} 측정값**: " + " · ".join(f"{x['name']} {x['value']}{x['unit']}" for x in keep))
    cl = first(ev, "cleanup.completed")
    if cl:
        lines.append(f"- **정리 결과**: 남은 자원 {cl['detail'].get('leftovers')}")
    return lines


def main():
    if sys.argv[1:2] == ["--tail"]:
        return tail_mode(json.load(sys.stdin), int(sys.argv[2]))
    runs = sys.argv[1]
    doc = json.load(sys.stdin)
    m = doc["m"]
    segs, state = segments(doc)
    total = sum(s["sec"] for s in segs)
    by = {k: sum(s["sec"] for s in segs if kind(s["state"]) == k and s["state"] != "draft") for k in ("자동", "사람", "멈춤", "고정")}
    out = [f"# 이전 {m['id'][:8]}: {m['src']} → {m['tgt']}", "",
           f"- 상태: **{m['status']}**" + (f" ({m['failure']})" if m.get("failure") else ""),
           f"- 전체 {dur(total)} = 자동 {dur(by['자동'])} + 사람 대기 {dur(by['사람'])} + 멈춤 {dur(by['멈춤'])} + 고정 대기(롤백 창) {dur(by['고정'])}",
           f"- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: {dur(by['자동'] + by['고정'])}", "",
           "| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |", "|---|---|---|---|---|"]
    for s in segs:
        if s["state"] == "draft" and s["sec"] < 1:
            continue
        note = s.get("code") or ("진행 중" if s.get("running") else "")
        out.append(f"| {NAMES.get(s['state'], s['state'])} | {kst(s['start'])} | {dur(s['sec'])} | {kind(s['state'])} | {note} |")
    out += ["", "## 안쪽", ""] + inner(doc, segs)
    text = "\n".join(out) + "\n"
    print(text)
    safe = lambda s: "".join(c if c.isalnum() or c in "-_" else "_" for c in (s or "").split(" ")[0])
    path = f"{runs}/{m['id'][:8]}-{safe(m['src'])}-to-{safe(m['tgt'])}.md"
    with open(path, "w") as f:
        f.write(text)
    print(f"저장: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
