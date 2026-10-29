#!/usr/bin/env python3
"""
color-fixes.py — Task B3: replace banned indigo/blue UI accents with the
project emerald/teal/cyan palette. Brand colors (Telegram/Facebook share
buttons in agency-profile.tsx) are intentionally exempt.
Exact-match with expected-count assertions, idempotent like rtl-fixes.py.
"""
import sys

BASE = "/home/z/my-project/apps/web/src/"

FIXES = [
    # offline-diagnosis-panel — info/diagnostic accents blue → teal
    ("components/shared/offline-diagnosis-panel.tsx",
     'text-blue-500 animate-spin', 'text-teal-500 animate-spin', 1),
    ("components/shared/offline-diagnosis-panel.tsx",
     'border-blue-500/30 bg-blue-50 dark:bg-blue-950/20',
     'border-teal-500/30 bg-teal-50 dark:bg-teal-950/20', 1),
    ("components/shared/offline-diagnosis-panel.tsx",
     'bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800/50',
     'bg-teal-50 dark:bg-teal-950/20 border border-teal-200 dark:border-teal-800/50', 1),
    ("components/shared/offline-diagnosis-panel.tsx",
     'text-blue-700 dark:text-blue-400', 'text-teal-700 dark:text-teal-400', 1),
    ("components/shared/offline-diagnosis-panel.tsx",
     'text-blue-600 dark:text-blue-400', 'text-teal-600 dark:text-teal-400', 1),
    # platform-badge — iOS accent blue → cyan (distinct from other platforms)
    ("components/shared/platform-badge.tsx",
     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
     'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800', 1),
    ("components/shared/platform-badge.tsx",
     'bg-blue-50 text-blue-600/80 dark:bg-blue-900/20 dark:text-blue-400/70 border-blue-200/50 dark:border-blue-800/40',
     'bg-cyan-50 text-cyan-600/80 dark:bg-cyan-900/20 dark:text-cyan-400/70 border-cyan-200/50 dark:border-cyan-800/40', 1),
    # lib/platform.ts — iOS accent
    ("lib/platform.ts",
     "text-blue-600 bg-blue-100 dark:bg-blue-900/30",
     "text-cyan-600 bg-cyan-100 dark:bg-cyan-900/30", 1),
    # devices/types.tsx — TV board status → teal
    ("components/agency/devices/types.tsx",
     "color: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',",
     "color: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400',", 1),
    ("components/agency/devices/types.tsx",
     "dotColor: 'bg-blue-500',", "dotColor: 'bg-teal-500',", 1),
    # agency-history-sheet — entry types: blue→teal, indigo→cyan
    ("components/agency/agency-history-sheet.tsx",
     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
     'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 border-teal-200 dark:border-teal-800', 1),
    ("components/agency/agency-history-sheet.tsx",
     'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800',
     'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800', 1),
    # agency-devices — cast button gradient cyan/blue → cyan/teal
    ("components/agency/agency-devices.tsx",
     'from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600',
     'from-cyan-500 to-teal-500 hover:from-cyan-600 hover:to-teal-600', 1),
    # admin-payment-engine — recon accents → teal
    ("components/admin/admin-payment-engine.tsx",
     '<Link className="h-4 w-4 text-blue-600" />', '<Link className="h-4 w-4 text-teal-600" />', 1),
    ("components/admin/admin-payment-engine.tsx",
     'bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30',
     'bg-teal-50 dark:bg-teal-900/10 border border-teal-200 dark:border-teal-800/30', 1),
    ("components/admin/admin-payment-engine.tsx",
     '<DollarSign className="h-5 w-5 text-blue-600 mx-auto mb-1" />',
     '<DollarSign className="h-5 w-5 text-teal-600 mx-auto mb-1" />', 1),
    ("components/admin/admin-payment-engine.tsx",
     'text-blue-700 dark:text-blue-400', 'text-teal-700 dark:text-teal-400', 1),
    # admin-hardware-requests — status accents → teal
    ("components/admin/admin-hardware-requests.tsx",
     "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
     "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400", 1),
    ("components/admin/admin-hardware-requests.tsx",
     "bg-blue-500", "bg-teal-500", 1),
    ("components/admin/admin-hardware-requests.tsx",
     "from-blue-100 to-sky-100 dark:from-blue-900/40 dark:to-sky-900/30",
     "from-teal-100 to-cyan-100 dark:from-teal-900/40 dark:to-cyan-900/30", 1),
    ("components/admin/admin-hardware-requests.tsx",
     "bg-blue-600 hover:bg-blue-700", "bg-teal-600 hover:bg-teal-700", 1),
    # admin-payment-gateway-settings — bank info box → teal
    ("components/admin/admin-payment-gateway-settings.tsx",
     'bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800/30',
     'bg-teal-50/50 dark:bg-teal-900/10 border border-teal-100 dark:border-teal-800/30', 1),
    ("components/admin/admin-payment-gateway-settings.tsx",
     '<Building2 className="h-3.5 w-3.5 text-blue-600" />',
     '<Building2 className="h-3.5 w-3.5 text-teal-600" />', 1),
]

errors = 0
skipped = 0
for f, old, new, expected in FIXES:
    path = BASE + f
    src = open(path, encoding="utf-8").read()
    n = src.count(old)
    if n == 0 and new in src:
        skipped += 1
        continue
    if n != expected:
        print(f"COUNT MISMATCH: {f}: {old[:60]!r} expected {expected}, found {n}")
        errors += 1
        continue
    open(path, "w", encoding="utf-8").write(src.replace(old, new))
    print(f"OK {f}: {old[:52]!r}")

print(f"\n{'FAILED: ' + str(errors) if errors else 'ALL COLOR FIXES APPLIED'} ({len(FIXES)-skipped-errors} applied, {skipped} already done)")
sys.exit(1 if errors else 0)
