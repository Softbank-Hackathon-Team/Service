#!/usr/bin/env python3
"""뼈대 코드에서 명세 표를 뽑아 docs/contracts/*.md 의 GEN 블록을 다시 쓴다.

실행 (Service 레포 루트에서):
    python3 -I docs/contracts/tools/extract.py
다른 위치의 뼈대를 볼 때:
    python3 -I extract.py --root <뼈대 루트> --docs <문서 폴더>

- 사람이 쓴 문장은 건드리지 않는다. <!-- GEN:이름 --> 과 <!-- /GEN:이름 --> 사이만 바꾼다.
- contracts 스키마는 node + tsx 로 실제로 불러와서 뽑는다 (npm ci 가 돼 있어야 한다).
- --check 를 주면 파일을 쓰지 않고, 바뀔 블록 이름만 출력한다 (바뀌면 종료 코드 1).
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARKERS = ["DRAFT(ai)", "DECISION(team)", "STUB:", "TODO(human)"]
SCAN_DIRS = ["apps", "packages", "db", "infra", "gitops", "deploy", "tools"]
SKIP = {"node_modules", "dist", "schemas", ".git"}
SRC_EXT = {".ts", ".tsx", ".mjs", ".js", ".sql", ".tf", ".yaml", ".yml"}


# ---------- 공통 ----------
def src_files(root):
    for d in SCAN_DIRS:
        base = root / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and p.suffix in SRC_EXT and not (SKIP & set(p.parts)):
                yield p


def rel(root, p):
    return p.relative_to(root).as_posix()


def lineno(text, idx):
    return text.count("\n", 0, idx) + 1


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def table(head, rows):
    if not rows:
        return "_(없음)_"
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def call_span(text, start):
    """text[start] 가 '(' 일 때 짝이 맞는 ')' 까지 자른다."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return text[start:]


# ---------- contracts (node 로 실제 불러오기) ----------
def dump_contracts(root):
    cmd = ["node", "--import", "tsx", str(HERE / "dump-contracts.mjs"), str(root)]
    r = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("contracts 를 못 불러왔다. 뼈대 루트에서 npm ci 를 먼저 한다.\n" + r.stderr)
    return json.loads(r.stdout)


SAFE = 9007199254740991
ENUM_NAMES = {}


def short_type(s):
    if not isinstance(s, dict):
        return "아무거나"
    if isinstance(s.get("type"), list):
        ts = [t for t in s["type"] if t != "null"]
        base = short_type({**s, "type": ts[0]}) if ts else "null"
        return base + (" 또는 null" if "null" in s["type"] else "")
    if "anyOf" in s:
        parts = [short_type(x) for x in s["anyOf"]]
        if "null" in parts:
            parts = [p for p in parts if p != "null"]
            return " / ".join(parts) + " 또는 null"
        return " / ".join(parts)
    if "const" in s:
        v = s["const"]
        return (f'"{v}" 고정' if isinstance(v, str) else f"{v} 고정")
    if "enum" in s:
        key = tuple(s["enum"])
        if key in ENUM_NAMES:
            return f"`{ENUM_NAMES[key]}` 값 중 하나"
        return " · ".join(str(e) for e in s["enum"])
    t = s.get("type")
    if t == "string":
        f = s.get("format")
        if f == "uuid":
            return "uuid"
        if f in ("date-time", "uri"):
            return {"date-time": "시각(ISO 8601)", "uri": "URL"}[f]
        extra = []
        if "pattern" in s:
            extra.append(f'패턴 {s["pattern"]}')
        if "maxLength" in s:
            extra.append(f'최대 {s["maxLength"]}자')
        return "문자열" + (f' ({", ".join(extra)})' if extra else "")
    if t in ("integer", "number"):
        name = "정수" if t == "integer" else "숫자"
        rng = []
        if "minimum" in s and s["minimum"] != -SAFE:
            rng.append(f'{s["minimum"]} 이상')
        if "exclusiveMinimum" in s:
            rng.append(f'{s["exclusiveMinimum"]} 초과')
        if "maximum" in s and s["maximum"] != SAFE:
            rng.append(f'{s["maximum"]} 이하')
        return name + (f' ({", ".join(rng)})' if rng else "")
    if t == "boolean":
        return "참/거짓"
    if t == "null":
        return "null"
    if t == "array":
        mx = f', 최대 {s["maxItems"]}개' if "maxItems" in s else ""
        return f'배열<{short_type(s.get("items"))}>{mx}'
    if t == "object":
        if "properties" in s:
            return f'객체({len(s["properties"])}칸)'
        if "additionalProperties" in s:
            return f'맵<문자열, {short_type(s["additionalProperties"])}>'
        return "객체"
    return "아무거나"


def flatten(s, prefix="", req=True, depth=0):
    rows = []
    if not isinstance(s, dict):
        return rows
    props = s.get("properties", {})
    need = set(s.get("required", []))
    strict = s.get("additionalProperties") is False
    for k, v in props.items():
        path = f"{prefix}{k}"
        rows.append((path, short_type(v), "예" if (k in need and req) else "아니오"))
        inner = v
        if isinstance(v, dict) and v.get("type") == "array":
            inner = v.get("items", {})
            path += "[]"
        if isinstance(inner, dict) and "properties" in inner and depth < 3:
            rows += flatten(inner, path + ".", k in need and req, depth + 1)
    return rows


def schema_block(c, names):
    for k, v in c["schemas"].items():
        if isinstance(v, dict) and "enum" in v and len(v["enum"]) > 4:
            ENUM_NAMES[tuple(v["enum"])] = k
    out = []
    for n in names:
        s = c["schemas"].get(n)
        if s is None:
            out.append(f"#### `{n}`\n\n_(contracts 에 없음. 이름이 바뀌었나 확인)_")
            continue
        strict = "모르는 칸 거부(strict)" if s.get("additionalProperties") is False else "모르는 칸 허용"
        if "oneOf" in s or "anyOf" in s:
            variants = s.get("oneOf") or s.get("anyOf")
            rows = []
            for v in variants:
                t = v.get("properties", {}).get("type", {}).get("const", "?")
                fields = [k for k in v.get("properties", {}) if k != "type"]
                rows.append((f"`{t}`", ", ".join(fields) or "-"))
            out.append(f"#### `{n}` (종류 {len(rows)}개 중 하나)\n\n" + table(["type", "칸"], rows))
            continue
        if "enum" in s:
            out.append(f"#### `{n}` (값 {len(s['enum'])}개)\n\n" + " · ".join(f"`{e}`" for e in s["enum"]))
            continue
        if "additionalProperties" in s and "properties" not in s:
            out.append(f"#### `{n}`\n\n{short_type(s)}. 값 한 칸의 모양은 아래와 같다.\n\n"
                       + table(["칸", "모양", "꼭 있나"], flatten(s["additionalProperties"])))
            continue
        out.append(f"#### `{n}` ({strict})\n\n"
                   + table(["칸", "모양", "꼭 있나"], [(f"`{a}`", b, r) for a, b, r in flatten(s)]))
    return "\n\n".join(out)


# ---------- API 경로 ----------
def routes(root):
    rows = []
    for p in src_files(root):
        if "apps/" not in rel(root, p) or p.suffix != ".ts":
            continue
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r'\b(?:r|app)\.(get|post|put|patch|delete)\(\s*"([^"]+)"', text):
            span = call_span(text, text.index("(", m.start()))
            body = re.search(r"body:\s*([A-Za-z_][\w.]*)", span)
            params = re.search(r"params:\s*z\.object\(\{([^}]*)\}", span)
            code = re.search(r"reply\.code\((\d{3})\)", span)
            before = text[:m.start()].rstrip().splitlines()
            note = before[-1].strip()[2:].strip() if before and before[-1].strip().startswith("//") else ""
            rows.append(dict(
                method=m.group(1).upper(), path=m.group(2),
                body=body.group(1) if body else "-",
                params=(params.group(1).strip() if params else "-"),
                code=code.group(1) if code else "200",
                note=note, where=f"{rel(root, p)}:{lineno(text, m.start())}"))
    return rows


def error_codes(root):
    rows = []
    for p in src_files(root):
        if p.suffix != ".ts":
            continue
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r"class (\w+) extends DomainError[\s\S]*?super\((\d{3}),\s*\"(\w+)\"", text):
            rows.append((m.group(3), m.group(2), f"`{m.group(1)}`", f"{rel(root, p)}:{lineno(text, m.start())}"))
        for m in re.finditer(r"status:\s*(\d{3}),\s*code:\s*\"(\w+)\"", text):
            rows.append((m.group(2), m.group(1), "응답 직접", f"{rel(root, p)}:{lineno(text, m.start())}"))
    seen, uniq = set(), []
    for r in rows:
        if r[0] not in seen:
            seen.add(r[0])
            uniq.append(r)
    return uniq


# ---------- 상태 이동과 큐 ----------
def advance_calls(root):
    rows = []
    for p in src_files(root):
        if p.suffix != ".ts" or "packages/core/src/advance.ts" in rel(root, p):
            continue
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r"\badvance\(", text):
            span = call_span(text, m.end() - 1)
            st = re.findall(r'"(\w+)"', span)
            q = re.search(r"queue:\s*QUEUES\.(\w+)", span)
            actor = re.search(r'actor:\s*([^,}]+)', span)
            if len(st) >= 2:
                rows.append(dict(frm=st[0], to=st[1], queue=q.group(1) if q else None,
                                 actor=actor.group(1).strip() if actor else "?",
                                 mode="ifStill" if "ifStill" in span else "strict",
                                 where=f"{rel(root, p)}:{lineno(text, m.start())}"))
    return rows


def workers(root, queues):
    consts, regs = {}, {}
    files = [p for p in src_files(root) if p.suffix == ".ts" and "apps/" in rel(root, p)]
    for p in files:
        for m in re.finditer(r"export const (\w+) = QUEUES\.(\w+)", p.read_text(encoding="utf-8")):
            consts[m.group(1)] = m.group(2)
    for p in files:
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r"boss\.work\(\s*([\w.\"-]+)", text):
            a = m.group(1)
            key = a.split(".", 1)[1] if a.startswith("QUEUES.") else consts.get(a)
            if key is None and a.startswith('"'):
                key = next((k for k, v in queues.items() if v == a.strip('"')), a)
            regs[key] = f"{rel(root, p)}:{lineno(text, m.start())}"
    return regs


def policies(root):
    p = root / "packages/core/src/boss.ts"
    out, default = {}, None
    if p.exists():
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r'\[QUEUES\.(\w+)\]:\s*\{\s*policy:\s*"(\w+)",\s*retryLimit:\s*(\d+)', text):
            out[m.group(1)] = (m.group(2), m.group(3))
        d = re.search(r'\?\?\s*\{\s*policy:\s*"(\w+)",\s*retryLimit:\s*(\d+)', text)
        default = (d.group(1), d.group(2)) if d else None
    return out, default


# ---------- DB 표 ----------
def sql_tables(root):
    tables, rls, grants = {}, [], []
    for p in sorted((root / "db/migrations").glob("*.sql")):
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r"CREATE TABLE (\w+) \(([\s\S]*?)\n\);", text):
            cols = []
            for line in m.group(2).splitlines():
                line = line.strip()
                if not line or line.startswith(("UNIQUE", "PRIMARY KEY", "CHECK", "--")):
                    if line.startswith("UNIQUE"):
                        cols.append(("(묶음 규칙)", line.rstrip(","), "", ""))
                    continue
                comment = ""
                if "--" in line:
                    line, comment = line.split("--", 1)
                    line, comment = line.strip(), comment.strip()
                line = line.rstrip(",")
                parts = line.split(None, 1)
                name, rest = parts[0], parts[1] if len(parts) > 1 else ""
                typ = rest.split()[0] if rest else ""
                rules = rest[len(typ):].strip()
                cols.append((f"`{name}`", typ, rules, comment))
            tables[m.group(1)] = (cols, f"{rel(root, p)}:{lineno(text, m.start())}")
        a = re.search(r"FOREACH t IN ARRAY ARRAY\[([^\]]+)\]", text)
        if a:
            rls += [x.strip(" '") for x in a.group(1).split(",")]
        for g in re.finditer(r"^GRANT ([^;]+);", text, re.M):
            grants.append(g.group(1))
    return tables, rls, grants


# ---------- 마커 ----------
def markers(root):
    rows, implicit = [], []
    pat = re.compile("|".join(re.escape(m) for m in MARKERS))
    hint = re.compile(r"뼈대|가짜|자리만|임시")
    for p in src_files(root):
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            m = pat.search(line)
            if m:
                kind = m.group(0).rstrip(":")
                rows.append((kind, f"{rel(root, p)}:{i}", line.strip()[line.strip().find(m.group(0)):]))
            elif hint.search(line) and ("//" in line or "--" in line):
                implicit.append((f"{rel(root, p)}:{i}", line.strip()))
    return rows, implicit


# ---------- 블록 만들기 ----------
def build(root):
    c = dump_contracts(root)
    Q = c["consts"].get("QUEUES", {})
    VALID = c["consts"].get("VALID", {})
    STATUSES = c["consts"].get("MIGRATION_STATUSES", [])
    TERMINAL = c["consts"].get("TERMINAL", [])
    adv = advance_calls(root)
    regs = workers(root, Q)
    pol, pdef = policies(root)
    rts = routes(root)
    tables, rls, grants = sql_tables(root)
    mk, implicit = markers(root)
    done = {(a["frm"], a["to"]) for a in adv}
    B = {}

    # api.md
    B["routes"] = table(["방법", "경로", "입력", "성공 코드", "하는 일 (코드 주석)", "코드 위치"],
                        [(r["method"], f'`{r["path"]}`',
                          ((f'본문 `{r["body"]}`' if r["body"] != "-" else "")
                           + (f' 경로값 `{r["params"]}`' if r["params"] != "-" else "")).strip() or "-",
                          r["code"], r["note"] or "-", r["where"]) for r in rts])
    have = {(r["method"], r["path"]) for r in rts}
    planned = []
    tsv = HERE / "planned-routes.tsv"
    if tsv.exists():
        for line in tsv.read_text(encoding="utf-8").splitlines():
            if line.startswith("#") or not line.strip():
                continue
            m_, path, area, summ = (line.split("\t") + ["", "", "", ""])[:4]
            planned.append((m_, f"`{path}`", area, summ,
                            "있음" if (m_, path) in have else "없음"))
    extra = [(r["method"], f'`{r["path"]}`', "-", "명세 목록에 없는 경로", "있음")
             for r in rts if (r["method"], r["path"]) not in
             {(a, b.strip("`")) for a, b, *_ in planned}]
    B["planned"] = (f"명세 목록 {len(planned)}개 중 코드에 있는 것 "
                    f"{sum(1 for x in planned if x[4] == '있음')}개.\n\n"
                    + table(["방법", "경로", "영역", "하는 일", "코드"], planned + extra))
    B["errors"] = table(["code", "HTTP", "만드는 곳", "코드 위치"], error_codes(root))

    # state-machine.md
    B["statuses"] = (f"상태 {len(STATUSES)}개, 갈 수 있는 길 {sum(len(v) for v in VALID.values())}개, "
                     f"끝난 상태 {len(TERMINAL)}개 ({', '.join(f'`{t}`' for t in TERMINAL)}).")
    rows = []
    for s in STATUSES:
        tos = VALID.get(s, [])
        mark = ", ".join(f"`{t}`" + (" (코드 있음)" if (s, t) in done else "") for t in tos)
        rows.append((f"`{s}`", len(tos), mark or "끝 (더 갈 곳 없음)"))
    B["transitions"] = table(["지금 상태", "갈 수 있는 수", "갈 수 있는 상태"], rows)
    B["advance_calls"] = table(["이동", "부르는 쪽", "같이 넣는 큐 작업", "모드", "코드 위치"],
                               [(f'`{a["frm"]}` 에서 `{a["to"]}`', a["actor"],
                                 f'`{Q.get(a["queue"], a["queue"])}`' if a["queue"] else "-",
                                 a["mode"], a["where"]) for a in adv])

    # jobs.md
    rows = []
    for key, name in Q.items():
        js = c["jobSchemas"].get(name, "-")
        p = pol.get(key)
        polcell = f"{p[0]}, 재시도 {p[1]}" if p else (f"(기본값) {pdef[0]}, 재시도 {pdef[1]}" if pdef else "-")
        prod = [a["where"] for a in adv if a["queue"] == key]
        rows.append((f"`{name}`", f"`{js}`" if js != "-" else "없음", polcell,
                     ", ".join(prod) or "없음", regs.get(key, "없음")))
    B["queues"] = table(["큐", "작업 내용 모양", "큐 정책", "넣는 코드", "처리 코드"], rows)
    B["job_schemas"] = schema_block(c, sorted({v for v in c["jobSchemas"].values()} | {"JobBase"}))

    # data-model.md
    parts = []
    for name, (cols, where) in tables.items():
        parts.append(f"#### `{name}` ({where}{', 회사 벽 켜짐' if name in rls else ''})\n\n"
                     + table(["칸", "타입", "규칙", "주석"], cols))
    B["tables"] = "\n\n".join(parts)
    B["rls"] = ("회사 벽(RLS)이 켜진 표: " + ", ".join(f"`{t}`" for t in rls) + "\n\n"
                + "\n".join(f"- `GRANT {g}`" for g in grants))
    B["schemas_spec"] = schema_block(c, ["AppSpec", "FieldMetaEntry", "ImportResult"])
    B["schemas_env"] = schema_block(c, ["Provider", "ConnectionStatus", "EnvironmentView", "ConnectionLink"])
    B["schemas_migration"] = schema_block(c, ["MigrationStatus", "MigrationView"])
    B["schemas_plan"] = schema_block(c, ["PrecheckItem", "PlanStep", "PlanDoc", "ApprovalInput"])
    B["schemas_events"] = schema_block(c, ["NotifyMigration", "SseEvent", "InfraReady"])
    B["schemas_results"] = schema_block(c, ["DeployResult", "TrafficJudgement", "Finding", "MatrixCell",
                                            "GuardrailEvent", "AgentFinish", "Measurement", "ApiError"])

    # open-items.md
    B["markers"] = (table(["표시", "코드 위치", "내용"], mk) if mk
                    else "_코드에 아직 이 표시가 한 건도 없다._")
    B["implicit"] = table(["코드 위치", "주석"], implicit)
    counts = {m.rstrip(":"): sum(1 for r in mk if r[0] == m.rstrip(":")) for m in MARKERS}
    B["marker_counts"] = " · ".join(f"`{k}` {v}건" for k, v in counts.items())
    no_prod = [n for k, n in Q.items() if not any(a["queue"] == k for a in adv)]
    no_work = [n for k, n in Q.items() if k not in regs]
    B["gaps"] = "\n".join([
        f"- 상태 이동 {sum(len(v) for v in VALID.values())}개 중 코드가 있는 것: {len(done)}개",
        f"- 큐 {len(Q)}개 중 작업을 넣는 코드가 있는 것: {len(Q) - len(no_prod)}개",
        f"- 큐 {len(Q)}개 중 처리 코드가 있는 것: {len(Q) - len(no_work)}개",
        f"- API 경로 수: {len(rts)}개",
        f"- contracts 스키마 수: {len(c['schemas'])}개 (JSON Schema 로 내보내는 것은 export-json-schema.ts 목록 기준)",
        f"- DB 표 수: {len(tables)}개",
    ])
    return B


def apply(docs, blocks, check):
    changed = []
    for md in sorted(docs.glob("*.md")):
        text = md.read_text(encoding="utf-8")
        new = text
        for name, body in blocks.items():
            new = re.sub(rf"(<!-- GEN:{name} -->)[\s\S]*?(<!-- /GEN:{name} -->)",
                         lambda m: m.group(1) + "\n" + body + "\n" + m.group(2), new)
        if new != text:
            changed.append(md.name)
            if not check:
                md.write_text(new, encoding="utf-8")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(HERE.parents[2]))
    ap.add_argument("--docs", default=str(HERE.parent))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    root, docs = Path(a.root).resolve(), Path(a.docs).resolve()
    if not (root / "packages/contracts").exists():
        sys.exit(f"{root} 에 packages/contracts 가 없다. --root 로 뼈대 루트를 준다.")
    changed = apply(docs, build(root), a.check)
    print(("바뀔 문서: " if a.check else "다시 쓴 문서: ") + (", ".join(changed) or "없음"))
    sys.exit(1 if (a.check and changed) else 0)


if __name__ == "__main__":
    main()
