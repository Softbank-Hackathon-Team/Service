# DRAFT(ai): outputs/results.json → Notion용 PNG. 색은 데이터비즈 절차로 검증한 범주 팔레트 슬롯 1~4 고정 순서.
# 대비가 3:1 아래인 두 색(청록, 노랑)이 있어 선과 점에는 직접 라벨을 붙인다.
import json
import math
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

HERE = pathlib.Path(__file__).resolve().parent.parent
OUT = HERE / "outputs"
R = json.loads((OUT / "results.json").read_text())

FONT = "Apple SD Gothic Neo"
if not any(f.name == FONT for f in fm.fontManager.ttflist):
    FONT = "AppleGothic"
plt.rcParams.update({
    "font.family": FONT, "axes.unicode_minus": False, "font.size": 11,
    "axes.spines.top": False, "axes.spines.right": False, "axes.edgecolor": "#d6d5d0",
    "axes.linewidth": 1, "axes.titlesize": 13, "axes.titleweight": "bold", "axes.titlelocation": "left",
    "xtick.color": "#52514e", "ytick.color": "#52514e", "xtick.major.size": 0, "ytick.major.size": 0,
    "axes.labelcolor": "#52514e", "axes.grid": True, "grid.color": "#ecebe7", "grid.linewidth": 1,
    "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb", "savefig.facecolor": "#fcfcfb",
    "axes.axisbelow": True, "legend.frameon": False, "text.parse_math": False,
})
INK = "#0b0b0b"; INK2 = "#52514e"; MUTED = "#8a8984"
VENDOR = {"aws": ("AWS", "#2a78d6"), "gcp": ("GCP", "#eb6834"), "azure": ("Azure", "#1baf7a"), "onprem": ("온프레", "#eda100")}
TERM = {"node": ("노드 병목 항", "#2a78d6"), "db": ("DB 항", "#eb6834"), "egress": ("송신 항", "#1baf7a")}
BRANCH_SHORT = ["1. 공개 가격표만", "2. 현재 사용량 + 미리 잰 값", "3. 부하 테스트 실측"]

def save(fig, name):
    fig.savefig(OUT / name, dpi=180, bbox_inches="tight")
    plt.close(fig)
    print("saved", name)

def dollars(x, _=None):
    return f"${x:,.0f}" if x >= 10 else f"${x:g}"

# ---------- 그림 1: 비용 곡선 ----------
def fig_curves():
    c = R["curves"]; grid = c["grid"]
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.4), gridspec_kw={"width_ratios": [1, 1.25]})
    ranges = [(0, 800, 0, 1.6), (0, 8000, 0, 9)]
    for ax, (x0, x1, y0, y1) in zip(axes, ranges):
        ends = []
        for s in c["series"]:
            label, color = VENDOR[s["vendor"]]
            pts = [(g, a, t) for g, a, t in zip(grid, s["actual"], s["approx"]) if a is not None]
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; ts = [p[2] for p in pts]
            ax.plot(xs, ts, color=color, lw=1.1, alpha=0.55, solid_capstyle="round")
            ax.plot(xs, ys, color=color, lw=2, solid_capstyle="round", solid_joinstyle="round", label=label)
            inside = [(x, y) for x, y in zip(xs, ys) if x <= x1 and y <= y1]
            if inside:
                ends.append((inside[-1][1], inside[-1][0], label))
        ends.sort()
        last = -1
        gap = (y1 - y0) * 0.055
        for y, x, label in ends:
            ty = max(y, last + gap)
            ax.annotate(label, (x, y), xytext=(x1 * 1.012, ty), textcoords="data", color=INK, fontsize=11, va="center", annotation_clip=False)
            last = ty
        ax.set_xlim(x0, x1); ax.set_ylim(y0, y1)
        ax.set_xlabel("트래픽 λ (req/s)")
        ax.yaxis.set_major_formatter(lambda v, _: f"${v:g}")
    axes[0].set_ylabel("시간당 비용 (달러)")
    axes[0].set_title("소규모 구간: DB 등급과 최소 노드가 정한다 (온프레는 위쪽 밖)")
    axes[1].set_title("대규모 구간: 송신 단가와 온프레 고정비가 정한다")
    env = [e for e in c["envelope"] if e["vendor"]]
    for e in env[1:]:
        if e["fromLambda"] <= 8000:
            for ax, (x0, x1, y0, y1) in zip(axes, ranges):
                if x0 < e["fromLambda"] < x1 and not (x1 > 800 and e["fromLambda"] < 800):
                    ax.axvline(e["fromLambda"], color="#c9c8c2", lw=1, zorder=0)
                    ax.annotate(f"{e['fromLambda']:.0f}", (e["fromLambda"], y1), xytext=(3, -12), textcoords="offset points", fontsize=9.5, color=INK2)
    ep = [e for e in env if e["toLambda"] - e["fromLambda"] > 80]
    txt = "  ".join(f"{VENDOR[e['vendor']][0]} {e['fromLambda']:.0f}~{e['toLambda']:.0f}" for e in ep[:7])
    fig.text(0.01, -0.03, f"굵은 선 = 실제 비용 C_v, 얇은 선 = 올림을 뺀 근사식. 세로선 = 실제 비용에서 최저 벤더가 바뀌는 지점. 긴 구간: {txt}", color=INK2, fontsize=10)
    fig.text(0.01, -0.07, "r_v는 로컬 측정 회귀(측정 범위 0~4800 req/s, 그 위는 외삽), 가격은 공개 가격(온프레는 가정). 2026-11-01 수집.", color=INK2, fontsize=10)
    fig.suptitle("벤더별 시간당 비용 Cost_v(λ): examples/shop", x=0.01, ha="left", fontsize=15, fontweight="bold", color=INK)
    fig.tight_layout(rect=(0, 0, 0.98, 0.97))
    save(fig, "fig1-cost-curves.png")

# ---------- 그림 2: 세 갈래 비교 ----------
def fig_branches():
    bs = R["branches"]
    fig, axes = plt.subplots(3, 1, figsize=(11.5, 7.0), sharex=True)
    order = ["aws", "gcp", "azure", "onprem"]
    verdict_k = {"stay": "옮기지 마세요", "move": "옮기세요", "insufficient-evidence": "근거 부족"}
    reason_k = {"PAYBACK_TOO_LONG": "회수 기간 초과", "NO_SAVING": "절감 없음", "SAVING_RANGE_CROSSES_ZERO": "절감 범위가 0을 넘음", "PAYBACK_WITHIN_LIMIT": "회수 기간 안"}
    for ax, b, short in zip(axes, bs, BRANCH_SHORT):
        for i, v in enumerate(order):
            e = next(x for x in b["vendors"] if x["vendor"] == v)
            m = e["monthlyUsd"]; label, color = VENDOR[v]
            y = len(order) - 1 - i
            if m is None:
                continue
            ax.plot([m["low"], m["high"]], [y, y], color=color, lw=5, alpha=0.35, solid_capstyle="round")
            ax.plot([m["base"]], [y], "o", color=color, ms=9, mec="#fcfcfb", mew=2)
            ax.annotate(f"${m['base']:,.0f}", (m["high"], y), xytext=(8, 0), textcoords="offset points", va="center", fontsize=10.5, color=INK)
        ax.set_yticks(range(len(order))); ax.set_yticklabels([VENDOR[v][0] for v in reversed(order)], color=INK)
        ax.set_ylim(-0.6, len(order) - 0.4)
        ax.set_xscale("log"); ax.set_xlim(70, 9000)
        ax.grid(axis="y", visible=False)
        d = b["decision"]
        s = d["monthlySavingUsd"]
        best = VENDOR[b["best"]][0]; to = VENDOR[d["to"]][0] if d["to"] else "-"
        p = max(b["vendors"], key=lambda x: x["probBest"])
        ax.set_title(f"{short}: 추천 {best}, P(최저) {p['probBest']*100:.0f}% · 판단 {verdict_k[d['verdict']]} ({reason_k.get(d['reason'], d['reason'])})", fontsize=12)
        if s:
            lo = 0 if abs(s['low']) < 0.5 else s['low']
            ax.text(0.995, 0.9, f"AWS→{to} 월 절감 ${s['base']:,.0f} (범위 {lo:,.0f}~{s['high']:,.0f})", transform=ax.transAxes, ha="right", fontsize=10, color=INK2)
            ax.text(0.995, 0.76, f"일회성 ${d['oneTimeUsd']:,.0f}", transform=ax.transAxes, ha="right", fontsize=10, color=INK2)
    axes[-1].set_xticks([100, 200, 500, 1000, 2000, 5000])
    axes[-1].set_xticklabels(["$100", "$200", "$500", "$1K", "$2K", "$5K"])
    axes[-1].minorticks_off()
    axes[-1].set_xlabel("월 비용 (로그 눈금). 점 = 기준값, 막대 = 10~90% 범위")
    fig.suptitle("같은 엔진, 다른 근거: 피크 100 req/s, 출발 AWS", x=0.01, ha="left", fontsize=15, fontweight="bold", color=INK)
    fig.text(0.01, -0.02, "온프레는 고정비(가정)라 사용량 범위의 영향을 받지 않는다. 실측 갈래는 최소 노드 바닥 안이라 범위가 점 안에 들어간다. 범위 폭 = 근거 수준 가정 + 로컬 CPU 배수 + 벤더 CPU 성능 ±15%.", color=INK2, fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    save(fig, "fig2-three-branches.png")

# ---------- 그림 3: 기울기 분해 ----------
def fig_gradient():
    gs = [g for g in R["gradients"] if g["lambda"] in (100, 1000, 5000)]
    fig, axes = plt.subplots(1, len(gs), figsize=(13, 3.9), sharey=True)
    order = ["aws", "gcp", "azure", "onprem"]
    for ax, g in zip(axes, gs):
        maxv = 0
        for i, v in enumerate(order):
            e = next(x for x in g["byVendor"] if x["vendor"] == v)
            y = len(order) - 1 - i
            left = 0
            for key, val in (("node", e["nodeTerm"]), ("db", e["dbTerm"] + e["storageTerm"]), ("egress", e["egressTerm"])):
                v1 = val * 1000
                if v1 <= 0:
                    continue
                ax.barh(y, v1, left=left, height=0.46, color=TERM[key][1], edgecolor="#fcfcfb", linewidth=2)
                left += v1
            total = e["total"] * 1000
            maxv = max(maxv, total)
            k = "+".join({"cpu": "CPU", "cpuRequested": "요청량", "mem": "메모리", "gpu": "GPU"}[z] for z in e["kStar"])
            note = "최소 노드 아래" if e["belowMinNodes"] else f"k*={k}"
            ax.annotate(f"{total:.2f}  {e['sku']} {note}", (total, y), xytext=(6, 0), textcoords="offset points", va="center", fontsize=9, color=INK)
        ax.set_yticks(range(len(order))); ax.set_yticklabels([VENDOR[v][0] for v in reversed(order)], color=INK)
        ax.grid(axis="y", visible=False)
        ax.set_xlim(0, 2.6)
        ax.set_ylim(-0.6, len(order) - 0.4)
        ax.set_title(f"λ = {g['lambda']} req/s")
        ax.set_xlabel("밀리달러/시간 per req/s")
    handles = [plt.Rectangle((0, 0), 1, 1, color=TERM[k][1]) for k in TERM]
    fig.legend(handles, [TERM[k][0] for k in TERM], loc="upper right", ncol=3, bbox_to_anchor=(0.995, 1.04))
    fig.suptitle("∂Cost/∂λ 분해: 트래픽이 늘 때 돈이 어디로 가나", x=0.01, ha="left", fontsize=15, fontweight="bold", color=INK, y=1.02)
    fig.text(0.01, -0.06, "올림을 뺀 근사식 기준. 노드 종류는 그 λ에서 근사 비용이 가장 낮은 것. 측정 범위 0~4800 req/s, 5000은 살짝 외삽. 온프레의 송신 항 0은 회선 고정비(가정)에 들어 있기 때문이다.", color=INK2, fontsize=10)
    fig.tight_layout()
    save(fig, "fig3-gradient-breakdown.png")

# ---------- 그림 4: 예측 대 관측 ----------
def fig_error():
    pe = R["predictionErrors"]
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.6), gridspec_kw={"width_ratios": [1, 1, 1.25]})
    stages = [s for s in R["stages"] if s["mix"] == "target"]
    idle = [s for s in R["stages"] if s["mix"] == "idle"]
    fit = R["fitTable"]
    scale = R["generatedFrom"]["cpuScale"]
    # 왼쪽: CPU, 가운데: 송신. 회귀 직선과 관측
    train = [10, 25, 50, 100, 200]
    for ax, key, get, label in (
        (axes[0], "cpu", lambda s: (s["appCpu"] + s["proxyCpu"]) * scale, "앱 CPU (vCPU 환산)"),
        (axes[1], "egressGBh", lambda s: s["egressGBh"], "송신량 (GB/h)"),
    ):
        f = fit[key]
        xmax = 500
        ax.plot([0, xmax], [f["intercept"], f["intercept"] + f["slope"] * xmax], color="#2a78d6", lw=2, solid_capstyle="round")
        tx = [s["targetRps"] for s in stages if s["targetRps"] in train]; ty = [get(s) for s in stages if s["targetRps"] in train]
        hx = [s["targetRps"] for s in stages if s["targetRps"] in (150, 400)]; hy = [get(s) for s in stages if s["targetRps"] in (150, 400)]
        ax.plot(tx, ty, "o", color="#2a78d6", ms=7, mec="#fcfcfb", mew=1.5, label="회귀에 쓴 단계")
        ax.plot(hx, hy, "o", color="#eb6834", ms=8, mec="#fcfcfb", mew=1.5, label="검증 단계 (회귀 제외)")
        ax.set_xlim(0, xmax); ax.set_ylim(bottom=0)
        ax.set_xlabel("λ (req/s)")
        ax.set_title(label)
        ax.text(0.04, 0.9, f"R² = {f['r2']:.4f}, n = {f['n']}", transform=ax.transAxes, color=INK, fontsize=10.5)
    axes[0].legend(loc="lower right", fontsize=9.5)
    # 오른쪽: 갈래별 자원·비용 오차 (λ=150, 400 평균)
    ax = axes[2]
    fields = [("cpu", "앱 CPU"), ("dbCpu", "DB CPU"), ("memGiB", "앱 메모리"), ("egressGBh", "송신량"), ("__cost", "시간당 비용")]
    colors = ["#2a78d6", "#eb6834", "#1baf7a"]
    for bi, (b, short) in enumerate(zip(pe, BRANCH_SHORT)):
        pts = [p for p in b["points"] if p["lambda"] <= 400]
        for fi, (fk, fname) in enumerate(fields):
            if fk == "__cost":
                vals = [c["ape"] for p in pts for c in p["cost"].values()]
            else:
                vals = [p["fields"][fk]["ape"] for p in pts if p["fields"][fk]["ape"] is not None]
            v = sum(vals) / len(vals) * 100
            y = len(fields) - 1 - fi + (1 - bi) * 0.22
            ax.plot([0.5, max(v, 0.5)], [y, y], color=colors[bi], lw=1, alpha=0.4)
            ax.plot([max(v, 0.5)], [y], "o", color=colors[bi], ms=7.5, mec="#fcfcfb", mew=1.5, label=short if fi == 0 else None)
            ax.annotate(f"{v:,.0f}%" if v >= 10 else f"{v:.1f}%", (max(v, 0.5), y), xytext=(7, 0), textcoords="offset points", va="center", fontsize=9, color=INK)
    ax.set_yticks(range(len(fields))); ax.set_yticklabels([f[1] for f in reversed(fields)], color=INK)
    ax.set_xscale("log"); ax.set_xlim(0.5, 20000)
    ax.set_xticks([1, 10, 100, 1000, 10000]); ax.set_xticklabels(["1%", "10%", "100%", "1,000%", "10,000%"]); ax.minorticks_off()
    ax.grid(axis="y", visible=False)
    ax.set_title("갈래별 예측 오차 (λ=150, 400 평균)")
    ax.legend(loc="upper center", bbox_to_anchor=(0.45, -0.1), ncol=3, fontsize=9.5, handletextpad=0.2, columnspacing=0.9)
    fig.suptitle("예측 대 관측: 로컬 측정 기준 (클라우드 청구서가 아니다)", x=0.01, ha="left", fontsize=15, fontweight="bold", color=INK)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    save(fig, "fig4-prediction-error.png")

# ---------- 그림 5: 회수 기간 ----------
def fig_payback():
    sw = R["paybackSweep"]
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8), sharey=True)
    kor = {"stay": "옮기지 마세요", "move": "옮기세요", "insufficient-evidence": "근거 부족"}
    marker = {"stay": "X", "move": "o", "insufficient-evidence": "D"}
    for ax, frm in zip(axes, ["aws", "gcp"]):
        rows = sorted([r for r in sw if r["from"] == frm], key=lambda r: r["peak"])
        xs = [r["peak"] for r in rows]
        base = [max(r["saving"]["base"], 0.5) if r["saving"] else 0.5 for r in rows]
        low = [max(r["saving"]["low"], 0.5) if r["saving"] else 0.5 for r in rows]
        high = [max(r["saving"]["high"], 0.5) if r["saving"] else 0.5 for r in rows]
        thr = [(r["oneTime"] or 0) / 12 for r in rows]
        ax.fill_between(xs, low, high, color="#2a78d6", alpha=0.10, linewidth=0)
        ax.plot(xs, base, color="#2a78d6", lw=2, solid_capstyle="round")
        ax.plot(xs, thr, color="#8a8984", lw=1.5)
        ax.annotate("일회성 비용 / 12개월", (xs[1], thr[1]), xytext=(0, 7), textcoords="offset points", color=INK2, fontsize=10)
        seen = set()
        for r, b in zip(rows, base):
            lab = kor[r["verdict"]] if r["verdict"] not in seen else None
            seen.add(r["verdict"])
            ax.plot([r["peak"]], [b], marker[r["verdict"]], color="#2a78d6" if r["verdict"] == "move" else "#52514e", ms=8.5, mec="#fcfcfb", mew=1.5, label=lab)
        for r, b in zip(rows, base):
            if r["to"] and r["peak"] in (100, 1000, 8000):
                off = (-58, 8) if r["peak"] == 8000 else (-20, -16) if r["peak"] == 1000 else (-10, 11)
                ax.annotate(f"→{VENDOR[r['to']][0]} ${b:,.0f}", (r["peak"], b), xytext=off, textcoords="offset points", fontsize=9.5, color=INK)
        ax.set_xscale("log"); ax.set_yscale("log"); ax.set_ylim(1, 20000); ax.set_xlim(10, 8000)
        ax.set_xticks([10, 100, 1000, 8000]); ax.set_xticklabels(["10", "100", "1,000", "8,000"]); ax.minorticks_off()
        ax.set_yticks([1, 10, 100, 1000, 10000]); ax.set_yticklabels(["$1", "$10", "$100", "$1K", "$10K"])
        ax.set_xlabel("피크 λ (req/s, 하루 주기)")
        ax.set_title(f"출발 {VENDOR[frm][0]}: 가장 많이 아끼는 도착지 기준")
        ax.legend(loc="upper left", fontsize=10)
    axes[0].set_ylabel("월 절감액 (로그 눈금)")
    fig.suptitle("옮길 가치가 있는가: 월 절감액 대 회수 기준", x=0.01, ha="left", fontsize=15, fontweight="bold", color=INK)
    fig.text(0.01, -0.03, "절감이 회색 선 아래면 12개월 안에 일회성 비용을 못 찾는다. 일회성 비용은 인건비 $3,200 포함 가정. 음수 절감은 $1 바닥에 표시. 측정 범위 위(4800 초과)는 외삽.", color=INK2, fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    save(fig, "fig5-payback.png")

for f in (fig_curves, fig_branches, fig_gradient, fig_error, fig_payback):
    f()
