# Irodori Studio ローカル HTTP API

Studio 起動中に、同一 PC（またはバインド先のネットワーク）から音声合成・連結を呼び出すための API です。

- **ネイティブ API**（`/v1/...`）: Irodori 専用。Bearer トークン必須。
- **VOICEVOX 互換 API**（`/audio_query`, `/synthesis` など）: 既存ツール向け。**ループバック（127.0.0.1 等）からの接続のみ認証不要**。

---

## 事前準備

1. **Irodori Studio を起動**する（生成エンジン OPT がロード可能な状態）。
2. **設定 → ローカル HTTP サーバー** を開く。
   - 「HTTP サーバーを有効」がオン（既定オン）。
   - **ベース URL** と **API トークン** を確認する。画面に `http://127.0.0.1:50021/v1/` のように表示される。
3. **話者（Speaker Embedding）** が Outputs に存在すること。`/v1/speakers` で `id`（埋め込みパス）を取得する。
4. 外部アプリやブラウザから呼ぶ場合は、必要に応じて **CORS 許可オリジン** を設定に追加する。

### 設定ファイルの場所

トークンは UI のほか、設定 JSON からも確認できます。

- Windows: `%APPDATA%\irodori-studio\settings.json`
- フィールド: `httpToken`, `httpPort`, `httpBindAddress`, `httpServerEnabled`

### 既定値

| 項目 | 既定 |
|------|------|
| バインドアドレス | `127.0.0.1` |
| ポート | `50021`（使用中なら +1 ずつ最大 20 個試行。本 PC の VOICEVOX ENGINE が同ポートを使うと退避） |
| 自動分割上限 | `httpMaxChars` = 80 文字 |
| チャンク間無音 | アプリ設定の `chunkSilenceMs` |

---

## 認証

`/v1/*` および `/v1/concat-files` などネイティブ API は、すべて次のヘッダが必要です。

```http
Authorization: Bearer <APIトークン>
```

| HTTP ステータス | 意味 |
|-----------------|------|
| `401 Unauthorized` | `Authorization` ヘッダがない、または `Bearer ` 形式でない |
| `403 Forbidden` | トークンが不一致 |
| `503 Service Unavailable` | トークン未設定（通常は起動時に自動生成される） |

VOICEVOX 互換ルートは **接続元 IP がループバックのときのみ** 認証をスキップします。`0.0.0.0` で待ち受けていても、LAN 上の別マシンから VOICEVOX 互換 API を無認証で使うことはできません。

---

## 動作確認の進め方

### 1. ヘルスチェック（最速）

```powershell
$token = "<設定画面からコピーしたトークン>"
$base = "http://127.0.0.1:50021"

Invoke-RestMethod -Uri "$base/v1/health" -Headers @{ Authorization = "Bearer $token" }
```

`ok: true` と `features` が返ればサーバーは稼働中です。`worker.busy: true` のときは UI または別リクエストが合成中です。

### 2. 話者一覧

```powershell
Invoke-RestMethod -Uri "$base/v1/speakers" -Headers @{ Authorization = "Bearer $token" }
```

レスポンスの `speakers[].id` を以降の `speaker` パラメータに使います（埋め込みファイルのパス文字列）。`styleId` は VOICEVOX 互換用の整数 ID です。

### 3. 単発合成

```powershell
$body = @{
  text    = "こんにちは、これは API のテストです。"
  speaker = "<speakers[].id>"
  format  = "wav"      # wav | flac
  split   = $true      # 既定 true（長文を pack 分割）
} | ConvertTo-Json

Invoke-WebRequest -Uri "$base/v1/synthesize" -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $body -OutFile test.wav
```

`test.wav` を再生して確認します。

### 4. ジョブ（複数行・非同期）

```powershell
$jobBody = @{
  lines = @(
    @{ text = "一行目です。"; speaker = "<id>" }
    @{ text = "二行目です。"; speaker = "<id>" }
  )
  split = $false   # jobs の既定は false（行ごとに1発話）
} | ConvertTo-Json -Depth 5

$job = Invoke-RestMethod -Uri "$base/v1/jobs" -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $jobBody

$jobId = $job.jobId
```

完了までポーリング:

```powershell
do {
  Start-Sleep -Seconds 1
  $status = Invoke-RestMethod -Uri "$base/v1/jobs/$jobId" `
    -Headers @{ Authorization = "Bearer $token" }
  $status.status
} while ($status.status -in @("queued", "running"))
```

行音声の取得（`lines[0].ready` が true のとき）:

```powershell
Invoke-WebRequest -Uri "$base/v1/jobs/$jobId/lines/0" `
  -Headers @{ Authorization = "Bearer $token" } -OutFile line0.wav
```

ジョブ内の完了行を連結:

```powershell
Invoke-WebRequest -Uri "$base/v1/jobs/$jobId/concat" -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"format":"wav"}' -OutFile job_concat.wav
```

### 5. 一括合成＋連結（`/v1/concat`）

複数行を **同期的に** 合成して1ファイルに連結します（ジョブより待ち時間は長いが手順は単純）。

```powershell
$body = @{
  lines = @(
    @{ text = "はじめ"; speaker = "<id>" }
    @{ text = "おわり"; speaker = "<id>" }
  )
  format = "mp3"   # wav | mp3 | m4b
  split  = $true
} | ConvertTo-Json -Depth 5

Invoke-WebRequest -Uri "$base/v1/concat" -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $body -OutFile concat.mp3
```

### 6. VOICEVOX 互換（ループバック・無認証）

```powershell
# 話者（整数 style ID）
$vvSpeakers = Invoke-RestMethod -Uri "$base/speakers"
$styleId = $vvSpeakers[0].styles[0].id

# audio_query
$query = Invoke-RestMethod -Uri "$base/audio_query?text=テストです&speaker=$styleId" -Method POST

# synthesis（WAV バイナリ）
Invoke-WebRequest -Uri "$base/synthesis?speaker=$styleId" -Method POST `
  -ContentType "application/json" `
  -Body ($query | ConvertTo-Json -Depth 10) `
  -OutFile vv_test.wav
```

`audio_query` のレスポンスには Irodori 拡張フィールド `irodori`（原文と分割チャンク）が含まれます。`synthesis` はこのチャンク列を使って合成します。

### 7. 一括自動テスト

リポジトリ同梱のスクリプトで主要エンドポイントを順に試せます。**Windows では Node 版を推奨**（PowerShell 5.1 は UTF-8 / JSON で癖があります）。読み上げテキストは `scripts/test-http-api-phrases.json`（日本語）から読み込みます。

```powershell
cd "C:\Users\elonk\Irodori Studio"
$env:IRODORI_API_TOKEN = "<トークン>"
node scripts/test-http-api.mjs
# または
npm run test:api
```

リクエスト JSON を保存する場合: `node scripts/test-http-api.mjs --save-bodies`

話者 ID を省略すると `/v1/speakers` の先頭を使用します。文言を変えたいときは JSON を編集してください。

---

## ネイティブ API リファレンス（`/v1`）

JSON のキーは **camelCase** です。

### `GET /v1/health`

認証: 必要

稼働状況と機能フラグを返します。

```json
{
  "ok": true,
  "name": "Irodori Studio",
  "version": "0.6.1",
  "features": {
    "synthesize": true,
    "jobs": true,
    "concat": true,
    "concatFiles": true,
    "speed": true,
    "split": true,
    "voicevoxCompat": true,
    "formats": {
      "chunk": ["wav", "flac"],
      "concat": ["wav", "mp3", "m4b"]
    }
  },
  "worker": { "running": true, "loaded": true, "busy": false }
}
```

### `GET /v1/speakers`

認証: 必要

```json
{
  "speakers": [
    {
      "id": "C:/path/to/outputs/embeddings/foo.safetensors",
      "name": "話者名",
      "kind": "embedding",
      "styleId": 1,
      "tags": ["tag"],
      "gender": "女性",
      "ageRange": "20代"
    }
  ]
}
```

`id` がネイティブ API の `speaker` に渡す値です。

### `POST /v1/synthesize`

認証: 必要  
レスポンス: 音声バイナリ（`Content-Type: audio/wav` または `audio/flac`）

| フィールド | 型 | 既定 | 説明 |
|------------|-----|------|------|
| `text` | string | — | 読み上げテキスト（必須） |
| `speaker` | string | — | `/v1/speakers` の `id`（必須） |
| `format` | string | `wav` | `wav` / `flac` |
| `split` | bool | `true` | 長文を句読点ベースで pack 分割 |
| `maxChars` | number | 設定値 | 1 チャンク上限文字数 |
| `speed` | number | `1.0` | 話速 |
| `volume` | number | `1.0` | 音量 |
| `silenceMs` | number | 設定値 | チャンク間無音（ミリ秒） |

処理パイプライン: **辞書置換 → 分割（split 時）→ 合成 → speed/volume 適用**

### `POST /v1/jobs`

認証: 必要  
レスポンス: `{ "jobId": "<uuid>" }`

| フィールド | 型 | 既定 | 説明 |
|------------|-----|------|------|
| `lines` | array | — | `{ "text", "speaker" }` の配列（必須） |
| `format` | string | `wav` | 行ごとの出力形式 `wav` / `flac` |
| `split` | bool | `false` | 各行内での pack 分割 |
| `maxChars` | number | 設定値 | |
| `speed` | number | `1.0` | 各行に適用 |
| `volume` | number | `1.0` | 各行に適用 |
| `silenceMs` | number | 設定値 | 行内チャンク間無音 |

ジョブはバックグラウンドで **1 行ずつ順次** 合成します（UI と同じ OPT ワーカーを共有するため、同時並列はしません）。

### `GET /v1/jobs/{id}`

認証: 必要

```json
{
  "jobId": "...",
  "status": "completed",
  "format": "wav",
  "error": null,
  "total": 2,
  "completed": 2,
  "lines": [
    { "index": 0, "status": "done", "durationSecs": 1.2, "error": null, "ready": true }
  ]
}
```

`status`: `queued` | `running` | `completed` | `failed` | `cancelled`  
行 `status`: `pending` | `running` | `done` | `failed` | `cancelled`

### `GET /v1/jobs/{id}/lines/{n}`

認証: 必要  
レスポンス: 行の音声バイナリ。未完了時は `409 Conflict`。

`n` は **0 始まり** の行インデックスです。

### `POST /v1/jobs/{id}/cancel`

認証: 必要  
レスポンス: `{ "ok": true, "jobId": "..." }`

実行中の行は完了後にキャンセルが反映され、待機中の行は `cancelled` になります。

### `POST /v1/jobs/{id}/concat`

認証: 必要  
レスポンス: 連結音声バイナリ

ジョブ内で **完了済み** の行だけを順番に連結します（再合成なし）。

| フィールド | 型 | 既定 | 説明 |
|------------|-----|------|------|
| `format` | string | `wav` | `wav` / `mp3` / `m4b` |
| `silenceMs` | number | 設定値 | 行間無音 |
| `speed` | number | `1.0` | 連結時の話速 |
| `volume` | number | `1.0` | 連結時の音量 |

### `POST /v1/concat`

認証: 必要  
レスポンス: 連結音声バイナリ

リクエスト body は `POST /v1/jobs` と同型の `lines` に加え、`format`（連結出力: `wav`/`mp3`/`m4b`）、`split`（既定 `true`）、`speed`/`volume`（連結セグメントに適用）を指定します。  
各行を合成してから ffmpeg で連結する **同期** API です。

### `POST /v1/concat-files`

認証: 必要  
レスポンス: 連結音声バイナリ  
Content-Type: `multipart/form-data`

アップロード済み WAV を順に連結します（Chrome 拡張のページキャッシュ保存などで使用）。

| パート名 | 説明 |
|----------|------|
| `files` | WAV ファイル（複数、出現順が連結順） |
| `silenceMs` / `silence_ms` | 任意。行間無音（ミリ秒） |
| `format` | 任意。`wav` / `mp3` / `m4b` |

---

## VOICEVOX 互換 API

ベース URL はネイティブ API と同じポートです。パスは VOICEVOX ENGINE に準拠します。

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/version` | バージョン文字列 |
| GET | `/engine_manifest` | エンジン情報 |
| GET | `/speakers` | 話者一覧（整数 `style.id`） |
| GET | `/speaker_info?speaker={id}` | 話者詳細 |
| POST | `/audio_query?text=...&speaker={id}` | AudioQuery JSON（分割メタ付き） |
| POST | `/synthesis?speaker={id}` | AudioQuery を body に WAV 合成 |
| POST | `/initialize_speaker?speaker={id}` | 互換用 no-op（常に成功） |
| GET | `/is_initialized_speaker?speaker={id}` | 互換用（常に true） |

**相違点**

- 音素レベルの `AudioQuery` はダミー構造です。実際の分割は `irodori.chunks` で行います。
- `synthesis` 内では `split: false` でチャンク列を合成します（`audio_query` 時点で既に分割済み）。
- 話者 ID は Outputs 内の embedding ごとに割り当てられる **整数** です。`/v1/speakers` の `styleId` と一致します。

---

## CORS（ブラウザから呼ぶ場合）

設定で次を制御できます。

- **Chrome 拡張を許可**（既定オン）: `chrome-extension://` オリジンを自動許可
- **許可オリジン一覧**: 完全一致（例: `http://localhost:3000`）

ブラウザのページから `127.0.0.1` の API を呼ぶには、そのページのオリジンを許可リストに追加してください。

---

## 制限・注意

- **同時リクエスト**: OPT ワーカーは1つです。合成中は他の合成リクエストがブロックされます。`GET /v1/health` の `worker.busy` で確認できます。
- **ループバック以外**: `httpBindAddress` を `0.0.0.0` にすると LAN から到達可能になりますが、**トークンは秘密情報**として扱ってください。
- **話者 ID**: ネイティブ API は embedding パス文字列、VOICEVOX 互換は整数 ID です。混同しないでください。
- **ジョブの保持**: ジョブデータはメモリ上です。Studio を終了すると失われます。
- **リクエストサイズ**: ボディ上限は 512 MiB です。

---

## curl 例（参考）

```bash
export BASE=http://127.0.0.1:50021
export TOKEN="<トークン>"

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/health" | jq .

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/speakers" | jq .

curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"テスト","speaker":"<id>"}' \
  "$BASE/v1/synthesize" -o out.wav
```

---

## 関連

- アプリ内: **設定 → ローカル HTTP サーバー**
- Chrome 拡張: `chrome-extension/README.md`
- リポジトリ README の機能概要
