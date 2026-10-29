#!/usr/bin/env python3
"""
dark-mode-sweep.py — Task B1: add dark: counterparts to light-only color
utilities in apps/web/src JSX className strings.

Mechanical, conservative rules (per className="..." string):
  bg-white        (no dark:bg-*)        -> + dark:bg-gray-900
  bg-gray-50      (no dark:bg-*)        -> + dark:bg-gray-900/50
  bg-gray-100     (no dark:bg-*)        -> + dark:bg-gray-800
  text-gray-900   (no dark:text-*)      -> + dark:text-gray-100
  text-gray-800   (no dark:text-*)      -> + dark:text-gray-200
  text-gray-700   (no dark:text-*)      -> + dark:text-gray-300
  text-gray-600   (no dark:text-*)      -> + dark:text-gray-400
  text-gray-500   (no dark:text-*)      -> + dark:text-gray-400
  text-black      (no dark:text-*)      -> + dark:text-white
  border-gray-100 (no dark:border-*)    -> + dark:border-gray-800
  border-gray-200 (no dark:border-*)    -> + dark:border-gray-700
  border-gray-300 (no dark:border-*)    -> + dark:border-gray-600

The guard is per-class-string: strings that already carry ANY sibling
dark:bg- / dark:text- / dark:border- of the same kind are skipped (they were
authored dark-aware). Scoped variants (hover:, md:, sm:) of the target class
are NOT touched — only bare utilities, to avoid altering authored behavior.

Usage:
  python3 scripts/ui-audit/dark-mode-sweep.py --dry-run   # report only
  python3 scripts/ui-audit/dark-mode-sweep.py --apply     # write changes
"""
import re
import sys
import os

ROOT = "/home/z/my-project/apps/web/src"

# rule: (pattern, replacement, guard-regex that must NOT exist in the class string)
RULES = [
    (r'(?<![-\w:])bg-white(?![\w/-])', 'bg-white dark:bg-gray-900', r'dark:bg-'),
    (r'(?<![-\w:])bg-gray-50(?![\w/-])', 'bg-gray-50 dark:bg-gray-900/50', r'dark:bg-'),
    (r'(?<![-\w:])bg-gray-100(?![\w/-])', 'bg-gray-100 dark:bg-gray-800', r'dark:bg-'),
    (r'(?<![-\w:])text-gray-900(?![\w/-])', 'text-gray-900 dark:text-gray-100', r'dark:text-'),
    (r'(?<![-\w:])text-gray-800(?![\w/-])', 'text-gray-800 dark:text-gray-200', r'dark:text-'),
    (r'(?<![-\w:])text-gray-700(?![\w/-])', 'text-gray-700 dark:text-gray-300', r'dark:text-'),
    (r'(?<![-\w:])text-gray-600(?![\w/-])', 'text-gray-600 dark:text-gray-400', r'dark:text-'),
    (r'(?<![-\w:])text-gray-500(?![\w/-])', 'text-gray-500 dark:text-gray-400', r'dark:text-'),
    (r'(?<![-\w:])text-black(?![\w/-])', 'text-black dark:text-white', r'dark:text-'),
    (r'(?<![-\w:])border-gray-100(?![\w/-])', 'border-gray-100 dark:border-gray-800', r'dark:border-'),
    (r'(?<![-\w:])border-gray-200(?![\w/-])', 'border-gray-200 dark:border-gray-700', r'dark:border-'),
    (r'(?<![-\w:])border-gray-300(?![\w/-])', 'border-gray-300 dark:border-gray-600', r'dark:border-'),
]

# Class-string extractor: matches "..." / '...' / `...` after className=
CLASS_RE = re.compile(r'(className\s*=\s*)(["\'`])(.*?)\2', re.S)

def process_file(path, apply):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    changes = 0

    def repl(m):
        nonlocal changes
        prefix, quote, cls = m.group(1), m.group(2), m.group(3)
        if '\n' in cls:
            return m.group(0)  # skip multi-expression template strings
        new_cls = cls
        for pat, rep, guard in RULES:
            if re.search(pat, new_cls) and not re.search(guard, new_cls):
                new_cls = re.sub(pat, rep, new_cls)
        if new_cls != cls:
            changes += 1
        return f'{prefix}{quote}{new_cls}{quote}'

    out = CLASS_RE.sub(repl, src)
    if apply and changes:
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
    return changes


def main():
    apply = "--apply" in sys.argv
    total_files = 0
    total_changes = 0
    report = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".next")]
        for fn in filenames:
            if not fn.endswith((".tsx", ".ts")):
                continue
            p = os.path.join(dirpath, fn)
            n = process_file(p, apply)
            if n:
                total_files += 1
                total_changes += n
                report.append((n, os.path.relpath(p, ROOT)))
    mode = "APPLIED" if apply else "WOULD APPLY"
    print(f"{mode}: {total_changes} class-string changes across {total_files} files")
    for n, p in sorted(report, reverse=True)[:30]:
        print(f"  {n:4d}  {p}")

if __name__ == "__main__":
    main()
