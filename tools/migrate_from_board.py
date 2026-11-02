#!/usr/bin/env python3
"""mono.Board の営業データ(dms / sentLog / exclusions / tdms / recruit / goals/edit_agency / 画像)を Firestore へ移す一回きりの道具。

安全設計
  - 新規ドキュメントは作成のみ(precondition exists=false)。すでにあるドキュメントは絶対に上書きしない。
  - 既存ドキュメントへの項目追加(--backfill)は updateMask で「列挙した項目だけ」の部分更新(exists=true)。
  - 全件置き換え・削除はしない。--apply が無ければ dry-run。
  - 認証は gcloud のユーザーのアクセストークン(Mac 内だけ)。鍵ファイルは使わない・リポジトリに入れない。
  - 入力データ(ボードの書き出し・画像)はリポジトリの外に置く(DM 本文・プロフィール画像を公開リポジトリに入れない)。

使い方
  python3 tools/migrate_from_board.py --board-dir <dms/sentLog/exclusions/tdms/recruit の親> --what video|backfill|thumb|recruit|goal|photos [--photos-dir <jpg置き場>] [--apply]
"""
import argparse, base64, collections, glob, json, os, subprocess, sys, urllib.request, urllib.error
from datetime import datetime, timezone

PROJECT = "editflow-mono-create"
DOCS = f"projects/{PROJECT}/databases/(default)/documents"
BASE = f"https://firestore.googleapis.com/v1/{DOCS}"
STAGE2STATUS = {"reply": "replied", "talk": "meeting", "won": "converted"}
BACKFILL_FIELDS = ["text", "reel", "line", "approvedAt", "excludedAt", "skippedAt", "hasPhoto"]


def load(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*.json")):
        out[os.path.basename(f)[:-5]] = json.load(open(f))
    return out


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def ts(ms):
    return {"timestampValue": iso(int(ms))}


def doc_id(h):
    """ドキュメントID = @なし小文字ハンドル。Firestore は __x__ 形式のIDを予約語として拒否するので、その時だけ先頭に ~ を付ける"""
    return "~" + h if h.startswith("__") and h.endswith("__") else h


def S(v):
    return {"stringValue": v}


def convert(h, d, sl, ex, photos_dir):
    """ボードの dms / tdms 1件 → sales_candidates 系の1件(型付きフィールド辞書)"""
    status, notes = d.get("status"), []
    if status == "ready":
        s = "waiting"
    elif status == "sent":
        s = STAGE2STATUS.get(d.get("stage"), "sent")
    elif status == "excluded":
        s = "excluded"
    elif status == "skip":
        s = "skipped"
    else:
        raise ValueError(f"{h}: 未知の status {status}")
    if d.get("sentAtNote"):
        notes.append(d["sentAtNote"])
    if d.get("addedFrom"):
        notes.append("addedFrom:" + d["addedFrom"])
    f = {"handle": S("@" + h), "status": S(s), "source": S("board"),
         "updatedAt": ts(datetime.now(timezone.utc).timestamp() * 1000)}
    if d.get("genre"):
        f["genre"] = S(d["genre"])
    if d.get("followers") is not None:
        f["followers"] = {"integerValue": str(int(d["followers"]))}
    if d.get("name"):
        f["name"] = S(d["name"])
    if d.get("order") is not None:
        f["order"] = {"integerValue": str(int(d["order"]))}
    if d.get("approved") is True:
        f["approved"] = {"booleanValue": True}
    if d.get("approvedAt"):
        f["approvedAt"] = ts(d["approvedAt"])
    if d.get("rank"):
        f["rank"] = S(d["rank"])
    if d.get("text"):
        f["text"] = S(d["text"])
    if d.get("reel"):
        f["reel"] = S(d["reel"])
    if d.get("line"):
        f["line"] = S(d["line"])
    if d.get("link"):
        f["link"] = S(d["link"])
    exat = d.get("excludedAt") or (ex.get(h) or {}).get("at")
    if s == "excluded" and exat:
        f["excludedAt"] = ts(exat)
    if s == "skipped" and d.get("skippedAt"):
        f["skippedAt"] = ts(d["skippedAt"])
    blob = str(d.get("photo") or "")
    if blob.startswith("/_blob/") and photos_dir and glob.glob(os.path.join(photos_dir, blob.split("/")[-1] + ".*")):
        f["hasPhoto"] = {"booleanValue": True}
    if s in ("sent", "replied", "meeting", "converted"):
        msx = d.get("sentAt") or (sl.get(h) or {}).get("sentAt")
        if msx:
            f["sentAt"] = ts(msx)
        sender = d.get("sender") or (sl.get(h) or {}).get("sender")
        if sender:
            f["sentFrom"] = S(sender.replace("mono.create.", ""))
        f["sentBy"] = S("board")
    if notes:
        f["note"] = S(" / ".join(notes)[:1900])
    return f


def convert_recruit(i, d):
    f = {"status": S(d.get("status") or "new"), "updatedAt": ts(datetime.now(timezone.utc).timestamp() * 1000)}
    for k in ("kind", "category", "format", "title", "poster", "price", "deadline", "summary", "url", "profileImage"):
        if d.get(k):
            f[k] = S(str(d[k]))
    if d.get("order") is not None:
        f["order"] = {"integerValue": str(int(d["order"]))}
    if d.get("decidedAt"):
        f["decidedAt"] = ts(d["decidedAt"])
    return f


def token():
    return subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()


def commit(writes, tok):
    req = urllib.request.Request(f"{BASE}:commit", data=json.dumps({"writes": writes}).encode(), headers={
        "Authorization": "Bearer " + tok, "Content-Type": "application/json", "x-goog-user-project": PROJECT})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode()[:600])


def create_all(coll, items, tok):
    created = existed = 0
    for did, f in items:
        try:
            commit([{"update": {"name": f"{DOCS}/{coll}/{did}", "fields": f}, "currentDocument": {"exists": False}}], tok)
            created += 1
        except RuntimeError as e:
            if "ALREADY_EXISTS" in str(e):
                existed += 1
            else:
                raise
    print(f"{coll}: 作成 {created} 件 / すでに存在(上書きせず) {existed} 件")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--board-dir", required=True)
    ap.add_argument("--what", required=True, choices=["video", "backfill", "thumb", "recruit", "goal", "photos"])
    ap.add_argument("--photos-dir")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    B = a.board_dir
    dms, sl, ex = (load(os.path.join(B, n)) for n in ("dms", "sentLog", "exclusions"))

    if a.what in ("video", "backfill"):
        docs = {h: convert(h, d, sl, ex, a.photos_dir) for h, d in dms.items()}
        for h in ex:
            if h not in docs:
                docs[h] = convert(h, {"status": "excluded", "sentAtNote": "exclusions のみに存在"}, sl, ex, a.photos_dir)
        print("変換:", len(docs), dict(collections.Counter(f["status"]["stringValue"] for f in docs.values())))
        if not a.apply:
            print("(dry-run: 何も書いていません)"); return
        tok = token()
        if a.what == "video":
            create_all("sales_candidates", [(doc_id(h), f) for h, f in docs.items()], tok)
        else:  # 既存ドキュメントに、新しい項目だけを updateMask で足す
            n = 0
            for h, f in docs.items():
                paths = [k for k in BACKFILL_FIELDS if k in f]
                cur_skip = dms.get(h, {}).get("status") == "skip"
                if cur_skip:
                    paths += ["status"]  # ボードの「送らない(skip)」は status=skipped（最初の移行では excluded にしていた）
                if not paths:
                    continue
                commit([{"update": {"name": f"{DOCS}/sales_candidates/{doc_id(h)}", "fields": {k: f[k] for k in paths}},
                         "updateMask": {"fieldPaths": paths}, "currentDocument": {"exists": True}}], tok)
                n += 1
            print(f"sales_candidates: 項目を足した {n} 件")
    elif a.what == "thumb":
        t = load(os.path.join(B, "tdms"))
        items = [(doc_id(h), convert(h, d, {}, {}, a.photos_dir)) for h, d in t.items()]
        print("サムネイル:", len(items))
        if a.apply:
            create_all("sales_thumb_candidates", items, token())
    elif a.what == "recruit":
        r = load(os.path.join(B, "recruit"))
        items = [(i, convert_recruit(i, d)) for i, d in r.items()]
        print("募集:", len(items), dict(collections.Counter(f["status"]["stringValue"] for _, f in items)))
        if a.apply:
            create_all("sales_recruit", items, token())
    elif a.what == "goal":
        g = json.load(open(os.path.join(B, "goal_edit_agency.json")))
        g = g.get("data", g)
        f = {"title": S(g["title"]), "target": {"integerValue": str(int(g.get("target", 10)))}, "deadline": ts(g["deadline"]),
             "updatedAt": ts(datetime.now(timezone.utc).timestamp() * 1000)}
        print("目標:", g["title"], iso(g["deadline"]))
        if a.apply:
            create_all("sales_meta", [("goal", f)], token())
    elif a.what == "photos":
        items = []
        for h, d in dms.items():
            blob = str(d.get("photo") or "")
            if not blob.startswith("/_blob/"):
                continue
            fs = glob.glob(os.path.join(a.photos_dir, blob.split("/")[-1] + ".*"))
            if not fs:
                print("画像なし:", h); continue
            raw = open(fs[0], "rb").read()
            typ = "image/jpeg" if raw[:3] == b"\xff\xd8\xff" else ("image/png" if raw[:4] == b"\x89PNG" else "image/webp")
            b64 = base64.b64encode(raw).decode()
            if len(b64) >= 900000:
                print("大きすぎる:", h, len(b64)); continue
            items.append(("video~" + doc_id(h), {"data": S(b64), "type": S(typ),
                                                 "updatedAt": ts(datetime.now(timezone.utc).timestamp() * 1000)}))
        print("画像:", len(items))
        if a.apply:
            create_all("sales_photos", items, token())


if __name__ == "__main__":
    main()
