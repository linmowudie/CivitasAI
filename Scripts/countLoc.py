# 统计代码量：按语言与模块汇总「代码 / 注释 / 空白」行数（默认仅核心业务代码）
# 用法: python Scripts/countLoc.py [目录...] [--all] [--top N] [--json] [--files]

import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 核心业务代码 = 产品源码，剔除测试 / 脚本工具 / 基准 / Electron 壳 / 根目录配置
CORE_SCOPE = ["Src", "Client/src", "Server/src/main/java"]
ALL_SCOPE = ["Client", "Src", "Server", "electron", "Tests", "Benchmarks", "Scripts"]

EXCLUDE_DIRS = {
    "node_modules", "dist", "build", "target", "out", "coverage", "release",
    ".git", ".husky", ".vite", ".turbo", ".next", "logs", "public",
}

TEST_FILE_RE = re.compile(r"\.(spec|test)\.[jt]sx?$", re.IGNORECASE)
TEST_DIR_RE = re.compile(r"(^|/)(__tests__|tests)(/|$)", re.IGNORECASE)

# 与 JS /\s/ 同语义的空白集（含 \ufeff，行首 BOM 按空白处理；不含 \x1c-\x1f、\x85）
JS_SPACE = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
JS_SPACE_SET = frozenset(JS_SPACE)

LANGUAGES = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".java": "Java",
    ".js": "JavaScript",
    ".cjs": "JavaScript",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".ps1": "PowerShell",
    ".sh": "Shell",
    ".css": "CSS",
    ".scss": "SCSS",
    ".html": "HTML",
    ".sql": "SQL",
}

# 各语言注释/字符串词法：注释识别排除字符串字面量，支持跨行块注释
FLAVORS = {
    "TypeScript": {"line": ("//",), "block": ("/*", "*/"), "strings": ("'", '"', "`")},
    "JavaScript": {"line": ("//",), "block": ("/*", "*/"), "strings": ("'", '"', "`")},
    "Java": {"line": ("//",), "block": ("/*", "*/"), "strings": ("'", '"')},
    "Python": {"line": ("#",), "block": None, "strings": ("'", '"')},
    "PowerShell": {"line": ("#",), "block": ("<#", "#>"), "strings": ("'", '"')},
    "Shell": {"line": ("#",), "block": None, "strings": ("'", '"')},
    "CSS": {"line": (), "block": ("/*", "*/"), "strings": ()},
    "SCSS": {"line": ("//",), "block": ("/*", "*/"), "strings": ("'", '"')},
    "HTML": {"line": (), "block": ("<!--", "-->"), "strings": ()},
    "SQL": {"line": ("--",), "block": ("/*", "*/"), "strings": ("'",)},
}


def scan_file(text, flavor):
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in lines]
    blank = comment = code = 0
    state = "code"  # code | line | block | string
    close_tok = None
    quote = ""
    for raw in lines:
        if state == "line":
            state = "code"
        if raw.strip(JS_SPACE) == "":
            blank += 1
            continue
        has_code = has_comment = False
        i = 0
        while i < len(raw):
            if state == "line":
                has_comment = True
                break
            if state == "block":
                has_comment = True
                if raw.startswith(close_tok, i):
                    i += len(close_tok)
                    state = "code"
                    close_tok = None
                else:
                    i += 1
                continue
            if state == "string":
                has_code = True
                ch = raw[i]
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    state = "code"
                    quote = ""
                i += 1
                continue
            ch = raw[i]
            if ch in JS_SPACE_SET:
                i += 1
                continue
            lt = next((t for t in flavor["line"] if raw.startswith(t, i)), None)
            if lt is not None:
                has_comment = True
                state = "line"
                i += len(lt)
                continue
            if flavor["block"] and raw.startswith(flavor["block"][0], i):
                has_comment = True
                state = "block"
                close_tok = flavor["block"][1]
                i += len(flavor["block"][0])
                continue
            if ch in flavor["strings"]:
                has_code = True
                state = "string"
                quote = ch
                i += 1
                continue
            has_code = True
            i += 1
        if has_code:
            code += 1
        elif has_comment:
            comment += 1
        else:
            blank += 1
    return {"total": len(lines), "code": code, "comment": comment, "blank": blank}


def walk_files(dir_path, out):
    try:
        with os.scandir(dir_path) as entries:
            items = list(entries)
    except OSError:
        return
    for e in items:
        if e.is_dir(follow_symlinks=False):
            if e.name in EXCLUDE_DIRS:
                continue
            walk_files(e.path, out)
        elif e.is_file(follow_symlinks=False):
            if os.path.splitext(e.name)[1].lower() in LANGUAGES:
                out.append(e.path)


def is_test_path(rel):
    return bool(TEST_FILE_RE.search(rel) or TEST_DIR_RE.search(rel))


def module_of(rel):
    i = rel.find("/")
    return "(root)" if i == -1 else rel[:i]


def disp_width(s):
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in s)


def pad(s, width, align):
    d = max(0, width - disp_width(s))
    return (" " * d + s) if align == "right" else (s + " " * d)


def print_table(headers, rows, aligns):
    widths = [max([disp_width(h)] + [disp_width(str(r[i])) for r in rows]) for i, h in enumerate(headers)]
    def render(cells):
        return "  ".join(pad(str(c), widths[i], aligns[i]) for i, c in enumerate(cells))
    print(render(headers))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print(render(r))


def usage():
    print("用法: python Scripts/countLoc.py [目录...] [--all] [--top N] [--json] [--files]")
    print("  默认统计核心业务代码: Src + Client/src + Server/src/main/java（剔除测试文件）")
    print("  --all    统计全部: Client Src Server electron Tests Benchmarks Scripts 及根目录源码")
    print("  目录...  自定义统计范围（替代上述模式）")
    print("  --top N  额外列出代码行数最多的 N 个文件")
    print("  --json   以 JSON 输出统计结果")
    print("  --files  仅输出纳入统计的文件清单（每行一个相对路径）")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    argv = sys.argv[1:]
    json_out = files_only = use_all = False
    top_n = 0
    dir_args = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            json_out = True
        elif a == "--files":
            files_only = True
        elif a == "--all":
            use_all = True
        elif a == "--top":
            i += 1
            try:
                top_n = int(argv[i])
            except (IndexError, ValueError):
                top_n = 0
        elif a in ("-h", "--help"):
            usage()
            return
        else:
            dir_args.append(a)
        i += 1

    if dir_args:
        mode, rel_scope = "custom", dir_args
    elif use_all:
        mode, rel_scope = "all", ALL_SCOPE
    else:
        mode, rel_scope = "core", CORE_SCOPE

    warnings = []
    targets = []
    for s in rel_scope:
        abs_p = os.path.abspath(os.path.join(ROOT, s))
        if os.path.isdir(abs_p) or os.path.isfile(abs_p):
            targets.append(abs_p)
        else:
            warnings.append(f"跳过不存在的路径: {s}")
    if mode == "all":
        with os.scandir(ROOT) as entries:
            for e in entries:
                if e.is_file() and os.path.splitext(e.name)[1].lower() in LANGUAGES:
                    targets.append(e.path)

    per_file = []
    for t in targets:
        found = []
        if os.path.isdir(t):
            walk_files(t, found)
        elif os.path.splitext(t)[1].lower() in LANGUAGES:
            found.append(t)
        for abs_p in found:
            rel = os.path.relpath(abs_p, ROOT).replace(os.sep, "/")
            if mode == "core" and is_test_path(rel):
                continue
            lang = LANGUAGES[os.path.splitext(abs_p)[1].lower()]
            try:
                # newline="" 关闭 universal newlines：仅 \n 断行、行尾至多剥一个 \r（与 Node /\r?\n/ 口径一致）
                with open(abs_p, "r", encoding="utf-8", errors="replace", newline="") as fh:
                    text = fh.read()
            except OSError as err:
                warnings.append(f"读取失败: {rel} ({err})")
                continue
            per_file.append({"path": rel, "lang": lang, **scan_file(text, FLAVORS[lang])})

    if not per_file:
        print("未找到可统计的源码文件")
        return

    if files_only:
        for f in sorted(per_file, key=lambda x: x["path"]):
            print(f["path"])
        return

    by_lang = {}
    by_mod = {}
    totals = {"files": 0, "code": 0, "comment": 0, "blank": 0, "total": 0}

    def add(m, key, f):
        v = m.setdefault(key, {"files": 0, "code": 0, "comment": 0, "blank": 0, "total": 0})
        v["files"] += 1
        for k in ("code", "comment", "blank", "total"):
            v[k] += f[k]

    for f in per_file:
        add(by_lang, f["lang"], f)
        add(by_mod, module_of(f["path"]), f)
        totals["files"] += 1
        for k in ("code", "comment", "blank", "total"):
            totals[k] += f[k]

    top_files = sorted(per_file, key=lambda x: (-x["code"], x["path"]))[:top_n]

    if json_out:
        sort_map = lambda m: {k: m[k] for k in sorted(m, key=lambda k: -m[k]["code"])}
        print(json.dumps({
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": mode,
            "root": ROOT,
            "scope": [os.path.relpath(t, ROOT).replace(os.sep, "/") or "." for t in targets],
            "totals": totals,
            "byLanguage": sort_map(by_lang),
            "byModule": sort_map(by_mod),
            "topFiles": [{"path": f["path"], "lang": f["lang"], "code": f["code"], "total": f["total"]} for f in top_files],
        }, ensure_ascii=False, indent=2))
        return

    title = {"core": "核心业务代码统计", "all": "全部代码统计", "custom": "代码量统计"}[mode]
    print(f"CivitasAI {title}  ({datetime.now().strftime('%Y-%m-%d')})")
    print(f"统计范围: {', '.join(os.path.relpath(t, ROOT).replace(os.sep, '/') or '.' for t in targets)}")
    for w in warnings:
        print(f"[warn] {w}")
    print()

    n = lambda v: f"{v:,}"
    lang_rows = [
        [lang, n(v["files"]), n(v["code"]), n(v["comment"]), n(v["blank"]), n(v["total"]),
         f"{v['code'] / totals['code'] * 100:.1f}%"]
        for lang, v in sorted(by_lang.items(), key=lambda kv: -kv[1]["code"])
    ]
    lang_rows.append(["合计", n(totals["files"]), n(totals["code"]), n(totals["comment"]), n(totals["blank"]), n(totals["total"]), "100%"])
    print_table(["语言", "文件数", "代码行", "注释行", "空白行", "总行数", "代码占比"], lang_rows,
                ["left", "right", "right", "right", "right", "right", "right"])

    print()
    mod_rows = [
        [mod, n(v["files"]), n(v["code"]), n(v["comment"]), n(v["blank"]), n(v["total"])]
        for mod, v in sorted(by_mod.items(), key=lambda kv: -kv[1]["code"])
    ]
    print_table(["模块", "文件数", "代码行", "注释行", "空白行", "总行数"], mod_rows,
                ["left", "right", "right", "right", "right", "right"])

    if top_files:
        print()
        print(f"代码行数 Top {len(top_files)}:")
        for idx, f in enumerate(top_files, 1):
            print(f"  {idx:>2}. {f['path']}  (代码 {n(f['code'])} / 总行 {n(f['total'])})")

    print()
    if mode == "core":
        print("口径: 核心业务代码 = Src + Client/src + Server/src/main/java；已剔除测试（*.spec/*.test、src/test、__tests__）、")
        print("      脚本工具/基准/Electron 壳/根目录配置。注释按词法识别，字符串字面量内的注释符不计入。")
    else:
        print("口径: 注释按语言词法识别（// # -- 及块注释），字符串字面量内的注释符不计入注释；.json/.md/.yml 等非代码文件不统计。")


if __name__ == "__main__":
    main()
