import json
import sys

r = json.load(sys.stdin)
print("가격 기준일:", r["priceAsOf"], "낡음:", r["priceStale"])
print("피크 rps:", r["peakRps"], "필요 vCPU:", r["requiredVcpu"])
for e in r["envs"]:
    print(f'{e["provider"]:7} {e["nodeSku"]} {e["nodes"]}대 월 ${e["monthlyUsd"]}  미확인={e["unverified"]}')
print("가장 싼 곳:", r["cheapest"])
print("절약:", r["savings"])
for x in r["recommendations"][:3]:
    print("추천", x["rank"], x["provider"], x["security"], "점수", x["score"])
print("최저 환경이 바뀌는 지점:", r.get("breakpoints"))
