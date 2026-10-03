# Manga Organizer - 開発者ドキュメント

このドキュメントは、Manga Organizer の開発者向け情報です。

## 目次

- [開発の場](#開発の場)
- [Merge Gate（CI）](#merge-gateci)
- [動作確認](#動作確認)
- [ビルドとリリース](#ビルドとリリース)
- [バージョンアップ手順](#バージョンアップ手順)
- [プロジェクト構造](#プロジェクト構造)
- [コーディング規約](#コーディング規約)

## 開発の場

実装は [Claude Code のクラウド](https://code.claude.com/docs/en/claude-code-on-the-web)（claude.ai/code）で行います。リポジトリを選んでセッションを始め、変更は PR として出します。手元に開発環境を作る必要はありません。

Windows でしか確かめられないもの（インストーラ、ネイティブのドラッグ&ドロップ）は、Actions が作ったインストーラを手元の PC へ入れて確かめます（[配る物そのものを試す](#配る物そのものを試す)）。

## Merge Gate（CI）

PR ごとに GitHub Actions（`.github/workflows/ci.yml`、ubuntu）が `scripts/run_merge_gate.sh` を回します。main への合流はこの `Merge Gate` チェックの合格が条件です。

実行内容:

- `services/core/` — `uv lock --check`・`ruff`・`compileall`・`unittest`
- OpenAPI スキーマ照合
- `apps/desktop/` — 型検査・ESLint・ビルド・Playwright
- Tauri シェル — `cargo fmt`・`clippy`・`test`

同じスクリプトは、uv・npm・cargo と Tauri のビルドに要るライブラリ（`libwebkit2gtk-4.1-dev` など）がある環境なら、クラウドのセッションでも手元でも回せます。

## 動作確認

### ブラウザで画面を見る

サイドカーを固定ポートとトークンで起動し、Vite の dev server が `/api` を中継します。

```bash
# 端末 1
cd services/core
uv run python -m manga_api --port 8765 --token dev

# 端末 2
cd apps/desktop
npm run dev
```

ブラウザで `http://127.0.0.1:5173/?token=dev` を開きます。辿れるのはサイドカーを動かしているマシンのファイルです。

ネイティブのドロップ（エクスプローラーからの実パス）だけはブラウザでは確かめられません。

### Windows でデスクトップアプリとして動かす

Windows の Git Bash で、サイドカーを一度作ってから Tauri を開発モードで起動します（Node 20・Rust・uv が要ります）。

```bash
bash scripts/build_sidecar.sh   # サイドカーを apps/desktop/src-tauri/resources/sidecar へ
cd apps/desktop
npm ci
npx tauri dev
```

インストーラまで作るときは `npx tauri build`（`apps/desktop/src-tauri/target/release/bundle/nsis/` に出ます）。サイドカーを変えたら `build_sidecar.sh` をやり直してください（`tauri build` は自分で作り直します）。

### 配る物そのものを試す

配布物の作り方に関わるファイルを変えた PR では、`.github/workflows/release.yml` が自動で走り、インストーラを Artifacts に残します。それ以外の変更を試したいときは手動で走らせます（Release は作りません）。

```bash
gh workflow run release.yml --ref <ブランチ名>   # または Actions の画面の「Run workflow」
```

終わったら実行結果の Artifacts から `MangaOrganizer-vX.X.X-setup.exe` を落とし、実機へ入れて確かめます。

## ビルドとリリース

インストーラは GitHub Actions の Windows ランナーで作ります（`.github/workflows/release.yml`）。作ったインストーラを黙って入れ、同梱のサイドカーが応答するところまで確かめます。

- PR: 配布物の作り方に関わるファイル（`src-tauri/`・依存の宣言・`manga_api.spec`・`build_sidecar.sh` など）を変えたときだけ走り、インストーラを Artifacts に残す
- `v*` タグの push: 作って確かめたうえで、タグ名の GitHub Release を作ってインストーラを添付する
- 手動（`workflow_dispatch`）: 作って確かめ、インストーラを Artifacts に残すだけ

Windows ランナーは分数が 2 倍に数えられるため、画面だけの変更では走らせません（そちらは Merge Gate で足ります）。

リポジトリが private なので、Release をダウンロードできるのはコラボレーターとして招待した人だけです。

## バージョンアップ手順

1. 次の 4 箇所の version を同じ値に更新し、lock を作り直す（`release.yml` が一致を検証し、食い違うと止まります）

   - `apps/desktop/src-tauri/tauri.conf.json` — インストーラに刻まれる正本
   - `apps/desktop/src-tauri/Cargo.toml`（`Cargo.lock` は `cargo update -p manga-organizer-desktop`）
   - `apps/desktop/package.json`（`package-lock.json` の自分の version も）
   - `services/core/pyproject.toml`（`uv.lock` は `uv lock`）

2. PR 経由で main へ squash merge（Merge Gate 必須）
3. main の先頭にタグを打って push する。**タグは利用者が手元の Git から打ちます。** クラウドのセッションからは作業ブランチ以外へ push できず、タグは HTTP 403 で弾かれます

   ```bash
   git fetch origin && git tag v4.0.0 origin/main && git push origin v4.0.0
   ```

4. Actions の「Windows インストーラ」が緑になると、Releases に `MangaOrganizer-v4.0.0-setup.exe` が載る

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
│   ├── run_merge_gate.sh        # Merge Gate の中身
│   └── build_sidecar.sh         # サイドカーを PyInstaller で梱包
├── .github/workflows/
│   ├── ci.yml                   # Merge Gate（PR ごと）
│   └── release.yml              # Windows インストーラと Release
├── CLAUDE.md
└── DEVELOPMENT.md
```

## コーディング規約

- Python は ruff（`services/core/pyproject.toml` の `[tool.ruff]`）に従う
- ブランチ: `feature/issue-<番号>-...` / `fix/issue-<番号>-...`
- コミットメッセージ: `# <Issue番号> <接頭辞>: <概要>`
- main へのマージは squash のみ
