# Manga Organizer - 開発者ドキュメント

このドキュメントは、Manga Organizer の開発者向け情報です。

## 目次

- [開発基盤](#開発基盤)
- [開発環境のセットアップ](#開発環境のセットアップ)
- [Local Merge Gate](#local-merge-gate)
- [ビルドとリリース](#ビルドとリリース)
- [バージョンアップ手順](#バージョンアップ手順)
- [プロジェクト構造](#プロジェクト構造)
- [コーディング規約](#コーディング規約)

## 開発基盤

正本は次の2つです。

- Engineering Dev Foundation v0.8.0（`.dev-foundation/`）
- Engineering Workflow Plugin v0.15.0 + 公式 ECC v2.2.0（`.engineering-workflow/`）

固定 SHA:

- Foundation: `.dev-foundation/foundation.lock.json`
- Plugin / ECC: `.engineering-workflow/workflow-plugin.lock.json`

Dev Container は Foundation が生成します。製品固有設定の正本は `.devcontainer/devcontainer.project.json` と `.devcontainer/Dockerfile.project` です。

## 開発環境のセットアップ

### 必要環境

- Docker Desktop（Linux Dev Container）
- Windows ホスト（exe ビルド時）
- Python 3.11（アプリ側は `manga-organizer/.python-version`）
- uv
- Git / GitHub CLI

### 手順

```bash
git clone https://github.com/koupent/manga-organizer.git
cd manga-organizer
```

1. Cursor / VS Code で Dev Container を再作成する
2. コンテナ内で Plugin を導入する

```bash
bash scripts/install_workflow.sh
```

3. アプリ依存を同期する（`postCreateCommand` でも実行されます）

```bash
cd manga-organizer
uv sync --group dev
uv run python src/main.py
```

## Local Merge Gate

品質判定は GitHub Actions ではなくローカル必須です。

```bash
bash scripts/run_merge_gate.sh
bash scripts/run_merge_gate.sh --publish-status
```

実行内容（`manga-organizer/` 配下）:

- `uv lock --check`
- `uv run ruff check src`
- `uv run ruff format --check src`
- `uv run python -m compileall -q src`

`--publish-status` は GitHub の `Local Merge Gate` commit status を更新します。

Repository policy のローカル検証:

```bash
node <plugin-root>/scripts/repository-policy.mjs verify --local-only --project-dir .
```

## ビルドとリリース

タグ push では何も起動しません。Actions は `workflow_dispatch` 専用の照合・公開だけを行います。

### Windows ホストでの成果物作成

```bash
# リポジトリルート（Git Bash）
bash scripts/build_release_artifact.sh
# 成果物: .artifacts/MangaOrganizer.exe
```

公開と CD 起動は Plugin の local-delivery 境界を使います。

```bash
node <plugin-root>/scripts/local-delivery.mjs prepare --project-dir .
node <plugin-root>/scripts/local-delivery.mjs dispatch --project-dir .
```

`prepare` は Local Merge Gate → Windows ビルド → 不変 prerelease 公開までを行います。`dispatch` は `.github/workflows/release.yml` を一度だけ起動し、digest 照合後に製品向け GitHub Release へ exe を添付します。

非 Windows では `scripts/build_release_artifact.sh` は失敗します。

### 従来のローカルビルド

```bash
cd manga-organizer
uv run pyinstaller MangaOrganizer.spec
```

## バージョンアップ手順

1. `manga-organizer/src/__version__.py` と `manga-organizer/pyproject.toml` の version を更新
2. `manga-organizer/CHANGELOG.md` を更新
3. PR 経由で main へ squash merge（Local Merge Gate 必須）
4. Windows ホストで local-delivery の prepare / dispatch を実行

## プロジェクト構造

```
manga-organizer/                 # リポジトリルート
├── manga-organizer/             # アプリ本体
│   ├── src/
│   ├── pyproject.toml
│   ├── uv.lock
│   ├── MangaOrganizer.spec
│   └── .python-version
├── scripts/
│   ├── run_merge_gate.sh
│   ├── build_release_artifact.sh
│   ├── publish_release_artifact.mjs
│   └── install_workflow.sh
├── .devcontainer/               # Foundation 生成層 + Project Layer
├── .dev-foundation/
├── .engineering-workflow/
├── .github/workflows/release.yml
├── CLAUDE.md
└── DEVELOPMENT.md
```

## コーディング規約

- Python は ruff（`manga-organizer/pyproject.toml` の `[tool.ruff]`）に従う
- ブランチ: `feature/issue-<番号>-...` / `fix/issue-<番号>-...`
- コミットメッセージ: `# <Issue番号> <接頭辞>: <概要>`
- main へのマージは squash のみ

## トラブルシューティング

### tkinter が見つからない（Linux）

```bash
sudo apt-get install python3-tk
```

### Foundation doctor

```bash
node <foundation-root>/bin/dev-foundation.mjs doctor --project-dir .
```

### Plugin の再導入

```bash
bash scripts/install_workflow.sh
```
