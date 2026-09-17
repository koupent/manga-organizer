# Manga Organizer - 開発者ドキュメント

このドキュメントは、Manga Organizer の開発者向け情報です。

## 目次

- [開発環境のセットアップ](#開発環境のセットアップ)
- [Local Merge Gate](#local-merge-gate)
- [ビルドとリリース](#ビルドとリリース)
- [バージョンアップ手順](#バージョンアップ手順)
- [プロジェクト構造](#プロジェクト構造)
- [コーディング規約](#コーディング規約)

## 開発環境のセットアップ

### 必要環境

- Docker Desktop（Linux Dev Container）
- Windows ホスト（exe ビルド時）
- Python 3.11（`services/core/pyproject.toml` の `requires-python`）
- uv
- Git / GitHub CLI

### 手順

```bash
git clone https://github.com/koupent/manga-organizer.git
cd manga-organizer
```

1. Cursor / VS Code で Dev Container を再作成する
2. アプリ依存を同期する（`postCreateCommand` でも実行されます）

```bash
cd services/core
uv sync --group dev
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

## ビルドとリリース

タグ push では何も起動しません。Actions は `workflow_dispatch` 専用の照合・公開だけを行います。

### Windows ホストでの成果物作成

```bash
# リポジトリルート（Git Bash）
bash scripts/build_release_artifact.sh
# 成果物: .artifacts/MangaOrganizer.exe
```

現時点で `scripts/build_release_artifact.sh` は未実装として失敗します。旧
Tkinter アプリの PyInstaller 経路は #28 で撤去済みで、Tauri シェルと Python
サイドカーを 1 つのインストーラへまとめる処理はまだありません。サイドカー
単体の梱包は `scripts/build_sidecar.sh` にあります。

### 公開と CD 起動

`scripts/publish_release_artifact.mjs` が成果物を不変 prerelease として公開し、`artifactRef` を stdout へ JSON で返します。

```bash
ENGINEERING_DELIVERY_ARTIFACT_PATH=.artifacts/MangaOrganizer.exe \
ENGINEERING_DELIVERY_ARTIFACT_SHA256=<sha256> \
ENGINEERING_DELIVERY_ARTIFACT_SIZE=<bytes> \
ENGINEERING_DELIVERY_SOURCE_COMMIT=<40桁 commit> \
ENGINEERING_DELIVERY_SOURCE_TREE=<40桁 tree> \
  node scripts/publish_release_artifact.mjs
```

続けて `.github/workflows/release.yml` を一度だけ起動します。digest 照合後、製品向け GitHub Release へ exe が添付されます。

```bash
gh workflow run release.yml \
  -f artifact_ref=<上の artifactRef> \
  -f artifact_sha256=<sha256> \
  -f source_commit=<commit> \
  -f source_tree=<tree>
```

非 Windows では `scripts/build_release_artifact.sh` は失敗します。

## バージョンアップ手順

1. 次の 4 箇所の version を同じ値に更新する（`release.yml` が一致を検証し、食い違うと公開が止まります）

   - `apps/desktop/src-tauri/tauri.conf.json` — exe に刻まれる正本
   - `apps/desktop/src-tauri/Cargo.toml`
   - `apps/desktop/package.json`
   - `services/core/pyproject.toml`

2. PR 経由で main へ squash merge（Local Merge Gate 必須）
3. Windows ホストでビルド・公開し、`release.yml` を起動する（[ビルドとリリース](#ビルドとリリース)）

## プロジェクト構造

```
manga-organizer/                 # リポジトリルート
├── apps/desktop/                # Tauri シェル + React フロントエンド
│   ├── src/                     # React + TypeScript
│   ├── e2e/                     # Playwright
│   └── src-tauri/               # Rust
├── services/core/               # コアロジックとサイドカー API
│   ├── src/manga_core/
│   ├── src/manga_api/
│   ├── tests/
│   ├── pyproject.toml
│   ├── uv.lock
│   └── manga_api.spec           # サイドカーの PyInstaller 定義
├── scripts/
│   ├── run_merge_gate.sh
│   ├── build_sidecar.sh
│   ├── build_release_artifact.sh
│   └── publish_release_artifact.mjs
├── .devcontainer/               # Dev Container 定義（devcontainer.json / Dockerfile.project）
├── .github/workflows/release.yml
├── CLAUDE.md
└── DEVELOPMENT.md
```

## コーディング規約

- Python は ruff（`services/core/pyproject.toml` の `[tool.ruff]`）に従う
- ブランチ: `feature/issue-<番号>-...` / `fix/issue-<番号>-...`
- コミットメッセージ: `# <Issue番号> <接頭辞>: <概要>`
- main へのマージは squash のみ

## トラブルシューティング

### tkinter が見つからない（Linux）

```bash
sudo apt-get install python3-tk
```
