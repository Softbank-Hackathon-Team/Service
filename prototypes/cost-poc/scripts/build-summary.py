# DRAFT(ai): outputs/results.json + PNG → 로컬에서 여는 요약 HTML. 외부 요청 없음(그림은 같은 폴더 상대 경로).
import html
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "outputs"
R = json.loads((OUT / "results.json").read_text())
V = {"aws": "AWS", "gcp": "GCP", "azure": "Azure", "onprem": "온프레"}
K = {"stay": "옮기지 마세요", "move": "옮기세요", "insufficient-evidence": "근거 부족"}
RS = {"PAYBACK_TOO_LONG": "회수 기간 초과", "NO_SAVING": "절감 없음", "SAVING_RANGE_CROSSES_ZERO": "절감 범위가 0을 넘음", "PAYBACK_WITHIN_LIMIT": "회수 기간 안", "NO_FEASIBLE_TARGET": "도착 후보 없음"}

def money(x):
    return "-" if x is None else f"${x:,.0f}"

def table(head, rows):
    h = "".join(f"<th>{html.escape(str(c))}</th>" for c in head)
    b = "".join("<tr>" + "".join(f"<td>{html.escape(str(c))}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="tw"><table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>'

branch_rows = []
for b in R["branches"]:
    for v in b["vendors"]:
        m = v["monthlyUsd"]
        branch_rows.append([b["name"], V[v["vendor"]], money(m["base"]), f"{money(m['low'])} ~ {money(m['high'])}", f"{v['nodeSku']} {v['avgNodes']}대", v["dbSku"] or "노드 안", f"{v['probBest']*100:.0f}%"])
case_rows = []
for s in R["scenarios"]:
    d = s["decision"]; sv = d["monthlySavingUsd"]
    case_rows.append([s["name"], K[d["verdict"]], RS.get(d["reason"], d["reason"]), V.get(d["to"], "-"), money(sv["base"]) if sv else "-", money(d["oneTimeUsd"]), "-" if d["paybackMonths"] is None else f"{d['paybackMonths']:.1f}개월"])
sens_rows = [[s["name"], money(s["monthly"]["aws"]), money(s["monthly"]["gcp"]), money(s["monthly"]["azure"]), money(s["monthly"]["onprem"]), V[s["best"]], K[s["verdict"]]] for s in R["sensitivity"]]
figs = [("fig1-cost-curves.png", "벤더별 시간당 비용 곡선"), ("fig2-three-branches.png", "세 갈래 비교"), ("fig3-gradient-breakdown.png", "비용 기울기 분해"), ("fig4-prediction-error.png", "예측 대 관측"), ("fig5-payback.png", "회수 기간")]
page = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>비용 알고리즘 POC</title>
<style>
:root{{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3de}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#3a3a37}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,'Apple SD Gothic Neo',sans-serif}}
main{{max-width:1040px;margin:0 auto;padding:32px 16px 64px}}h1{{font-size:28px;margin:0 0 4px}}h2{{font-size:20px;margin:40px 0 8px}}p{{color:var(--ink2)}}
img{{width:100%;height:auto;background:#fcfcfb;border-radius:8px;border:1px solid var(--line)}}
.tw{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}}th,td{{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}}th{{color:var(--ink2);font-weight:600}}
</style></head><body><main>
<h1>비용 알고리즘 POC 요약</h1><p>대상 앱 examples/shop. 가격은 2026-11-01 수집한 공개 가격(온프레는 가정). 사용량은 로컬 도커 측정. 자세한 글은 Notion 카드의 완료 보고서.</p>
<h2>이전 판단 사례</h2>{table(["사례","판단","이유","도착","월 절감","일회성","회수"],case_rows)}
<h2>세 갈래 (피크 100 req/s, 출발 AWS)</h2>{table(["갈래","벤더","월 비용","10~90% 범위","노드","DB","P(최저)"],branch_rows)}
<h2>민감도 (출발 AWS, 피크 1000 req/s)</h2>{table(["조건","AWS","GCP","Azure","온프레","최저","판단"],sens_rows)}
{"".join(f'<h2>{html.escape(t)}</h2><img src="{f}" alt="{html.escape(t)}">' for f,t in figs)}
</main></body></html>"""
(OUT / "summary.html").write_text(page)
print("saved summary.html")
