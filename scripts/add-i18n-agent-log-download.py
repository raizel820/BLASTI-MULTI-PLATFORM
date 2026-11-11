#!/usr/bin/env python3
# 0.6.65 — agent-log date-range + batch-download i18n keys (ar/en/fr).
# Inserts after the agentLogActionDictionaryDelete anchor in each file,
# then verifies every new key appears EXACTLY once per file.
import re, sys

BASE = "/home/z/my-project/apps/web/src/i18n"
ANCHOR = "agentLogActionDictionaryDelete"

ADD = {
    "ar": [
        "agentLogRange: \"النطاق الزمني\"",
        "agentLogRangeAll: \"كل الفترات\"",
        "agentLogRange1h: \"آخر ساعة\"",
        "agentLogRange24h: \"آخر 24 ساعة\"",
        "agentLogRange7d: \"آخر 7 أيام\"",
        "agentLogRange30d: \"آخر 30 يوماً\"",
        "agentLogDownloadHint: \"يُنزِّل كل السجلات المطابقة للمرشحات الحالية والنطاق الزمني دفعة واحدة (حتى 10000 سجل).\"",
        "agentLogDownloadReport: \"تقرير منسّق\"",
        "agentLogDownloaded: \"تم تنزيل التقرير\"",
        "agentLogActionLogsExport: \"تصدير السجلات\"",
    ],
    "en": [
        "agentLogRange: \"Date range\"",
        "agentLogRangeAll: \"All time\"",
        "agentLogRange1h: \"Last hour\"",
        "agentLogRange24h: \"Last 24 hours\"",
        "agentLogRange7d: \"Last 7 days\"",
        "agentLogRange30d: \"Last 30 days\"",
        "agentLogDownloadHint: \"Downloads EVERY log matching the current filters + date range in one file (up to 10,000 rows).\"",
        "agentLogDownloadReport: \"formatted report\"",
        "agentLogDownloaded: \"Report downloaded\"",
        "agentLogActionLogsExport: \"Logs export\"",
    ],
    "fr": [
        "agentLogRange: \"Période\"",
        "agentLogRangeAll: \"Tout\"",
        "agentLogRange1h: \"Dernière heure\"",
        "agentLogRange24h: \"Dernières 24 heures\"",
        "agentLogRange7d: \"Derniers 7 jours\"",
        "agentLogRange30d: \"Derniers 30 jours\"",
        "agentLogDownloadHint: \"Télécharge TOUTES les entrées correspondant aux filtres actuels et à la période en un seul fichier (10 000 max).\"",
        "agentLogDownloadReport: \"rapport formaté\"",
        "agentLogDownloaded: \"Rapport téléchargé\"",
        "agentLogActionLogsExport: \"Export des journaux\"",
    ],
}

ok = True
for lang, lines in ADD.items():
    path = f"{BASE}/{lang}.ts"
    with open(path, encoding="utf-8") as f:
        text = f.read()
    anchor_re = re.compile(rf"^(  {ANCHOR}: .*\",?)$", re.M)
    m = anchor_re.search(text)
    if not m:
        print(f"[{lang}] anchor NOT FOUND"); ok = False; continue
    block = "\n".join(f"  {line}," for line in lines)
    text = text[:m.end()] + "\n" + block + text[m.end():]
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    # verify count == 1 for every key
    for line in lines:
        key = line.split(":")[0]
        c = len(re.findall(rf"^\s+{key}:", text, re.M))
        if c != 1:
            print(f"[{lang}] {key} count={c} != 1"); ok = False
    print(f"[{lang}] +{len(lines)} keys OK")

sys.exit(0 if ok else 1)
