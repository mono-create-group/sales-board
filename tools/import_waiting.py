#!/usr/bin/env python3
"""ハンドルの一覧(1行1件・@付き可・md/txt可)から、未登録のハンドルだけを waiting として sales_candidates に追加する。
作成のみ(exists=false)。登録済みのハンドルは上書きしない。--apply が無ければ dry-run。
使い方: python3 tools/import_waiting.py <handles.txt> [--source sales-list] [--apply]
"""
import argparse, json, re, subprocess, sys, urllib.request, urllib.error
from datetime import datetime, timezone
P = "editflow-mono-create"
DOCS = f"projects/{P}/databases/(default)/documents"
URL = f"https://firestore.googleapis.com/v1/{DOCS}"

def doc_id(h): return "~" + h if h.startswith("__") and h.endswith("__") else h
def tok(): return subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()
def call(u, body, t):
    r = urllib.request.Request(u, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + t, "Content-Type": "application/json", "x-goog-user-project": P})
    return json.load(urllib.request.urlopen(r))

ap = argparse.ArgumentParser(); ap.add_argument("file"); ap.add_argument("--source", default="sales-list"); ap.add_argument("--apply", action="store_true")
a = ap.parse_args()
hs = []
for m in re.finditer(r"@?([A-Za-z0-9_.]{2,30})", open(a.file, encoding="utf-8").read()):
    h = m.group(1).lower()
    if h not in hs and not h.startswith("."): hs.append(h)
print(f"ハンドル候補 {len(hs)} 件")
if not a.apply: print("(dry-run) --apply で書きます"); sys.exit(0)
t = tok(); now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"); made = skipped = 0
for h in hs:
    f = {"handle": {"stringValue": "@" + h}, "status": {"stringValue": "waiting"}, "source": {"stringValue": a.source}, "updatedAt": {"timestampValue": now}}
    try:
        call(f"{URL}:commit", {"writes": [{"update": {"name": f"{DOCS}/sales_candidates/{doc_id(h)}", "fields": f}, "currentDocument": {"exists": False}}]}, t); made += 1
    except urllib.error.HTTPError as e:
        if "ALREADY_EXISTS" in e.read().decode(): skipped += 1
        else: raise
print(f"追加 {made} 件 / 登録済みのため触らず {skipped} 件")
