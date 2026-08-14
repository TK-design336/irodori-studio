# Irodori Studio

Irodori-TTS 向け Speaker Embedding 学習 + OPT 生成フロントエンド（Tauri 2 / React / TypeScript）。

## 説明動画

操作の流れは以下の動画を参照してください。

[![Irodori Studio 説明動画](https://img.youtube.com/vi/19eGabJSkBw/maxresdefault.jpg)](https://youtu.be/19eGabJSkBw)

https://youtu.be/19eGabJSkBw

## 機能概要

- **設定**: 初回はルート指定、Outputs / Python / Checkpoint の自動推定、v3 / v4 切替、precision
- **学習**: 元音声・動画から（to_wav → slice）またはスライス済みフォルダから → dataset → prepare_manifest → train
- **ブレンド**: 2 embedding をスライダーで線形ミックス
- **生成**: Aivis 風 3 カラム UI、行単位の追加・Sampling パラメータ、個別再生 / 保存
- **一括追加**: 区切り文字チップでスクリプトを分割してライン一覧へ流し込み
- **カタカナ提案**: 英単語を検出し alkana でカタカナ候補を提示（一括 / 個別承認）
- **再生・保存**: 連続再生、連結 WAV 保存、セリフ別一括エクスポート、音量・スピード反映
- **辞書**: 同形異義語などの辞書ビュー

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

[Releases](https://github.com/TK-design336/irodori-studio/releases) からインストーラを入手できます。

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
