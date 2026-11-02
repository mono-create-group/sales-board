#!/usr/bin/env python3
"""ミューズ側の送信済みハンドル一覧（sent-handles.txt）と台帳の waiting を突き合わせ、送信済みなら sent に直す。

  - 直すのは status と送信日時(sentAt があれば)・sentBy だけの部分更新（updateMask）。他の項目は消さない・触らない
  - 読んだ時点の updateTime を前提条件にするので、その間に誰かが更新していたら書かない（上書きしない）
  - blocklist（--blocklist）のハンドルが waiting なら、直さずに一覧にして出すだけ
  - 台帳に無いハンドルは作らない（一覧に出すだけ）
  - --apply が無ければ dry-run

使い方: python3 tools/reconcile_sent.py <sent-handles.txt> [--blocklist <blocklist-handles.txt>] [--apply]
  sent-handles.txt は 1行1ハンドル（@付き可）。「@handle 2026-11-01T12:30:00+09:00」のように時刻が続く行は、その時刻を sentAt に入れる
"""
import argparse, json, re, subprocess, sys, urllib.request, urllib.error
from datetime import datetime, timezone

P = "editflow-mono-create"
DOCS = f"projects/{P}/databases/(default)/documents"
BASE = f"https://firestore.googleapis.com/v1/{DOCS}"

def tok(): return subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()
def call(url, tk, body=None):
    r = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + tk, "Content-Type": "application/json", "x-goog-user-project": P})
    return json.load(urllib.request.urlopen(r))
def doc_id(h): return "~" + h if h.startswith("__") and h.endswith("__") else h
def parse(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"\s*@?([A-Za-z0-9_.]{2,30})\b\s*[,\s]*(\d{4}-\d\d-\d\d[T ][\d:.+\-Z]+)?", line)
        if m: out.setdefault(m.group(1).lower(), m.group(2))
    return out

ap = argparse.ArgumentParser(); ap.add_argument("sent"); ap.add_argument("--blocklist"); ap.add_argument("--apply", action="store_true")
a = ap.parse_args(); tk = tok()
sent = parse(a.sent); block = parse(a.blocklist) if a.blocklist else {}
docs = {}; pt = None
while True:
    r = call(f"{BASE}/sales_candidates?pageSize=300" + (f"&pageToken={pt}" if pt else ""), tk)
    for d in r.get("documents", []): docs[d["name"].split("/")[-1]] = d
    pt = r.get("nextPageToken")
    if not pt: break
st = lambda d: d["fields"]["status"]["stringValue"]
fix, notin, already = [], [], 0
for h, t in sent.items():
    d = docs.get(doc_id(h))
    if d is None: notin.append(h)
    elif st(d) == "waiting": fix.append((h, t, d))
    else: already += 1
print(f"送信済み一覧 {len(sent)} 件：台帳で waiting のまま {len(fix)} 件 / すでに送信済み等 {already} 件 / 台帳に無い {len(notin)} 件")
for h, t, d in fix: print("  直す:", "@" + h, t or "(時刻なし)")
bw = [h for h in block if doc_id(h) in docs and st(docs[doc_id(h)]) == "waiting"]
if a.blocklist: print(f"blocklist {len(block)} 件のうち、台帳で waiting のもの {len(bw)} 件（直さず一覧のみ）:", ["@" + h for h in bw])
if notin: print("台帳に無い送信済み（作らない）:", ["@" + h for h in notin][:50], "…" if len(notin) > 50 else "")
if not a.apply: print("(dry-run: 何も書いていません。--apply で書きます)"); sys.exit(0)
n = 0
for h, t, d in fix:
    f = {"status": {"stringValue": "sent"}, "sentBy": {"stringValue": "job"}, "updatedAt": {"timestampValue": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}}
    mask = ["status", "sentBy", "updatedAt"]
    if t:
        dt = datetime.fromisoformat(t.replace("Z", "+00:00").replace(" ", "T"))
        if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone(__import__("datetime").timedelta(hours=9)))
        f["sentAt"] = {"timestampValue": dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}; mask.append("sentAt")
    try:
        call(f"{BASE}:commit", tk, {"writes": [{"update": {"name": d["name"], "fields": f}, "updateMask": {"fieldPaths": mask},
             "currentDocument": {"updateTime": d["updateTime"]}}]}); n += 1
    except urllib.error.HTTPError as e:
        print("  書けなかった(更新が入っていた等):", "@" + h, e.read().decode()[:120])
print(f"sent に直した {n} 件")
