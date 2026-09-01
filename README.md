# Irodori Studio

Irodori-TTS 向け Speaker Embedding 学習 + OPT 生成フロントエンド（Tauri 2 / React / TypeScript）。

## 説明動画

操作の流れは以下の動画を参照してください。

[![Irodori Studio 説明動画](https://img.youtube.com/vi/amY91Y1t_7g/maxresdefault.jpg)](https://youtu.be/amY91Y1t_7g)

https://youtu.be/amY91Y1t_7g

## 機能概要

- **設定**: 初回はルート指定、Outputs / Python / Checkpoint の自動推定、v3 / v4 切替、precision / device、ライト／ダーク差し色
- **ライブ**: マイク音声認識（ローカル sherpa-onnx または Web Speech）から即合成。自動キュー／テキスト欄、WASAPI による出力デバイス切替（仮想ケーブル可）、エコー対策
- **話者**: 埋め込み・ブレンド・参照音源・キャプションの一覧、メタデータ（本名・性別・年齢帯・タグ）、検索・並び替え・種別/タグフィルタ、一覧のサイド表示、リネーム／削除（ゴミ箱へ）。参照 wav の区間トリム
- **学習**: 元音声・動画から（to_wav → slice）またはスライス済みフォルダから → 任意のボーカル分離 → 任意の話者分離 → スライス Auto Fix → スライスレビュー → dataset → prepare_manifest → train。中断からの再開、スライスは無音分割または Silero VAD
- **スライスレビュー**: slice 後の外れ値チェック（長さ・速度・無音・音量・話者一貫・スペクトルなど）。人手確認 / 自動除外 / スキップ。Auto Fix の処理前/処理後の聴き比べ。話者クラスタのフィルタと学習対象選択
- **ブレンド**: 2〜3 embedding を三角プロットで線形ミックス。保存前の合成チェック（仮ブレンドして試聴）
- **生成**: Aivis 風 3 カラム UI、行単位の Sampling、複数生成（Num Candidate / 個別）、バリアント再生。Audio Adjustment の追加調整（EQ / デノイズ / 平坦化）。波形上のトリム、行の音声入力。要再生成時に何が変わったかを表示。非選択行のコンパクト表示（既定オン）。複数選択の一括削除、テキスト追加時の既存行置き換え
- **読み注釈**: 英単語・同形異音・数字（助数詞含む）を検出し、表示テキストはそのまま・合成時だけ読みを差し替え。確認ダイアログで差し替え箇所をハイライト。辞書に載る読みは合成時に自動適用
- **一括追加**: 区切り文字チップでスクリプトを分割。txt / md / docx / pdf のプレビュー取り込み
- **再生・保存**: 連続再生、連結保存、セリフ別一括エクスポート。WAV / MP3 / Opus、ファイル名の並び変更
- **文字起こし検証**: Whisper small（CPU）で CER を確認
- **辞書**: 置換辞書と読み辞書（英単語 / 同形異音 / 数字の追加候補）。■ などの装飾記号は初回に空変換の候補として入る
- **ローカル HTTP API**: Studio 起動中に Bearer トークン付きで合成・連結を呼べる（既定は 127.0.0.1:50021）。VOICEVOX 互換エンドポイント（`/audio_query` / `/synthesis` 等）も同じポートで提供（ループバックは認証なし）。長文は API 側で自動 pack 分割（`split` パラメータで制御）。外部連携・動作確認は [`docs/HTTP_API.md`](docs/HTTP_API.md) を参照
- **Irodori Studio Reader**: Chrome 拡張。開いているページの本文を抽出し、Studio で連続読み上げ。Google ドキュメントは書き出し API で本文を取得

生成エンジンは **OPT（フル精度）のみ**（Lite は使用しません）。

## 前提

- IrodoriTTS **v3** または **v4** がインストール済み
  - 初回起動時は設定画面で Irodori ルート（インストールフォルダ）を指定する
  - Outputs / Python / Checkpoint はそのルートから自動推定（手修正可）
  - 実インストール先が違う場合は設定画面でルートを選び直す
- 設定画面でエンジン版（v3 / v4）を選択。版ごとにルート / Checkpoint / Outputs / Python を保持
- venv: `{irodoriRoot}\.venv\Scripts\python.exe`
- Checkpoint は Hugging Face キャッシュを優先して自動推定します（`HF_HUB_CACHE` / `HF_HOME` / `%USERPROFILE%\.cache\huggingface\hub`）
  - v3: `...\hub\models--Aratako--Irodori-TTS-500M-v3\snapshots\<revision>\model.safetensors`
  - v4: `...\hub\models--Aratako--Irodori-TTS-v4.1-Small\snapshots\<revision>\model.safetensors`（無ければ v4-Small）
  - `<revision>` は Hugging Face のコミット ID（スナップショットフォルダ名）
  - ルート配下の `checkpoints/` はキャッシュに無いときの予備
- **v3 Embedding は v4 非互換**（再学習が必要）。Outputs も版ごとに分けること
- **ffmpeg / ffprobe はアプリ同梱**（Windows）。ユーザが別途インストールする必要はない

開発時は `npm run tauri dev` の前に `scripts/fetch-ffmpeg.mjs` が gyan.dev の essentials ビルドを `vendor/ffmpeg/` へ取得します。

## ダウンロード（ビルド済み）

[Releases](https://github.com/TK-design336/irodori-studio/releases) から次を入手できます。

- **Irodori Studio**: Windows インストーラ（NSIS setup 推奨、または MSI）
- **Irodori Studio Reader**: Chrome 拡張の zip（解凍してデベロッパーモードで読み込み）

### Studio Reader の入れ方

1. Irodori Studio を起動し、**設定 → ローカル HTTP サーバー** でトークンをコピーする
2. リリースの `Irodori.Studio.Reader_*.zip` を解凍する
3. Chrome の `chrome://extensions` でデベロッパーモードをオンにし、「パッケージ化されていない拡張機能を読み込む」で解凍したフォルダを選ぶ
4. Side Panel でベース URL とトークンを保存し、「接続テスト」する

詳細は `chrome-extension/README.md` を参照してください。

## 開発起動

```bash
npm install
npm run tauri dev
```

## アプリとしてビルド

```bash
npm install
npm run tauri build
```

成果物は `src-tauri/target/release/bundle/` 配下（Windows なら `msi` / `nsis` など）に出力されます。

## ライセンス

ソースコードのライセンスはリポジトリ内の表記に従ってください。Irodori-TTS 本体および関連モデルの利用条件は各プロジェクト側を確認してください。

同梱する FFmpeg バイナリは [gyan.dev essentials](https://www.gyan.dev/ffmpeg/builds/) 由来で、GPL 条件に従います。詳細は `vendor/ffmpeg/LICENSE.txt` を参照してください。
