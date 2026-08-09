# Irodori Studio

Irodori-TTS 向け Speaker Embedding 学習 + OPT 生成フロントエンド（Tauri 2 / React / TypeScript）。

## 説明動画

操作の流れは以下の動画を参照してください。

[![Irodori Studio 説明動画](https://img.youtube.com/vi/19eGabJSkBw/maxresdefault.jpg)](https://youtu.be/19eGabJSkBw)

https://youtu.be/19eGabJSkBw

## 機能概要

- **設定**: IrodoriTTS v3 / v4 切替、ルート・Checkpoint・Outputs・Python パスの検証、precision
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
  - 初回の既定ルート（未設定時）: ドキュメント配下の `IrodoriTTS` / `IrodoriTTS-v4`
  - 実インストール先が違う場合は設定画面でパスを指定
- 設定画面でエンジン版（v3 / v4）を選択。版ごとにルート / Checkpoint / Outputs / Python を保持
- venv: `{irodoriRoot}\.venv\Scripts\python.exe`
- Checkpoint 例:
  - v3: `...\checkpoints\Aratako_Irodori-TTS-500M-v3\model.safetensors`
  - v4: `...\checkpoints\Aratako_Irodori-TTS-v4-Small\model.safetensors`（または HF キャッシュ）
- **v3 Embedding は v4 非互換**（再学習が必要）。Outputs も版ごとに分けること
- PATH に `ffmpeg` があること

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
