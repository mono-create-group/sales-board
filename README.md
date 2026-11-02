# 共同営業台帳 (sales-board)

営業候補（Instagram ハンドル）と送信状況を、航汰さん・Claude Code・こまめ（ミューズ）が同じ Firestore から直接読み書きする静的アプリ。mono.Board の営業タブの置き換え。

- 公開先: GitHub Pages（`index.html` 1枚）
- データの正本: Firestore `editflow-mono-create` の `sales_candidates`（localStorage は使わない）
- サインイン: Google（`nakamurakouta512@gmail.com` / `mono.create.group@gmail.com` のみ書き込み可）

## データ
`sales_candidates/{id}` — id は **@なし小文字ハンドル**。ただし `__x__` 形式のハンドルは Firestore の予約IDなので先頭に `~` を付ける（例 `~__k.fitness27__`）。

| フィールド | 内容 |
|---|---|
| handle | `@`付きハンドル（必須） |
| status | `waiting` 送信待ち / `sent` 送信済み / `replied` 返信 / `meeting` 商談 / `converted` 成約 / `excluded` 除外（必須） |
| genre, followers, name | ジャンル / フォロワー数 / 表示名 |
| source | 収集元（`board`=移行データ, `manual`=画面から追加 …） |
| variant | 送信に使った文面 A/B/C |
| sentAt, sentFrom, sentBy | 送信日時 / 送信元(movie〜movie5・本人手動) / `job`・`manual`・`board` |
| note | メモ |
| order, approved, rank | 送信待ちの並び順 / 営業許可 / 候補ランク（ボードから引き継ぎ） |
| updatedAt | 最終更新（必須） |

## 安全設計（2026-10-23 の EditFlow 上書き事故の再発防止）
1. 初回は必ずリモート取得（`onSnapshot`）から。**初期データ（シード）をリモートへ書く処理は無い**
2. 書き込みは **1候補＝1ドキュメントの部分更新**（`update`）と、存在しない時だけの追加（transaction で `exists` を確認）のみ。全件置き換え・配列の丸ごと保存・削除は無い（削除はルールでも不可。状態は `excluded` にする）
3. localStorage / IndexedDB に営業データを保存しない

## セキュリティルール
`firestore.rules.sales_candidates.txt` のブロックを、プロジェクト共有のルールに**足すだけ**（既存コレクションは変更しない）。読み取り=誰でも（REST+APIキーで可）、書き込み=オーナー2アカウント＋許可フィールド・状態値のみ。

## こまめ（ジョブ）からの読み取り
```bash
KEY=<Firebase Web APIキー(editflow-team の index.html の apiKey と同じ)>
# 全件（pageSize 最大300、nextPageToken で続き）
curl "https://firestore.googleapis.com/v1/projects/editflow-mono-create/databases/(default)/documents/sales_candidates?pageSize=300&key=$KEY"
# 1件（二重送信チェック）
curl "https://firestore.googleapis.com/v1/projects/editflow-mono-create/databases/(default)/documents/sales_candidates/<ハンドル>?key=$KEY"   # 404 = 未登録
# 送信待ちだけ
curl -X POST -H 'Content-Type: application/json' -d '{"structuredQuery":{"from":[{"collectionId":"sales_candidates"}],"where":{"fieldFilter":{"field":{"fieldPath":"status"},"op":"EQUAL","value":{"stringValue":"waiting"}}}}}' "https://firestore.googleapis.com/v1/projects/editflow-mono-create/databases/(default)/documents:runQuery?key=$KEY"
```
送信前チェックの目安: `status` が `waiting` 以外（または未登録でブロックリストにある）なら送らない。

## 移行
`tools/migrate_from_board.py` — mono.Board の dms / sentLog / exclusions の書き出しから作成のみ（既存IDは上書きしない）。データ本体はリポジトリに入れない。
