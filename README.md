# DeepAI スマホブリッジ

スマホから自宅 PC の **DeepAI Code** を操作するための橋渡しサーバです。

スマホには **PC 上でいま使っている DeepAI Code 本体の画面（Web クライアント）がそのまま**
表示され、ログイン済みの状態で日本語の指示を出せます。

```
スマホ (Chrome/Safari)
   │  HTTP + WebSocket （LAN）
   ▼
ブリッジ (app/server.mjs) ── 0.0.0.0:8787 ──▶ DeepAI Code サーバ (127.0.0.1:3773)
                                              （本物の Web クライアントを配信）
```

DeepAI Code のサーバは `127.0.0.1` しか listen できないため、
LAN に公開するのはこのブリッジです。

---

## リポジトリ

<https://github.com/ryoga0619/deepai-phone-bridge> （MIT / 公開）

---

## 他の PC で使う

1 台 1 接続先。PC ごとにこのブリッジを起動し、その PC の URL（または QR）をスマホで読み取ります。
アクセスキーは **PC ごとに自動生成** されるため、別 PC のキーが混ざることはありません。

### 準備（新しい PC で 1 回だけ）

| 必要なもの | 備考 |
| --- | --- |
| DeepAI Code デスクトップアプリ | 起動中であること（`127.0.0.1:3773` で待機） |
| Node.js 18 以上 | 無ければ DeepAI Code 同梱のランタイムが自動使われます |
| 同じ Wi-Fi のスマホ | 自宅の外で使う場合は Tailscale 等の VPN を推奨 |

### 導入方法 A : git clone

```bash
git clone https://github.com/ryoga0619/deepai-phone-bridge.git
cd deepai-phone-bridge
setup.cmd
app\start-bridge.cmd
```

### 導入方法 B : ZIP（手順最小）

1. <https://github.com/ryoga0619/deepai-phone-bridge/releases> → `v1.0.0` → Assets の
   `deepai-phone-bridge-v1.0.0.zip` をダウンロード
2. 解凍 → `setup.cmd` を実行（DeepAI Code / Node / ファイアウォールの確認）
3. `app\start-bridge.cmd` を実行 → ターミナルに URL と QR が出る
4. スマホで QR を読む

### 環境変数（任意）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `8787` | ブリッジの listen ポート |
| `HOST` | `0.0.0.0` | listen アドレス |
| `DEEPAI_BASE_URL` | `http://127.0.0.1:3773` | DeepAI Code サーバの場所 |
| `ACCESS_KEY` | 自動生成 | スマフオから見たときのアクセスキー |
| `ALLOW_ANONYMOUS` | 未設定 | `1` にすると認証を無効化（非推奨） |

---

## 使い方（3 ステップ）

### 1. PC で起動する

1. DeepAI Code デスクトップアプリを起動しておく（`127.0.0.1:3773` で待機中）
2. `app\start-bridge.cmd` をダブルクリック
3. ターミナルに **URL** と **QRコード** が出る

```
  URL          : http://192.168.0.6:8787/?k=ada67461a9a9f4b1
  アクセスキー : ada67461a9a9f4b1
```

- アクセスキーは `~/.deepai-code/phone-bridge.key` に保存され、**起動し直しても変わりません**
- Bearer トークンが切れている場合はブリッジが自動で再発行します
- 起動しっぱなしにしてください（閉じた-PC でスマホは使えなくなります）

### 2. スマホで接続する

1. スマホを**自宅の Wi-Fi** に接続
2. カメラで QR を読む（または URL を手入力）
3. ブラウザで開くと **DeepAI Code 本体の画面** がそのまま出ます
4. 任意：Chrome/Safari の「ホーム画面に追加」でアプリ化（PWA）

> URL に `?k=...` を付けるのは初回だけ。Cookie（30 日）を発行するので、
> 以降は `http://192.168.0.6:8787/` だけで開けます。

### 3. 使う

スマホには **PC の DeepAI Code と同じ画面** が出ています。

| やりたいこと | 操作 |
| --- | --- |
| 指示を出す | 画面下部の入力欄に日本語で入力 → 送信ボタン |
| 進捗を見る | 応答がそのままストリーミング表示（推論・コマンド・ファイル変更も含む） |
| 追加で指示 | 同じスレッドに続けて送信 → 前ターンの文脈を引き継ぐ |
| モデル・権限を変える | 入力欄の下の「モデル」「承認モード」から変更 |
| ファイル／ターミナル | 左サイドバー（☰）の Files / Terminal |
| 軽量アプリが必要なら | `http://192.168.0.6:8787/mobile?k=<キー>` |

---

## どの PC に接続しているか

```
スマホ ──Wi-Fi(LAN)──▶ DESKTOP-7RPU4B5 (192.168.0.6)
                          ├─ 8787 : ブリッジ（本、PC 上で公開）← スマホはここへ
                          └─ 3773 : DeepAI Code サーバ（127.0.0.1 のみ）← 外からは不可
```

- スマホは 1 台 1 接続先。PC を複数使う場合は PC ごとにブリッジを起動し、URL を持ち替えます
- ルータの DHCP などで IP が変わった場合は `ipconfig` で確認してください
- 自宅の外から使うなら Tailscale 等の VPN を推奨（DAY範囲の公開はしない）

---

## 構成

```
app/
  server.mjs            ブリッジ HTTP サーバ（プロキシ / 認証 / セッション発行）
  start-bridge.cmd      Windows 起動スクリプト
  lib/
    bridge.mjs          軽量アプリ用の DeepAI 連携・タスク管理・状態正規化
    deepai-client.mjs   DeepAI Code サーバとの WS RPC クライアント
    qr.mjs              QR 描画ヘルパー
    qr-impl.mjs         QR コード生成実装（DeepAI Code 同梱の qrCode.ts を抜粋）
  web/
    index.html          軽量 PWA（/mobile 用・フォールバック）
    app.css             モバイル専用スタイル
    app.js              会話表示 / SSE 受信 / 成果物プレビュー
    manifest.webmanifest
```

## 認証の仕組み

1. ブリッジは `POST /api/auth/pairing-token`（Bearer 認証）で**ペアリング資格情報**を発行
2. `POST /api/auth/browser-session` で将它と交換し、`t3_session_<port>` **ブラウザセッション Cookie** を得る
3. HTML を配信するたびにこの Cookie をスマホに付与
4. 以降の API / WebSocket はすべてこの Cookie でネイティブに認証される

したがって **DeepAI のトークンがスマホに渡ることはありません**（Cookie のみ）。
さらにブリッジ自体にも `ACCESS_KEY`（`?k=` / `x-access-key` / Cookie `dcp_key`）の gate があります。

## API（軽量アプリ用の補助 API）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/ping` | 生存確認 |
| POST | `/api/tasks` | 新規タスク開始 `{text}` → `{threadId}` |
| GET | `/api/tasks/:id` | タスク状態（turn items 正規化済み） |
| POST | `/api/tasks/:id/follow` | 同一スレッドに追加指示 |
| GET | `/api/tasks/:id/files` | 成果物一覧 |
| GET | `/api/tasks/:id/file?path=` | ファイル本文 |
| GET | `/api/stream` | SSE（`task` / `warn`） |

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| スマホが「Sign in to DeepAI Code」になる | ブリッジ再起動（新しいセッションを発行）。`?k=` 付き URL で開き直す |
| 401 が返る | アクセスキーが未設定。`?k=<アクセスキー>` を付ける |
| 接続できない | スマホと PC が同じ Wi-Fi か確認。Windows ファイアウォールで 8787 の TCP を許可 |
| 画面が更新されない | ブリッジを停止 → 再起動。QR ではなく固定 URL（`http://192.168.0.6:8787/`）で開く |

## 動作確認済み

- ブラウザからサインイン済みの DeepAI Code 本体画面が表示される
- 日本語指示送信 → 応答（例: 「3×4」→ 「12」）まで実機相当で成立
- スマホ縦幅（430×932）で会話・入力・応答が破綻なく表示
- WebSocket 接続（`orchestrationProtocol=2`）・スレッド作成・応答取得がすべて 200/成功
- 未認証・誤キーアクセスは 401 で拒否
