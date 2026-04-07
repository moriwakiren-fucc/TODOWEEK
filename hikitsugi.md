# TodoRemind 引き継ぎ資料

作成日：2026年4月

---

## 1. プロジェクト概要

**TodoRemind**（旧称：TodoWeek）は、学習の予定・課題の締め切りを曜日ごとに管理するTodo管理PWAアプリ。教科別カラーコーディング・プッシュ通知リマインド・複数端末同期などの機能を持つ。

- **公開URL**：`https://moriwakiren-fucc.github.io/TODOWEEK/`
- **リポジトリ**：GitHub Pages（`moriwakiren-fucc` アカウント、リポジトリ名 `TODOWEEK`）
- **想定端末**：iPhone・iPad（ホーム画面に追加したPWAとして利用）・PC

---

## 2. 構成ファイル一覧

GitHubリポジトリのルートに以下のファイルを配置する。

| ファイル | 役割 |
|---|---|
| `index.html` | メインHTML |
| `style.css` | スタイルシート |
| `script.js` | フロントエンドのすべてのロジック |
| `sw.js` | Service Worker（オフラインキャッシュ・プッシュ通知受信） |
| `manifest.json` | PWA設定（ホーム画面追加用） |
| `favicon.ico` | ファビコン（GitHubにアップロード済み、このChatでは生成不可） |
| `apple-touch-icon.png` | ホーム画面アイコン（同上） |
| `worker.js` | **Cloudflare Workerにデプロイするコード**（GitHubには置かない） |

---

## 3. Cloudflare 設定

### 3-1. Workerの情報

| 項目 | 値 |
|---|---|
| Worker名 | `todoweek-api2` |
| Worker URL | `https://todoweek-api2.moriwakiren-fucc.workers.dev` |
| Cloudflareアカウント | `moriwakiren-fucc` |

> **注意**：`todoweek-api`（旧Worker）も存在するが、こちらは使用していない。

### 3-2. KV Namespace

| バインド変数名 | KV Namespace名 | 用途 |
|---|---|---|
| `TODOWEEK_KV` | `TODOWEEK` | タスクデータ（キー：ユーザーID） |
| `SUBS_KV` | `SUBS_KV` | プッシュ通知の購読情報（キー：ユーザーID） |

### 3-3. 環境変数・シークレット

| 変数名 | Type | 用途 |
|---|---|---|
| `VAPID_PUBLIC_KEY` | Variable（Text） | Web Push用VAPID公開鍵 |
| `VAPID_PRIVATE_KEY` | **Secret** | Web Push用VAPID秘密鍵 |
| `VAPID_SUBJECT` | Variable（Text） | `mailto:moriwakiren.fucc@gmail.com`（スペースなし） |

> **注意**：`VAPID_SUBJECT` の `mailto:` と `@gmail.com` の間にスペースが入ると通知が送れなくなる（過去に発生したバグ）。

### 3-4. Cron Trigger

| 設定値 | 意味 |
|---|---|
| `*/5 * * * *` | 5分ごとに実行（JST各時刻の通知を配信） |

> `0 11 * * *`（毎日JST 20:00）から変更済み。タスクの通知時刻を5分刻みで自由設定できる仕様のため。

### 3-5. Worker APIエンドポイント一覧

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/tasks/:userId` | タスク一覧取得 |
| PUT | `/tasks/:userId` | タスク一覧保存 |
| POST | `/subscribe/:userId` | プッシュ購読情報を登録 |
| DELETE | `/subscribe/:userId` | プッシュ購読情報を削除 |
| GET | `/vapidPublicKey` | VAPID公開鍵をフロントに返す |
| GET | `/test-push/:userId` | テスト通知を全端末に送信 |
| GET | `/devices/:userId` | 登録済み端末一覧（endpointのみ） |

---

## 4. フロントエンド（script.js）の重要定数

```js
const WORKER_URL = 'https://todoweek-api2.moriwakiren-fucc.workers.dev';
const CFG_KEY    = 'todoweek_config_v1';   // localStorage：ユーザーID設定
const TASKS_KEY  = 'todoweek_tasks_v2';    // localStorage：タスクデータ
const GOAL_KEY   = 'todoweek_goal_v1';     // localStorage：長期目標（週offset付き）
const SUB_KEY    = 'todoweek_sub_v1';      // localStorage：この端末の購読情報
const PENDING_KEY = 'todoweek_pending_sync'; // localStorage：オフライン中の未同期フラグ
```

---

## 5. 主な機能一覧

- **7日間カレンダー**：今日起点で7日分を表示。`＜＞`ボタンで週単位に移動。
- **長期的な目標**：週ごとに保存される入力欄（カレンダー上部）。
- **タスク管理**：タイトル・日付・リマインド・通知時刻・教科・書式を設定可能。
- **教科別カラー**：国語（赤）・数学（青）・英語（黄）・化学/物理/生物（緑）・地理/日本史/世界史（紫）・情報（水色）・カスタム（自由入力・ピンク）。
- **書式設定**：太字・下線・二重下線・文字色・背景色（パレット＋カラーピッカー）。
- **未達成タスク**：過去日付で未完了のタスクを画面下部に横スクロール表示。
- **ドラッグ＆ドロップ**：PCはマウスドラッグ、スマホは長押し（400ms）でドラッグ開始し、別の列にドロップして日付変更。
- **複数端末同期**：Cloudflare KVにタスクデータを保存。同じユーザーIDを使えば全端末で共有。
- **オフライン対応**：Service Workerでキャッシュ。オフライン中の編集はlocalStorageに保存し、オンライン復帰時に自動同期。
- **プッシュ通知**：Cronが5分ごとに起動し、リマインド日・通知時刻が一致するタスクを各端末に配信。TTL=86400秒のため、オフライン中に送信された通知はオンライン復帰後24時間以内に自動配信される。
- **ピンチ/トラックパッドズームのブロック**：タッチの2本指・Ctrl+Wheelによるズームを禁止（キーボードショートカットは対象外）。

---

## 6. プッシュ通知の仕組み

```
[Cloudflare Cron 5分ごと]
    ↓
SUBS_KV から全ユーザーの購読情報を取得
TODOWEEK_KV から全ユーザーのタスクを取得
    ↓
リマインド日 = 今日 かつ notifTime = 現在時刻（5分単位） のタスクを抽出
    ↓
VAPID JWT を生成（ECDSA P-256、JWK形式でインポート）
    ↓
ペイロードを aes128gcm で暗号化（RFC 8291）
    ↓
https://web.push.apple.com/... に POST
```

**過去のハマりポイント（重要）**：
- `VAPID_SUBJECT` の `mailto:` 後のスペースで403エラー → スペースなしで設定すること。
- ペイロードの末尾に `\x02`（RFC 8188 delimiter）が必要。これがないとAppleがサイレントに破棄する。
- VAPID秘密鍵のインポートは `pkcs8` ではなく `jwk` 形式（公開鍵からx,yを取り出してJWK構築）。
- Service Workerのスコープはサブディレクトリ対応のため `./sw.js` と相対パスで登録。
- プッシュ通知の許可はSafariブラウザからは不可。ホーム画面追加アプリから行う必要あり。

---

## 7. Service Worker キャッシュ管理

```js
const CACHE_NAME = 'todoweek-v3'; // sw.js 内
```

ファイルを更新しても反映されない場合は、`sw.js` の `CACHE_NAME` の数字を上げること（例：`v4`）。これで古いキャッシュが破棄される。

---

## 8. タスクデータ構造（localStorage・KV共通）

```json
{
  "id": "abc123def",
  "title": "数学の宿題",
  "date": "2026-04-10",
  "remind": "2",
  "notifTime": "07:00",
  "subject": "数学",
  "done": false,
  "format": {
    "bold": false,
    "underline": false,
    "double-underline": false,
    "fg": "#1a44cc",
    "bg": null
  }
}
```

| フィールド | 値の例 | 備考 |
|---|---|---|
| `remind` | `"0"`, `"1"`〜`"30"`, `"today"` | `"0"` = なし、`"today"` = 当日 |
| `notifTime` | `"07:00"`, `"none"` | `"none"` = 通知なし、`"0"` がリマインドなしの場合は無視 |
| `subject` | `"数学"`, `"カスタム名"` | カスタムの場合は入力した名前がそのまま入る |

---

## 9. ユーザーID運用

- ユーザーIDは英数字・ハイフン・アンダーバーのみ。
- 同じIDを複数端末で使うことでデータ共有。
- `SUBS_KV` に11件の古い購読情報が蓄積しているため、不要なものは削除推奨（KVダッシュボードから手動削除）。

---

## 10. フィルタリング・ネットワーク要件

学校のフィルタリングシステムでCloudflareがブロックされた実績あり。以下のURLへのアクセスを許可する必要がある。

| URL | 用途 |
|---|---|
| `https://moriwakiren-fucc.github.io/TODOWEEK/` | アプリ本体 |
| `https://todoweek-api2.moriwakiren-fucc.workers.dev/` | APIサーバー（全エンドポイント） |
| `https://web.push.apple.com/` | Appleのプッシュ通知サーバー（Workerから送信） |
| `https://fonts.googleapis.com/` | Googleフォント |
| `https://fonts.gstatic.com/` | Googleフォント（フォントファイル） |

---

## 11. 既知の問題・注意事項

| 問題 | 状況 |
|---|---|
| SUBS_KVに古い購読情報が蓄積 | 11件存在。不要分は手動削除推奨 |
| 横スクロールによる日移動は未実装 | `＜＞`ボタンによる週単位移動のみ。横スクロールは廃止済み |
| キャッシュ更新が反映されないことがある | `sw.js`の`CACHE_NAME`を上げて対応 |
| ドラッグ中にタップ判定がされる場合がある | `dragStarted`フラグで制御中だが環境依存あり |

---

## 12. 開発時の注意

- **Wrangler CLI（Node.js）は使用不可**。Cloudflareの設定は全てダッシュボード（ブラウザ）で行う。
- Worker更新は「Edit code → 全選択・全削除 → `worker.js`の内容を貼り付け → Deploy」。
- GitHub Pagesへのデプロイは、ファイルをリポジトリのルートにプッシュするだけで自動反映。
- フォントは `DM Serif Display`（見出し）と `Noto Sans JP`（本文）をGoogle Fontsから読み込み。
