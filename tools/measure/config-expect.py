#!/usr/bin/env python3
# 워커·API 를 띄운 뒤 "유효 설정" 로그 줄이 시험이 기대하는 값과 같은지 본다 (z75-43, 작업 Z78).
# 줄 형식은 Z81 z81-10: {"component":"config","msg":"effective config","service":"worker","config":{"<이름>":{"value":…,"source":…}}}
# 6차 맥에서 운영 워커가 관찰 시간 기본 30초로 떠서 e2e 가 한참 뒤에 깨졌다 → 띄운 직후 10초 안에 알아챈다.
#   python3 tools/measure/config-expect.py (--file <로그> | --cmd "<로그를 찍는 명령>") [--service worker] [--wait 10] 이름=값 …
#   예: --cmd "docker compose -f docker-compose.prod.yml logs --no-log-prefix worker" TRAFFIC_OBSERVE_SEC=4 AGENT_LLM_PROVIDER=mock GITOPS=off
# 비교는 설정값이 아니라 코드가 실제로 쓰는 유효값(value)으로 한다. 숫자는 숫자로 비교한다(4 와 4.0 같음). 값 비교만 하고 비밀값은 다루지 않는다(z81-10 줄에 비밀값이 없다).
# 끝 코드: 0 같음, 1 다름, 3 줄 없음(z81-10 전 이미지; 부른 쪽이 경고로 다룬다), 2 인자 잘못
import json, subprocess, sys, time

args = sys.argv[1:]
src_file = src_cmd = None; service = "worker"; wait = 10.0; want = {}
i = 0
while i < len(args):
    a = args[i]
    if a == "--file": src_file = args[i + 1]; i += 2
    elif a == "--cmd": src_cmd = args[i + 1]; i += 2
    elif a == "--service": service = args[i + 1]; i += 2
    elif a == "--wait": wait = float(args[i + 1]); i += 2
    elif "=" in a: k, v = a.split("=", 1); want[k] = v; i += 1
    else: print(f"모르는 인자: {a}", file=sys.stderr); sys.exit(2)
if not (src_file or src_cmd) or not want:
    print("--file 또는 --cmd, 그리고 이름=값 하나 이상", file=sys.stderr); sys.exit(2)

def read():
    try:
        if src_file: return open(src_file, encoding="utf-8", errors="replace").read()
        return subprocess.run(src_cmd, shell=True, capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""

def last_line(text):
    found = None
    for ln in text.splitlines():
        s = ln.find("{")
        if s < 0 or '"effective config"' not in ln: continue
        try: d = json.loads(ln[s:])
        except ValueError: continue
        if d.get("msg") == "effective config" and d.get("service") == service: found = d
    return found

def same(got, exp):
    try: return float(got) == float(exp)
    except (TypeError, ValueError): return str(got) == exp

t0 = time.time(); d = None
while True:
    d = last_line(read())
    if d or time.time() - t0 >= wait: break
    time.sleep(0.5)
el = time.time() - t0
if not d:
    print(f"유효 설정 줄 없음 ({service}, {el:.1f}초 기다림, z81-10 전 이미지일 수 있음)"); sys.exit(3)
cfg = d.get("config") or {}
bad, seen = [], []
for key, exp in want.items():
    # "이름.칸=값" 이면 value 대신 그 칸을 본다 (예: TRAFFIC_OBSERVE_SEC.floorApplied=false, z81-11). 칸이 없는 옛 줄이면 건너뜀
    k, _, field = key.partition(".")
    item = cfg.get(k) or {}
    if field and field not in item:
        seen.append(f"{key}=(없음, 건너뜀)"); continue
    got, src = item.get(field or "value"), item.get("source", "?")
    if isinstance(got, bool): got = "true" if got else "false"
    seen.append(f"{key}={got}")
    if not same(got, exp):
        hint = ""
        # 관찰 시간은 PROM_URL 이 있으면 코드가 최소 30 으로 올린다(guards.ts). 출처 문구로 어느 쪽인지 같이 알린다
        if k == "TRAFFIC_OBSERVE_SEC":
            pv = (cfg.get("PROM_URL") or {}).get("value")
            has = pv == "set" if pv else "PROM_URL" in str(src)
            hint = ", 워커에 PROM_URL 있음 → 최소 30" if has else ", 워커에 PROM_URL 없음"
        bad.append(f"{key}={got} (출처 {src}, 기대 {exp}{hint})")
if bad:
    print(f"FAIL 유효 설정 다름 ({service}, {el:.1f}초): " + "; ".join(bad)); sys.exit(1)
print(f"OK 유효 설정 ({service}, {el:.1f}초): " + " ".join(seen)); sys.exit(0)
