#!/usr/bin/env python3
"""mono.Board の営業データ(dms / sentLog / exclusions)を Firestore sales_candidates へ移す一回きりの道具。

安全設計
  - 作成のみ(precondition exists=false)。すでにあるドキュメントは絶対に上書きしない。
  - 全件置き換え・削除はしない。--dry-run が既定。--apply で書く。
  - 認証は gcloud の ADC/ユーザーのアクセストークン(Mac 内だけ)。鍵ファイルは使わない・リポジトリに入れない。
  - 入力データ(ボードの書き出し)はリポジトリの外に置く(DM 本文などを公開リポジトリに入れない)。

使い方
  python3 tools/migrate_from_board.py --board-dir <dms/sentLog/exclusions の親> [--apply]
"""
import argparse, collections, glob, json, os, subprocess, sys, urllib.request, urllib.error
from datetime import datetime, timezone

PROJECT = "editflow-mono-create"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
COLL = "sales_candidates"
STAGE2STATUS = {"reply": "replied", "talk": "meeting", "won": "converted"}


def load(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*.json")):
        out[os.path.basename(f)[:-5]] = json.load(open(f))
    return out


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def convert(h, d, sl, ex):
    """ボードの dms 1件 → sales_candidates の1件(フィールド辞書, Firestore の型付き値)"""
    status, notes = d.get("status"), []
    if status == "ready":
        s = "waiting"
    elif status == "sent":
        s = STAGE2STATUS.get(d.get("stage"), "sent")
    elif status == "excluded":
        s = "excluded"
    elif status == "skip":
        s = "excluded"
        notes.append("ボードでは「送らない相手」(skip)")
    else:
        raise ValueError(f"{h}: 未知の status {status}")
    if d.get("sentAtNote"):
        notes.append(d["sentAtNote"])
    if d.get("addedFrom"):
        notes.append("addedFrom:" + d["addedFrom"])
    if d.get("line"):
        notes.append("個別の一文: " + d["line"])
    f = {
        "handle": {"stringValue": "@" + h},
        "status": {"stringValue": s},
        "source": {"stringValue": "board"},
        "updatedAt": {"timestampValue": iso(int(datetime.now(timezone.utc).timestamp() * 1000))},
    }
    if d.get("genre"):
        f["genre"] = {"stringValue": d["genre"]}
    if d.get("followers") is not None:
        f["followers"] = {"integerValue": str(int(d["followers"]))}
    if d.get("name"):
        f["name"] = {"stringValue": d["name"]}
    if d.get("order") is not None:
        f["order"] = {"integerValue": str(int(d["order"]))}
    if d.get("approved") is True:
        f["approved"] = {"booleanValue": True}
    if d.get("rank"):
        f["rank"] = {"stringValue": d["rank"]}
    if s in ("sent", "replied", "meeting", "converted"):
        ms = d.get("sentAt") or (sl.get(h) or {}).get("sentAt")
        if ms:
            f["sentAt"] = {"timestampValue": iso(int(ms))}
        sender = d.get("sender") or (sl.get(h) or {}).get("sender")
        if sender:
            f["sentFrom"] = {"stringValue": sender.replace("mono.create.", "")}
        f["sentBy"] = {"stringValue": "board"}
    if notes:
        f["note"] = {"stringValue": " / ".join(notes)[:1900]}
    return f


def doc_id(h):
    """ドキュメントID = @なし小文字ハンドル。Firestore は __x__ 形式のIDを予約語として拒否するので、その時だけ先頭に ~ を付ける"""
    return "~" + h if h.startswith("__") and h.endswith("__") else h


def token():
    return subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()


def post(url, body, tok):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Authorization": "Bearer " + tok, "Content-Type": "application/json", "x-goog-user-project": PROJECT})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()[:800]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--board-dir", required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    dms, sl, ex = (load(os.path.join(a.board_dir, n)) for n in ("dms", "sentLog", "exclusions"))
    docs = {h: convert(h, d, sl, ex) for h, d in dms.items()}
    # 除外リスト(exclusions)にあって dms に無いハンドルも excluded で入れる
    for h, x in ex.items():
        if h not in docs:
            docs[h] = convert(h, {"status": "excluded", "sentAtNote": "exclusions のみに存在"}, sl, ex)
    c = collections.Counter(f["status"]["stringValue"] for f in docs.values())
    print("変換:", len(docs), dict(c))
    if not a.apply:
        print("(dry-run: 何も書いていません。--apply で書きます)")
        return
    tok, items = token(), list(docs.items())
    created = existed = 0
    for i in range(0, len(items), 200):  # 1リクエストずつ(部分失敗でも他の件は進める)
        for h, f in items[i:i + 200]:
            name = f"projects/{PROJECT}/databases/(default)/documents/{COLL}/{doc_id(h)}"
            try:
                post(f"{BASE}:commit", {"writes": [{"update": {"name": name, "fields": f},
                                                   "currentDocument": {"exists": False}}]}, tok)
                created += 1
            except SystemExit as e:
                if "ALREADY_EXISTS" in str(e) or "already exists" in str(e).lower():
                    existed += 1
                else:
                    raise
    print(f"作成 {created} 件 / すでに存在(上書きせず) {existed} 件")


if __name__ == "__main__":
    main()
