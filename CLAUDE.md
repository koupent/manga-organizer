# Manga Organizer

Windows 向け漫画アーカイブ整理アプリです。Tauri シェル + React フロントエンド + Python サイドカーで構成します。

## 開発の場

実装は Claude Code のクラウド（claude.ai/code）で行い、変更は PR で出します。Docker / Orca の開発コンテナは廃止しました。詳細は `DEVELOPMENT.md` を参照してください。

## 品質ゲート（CI）

PR ごとに GitHub Actions（`.github/workflows/ci.yml`）が `Merge Gate`（ubuntu）と `Core (Windows)`（コアのテストを Windows で）を回し、main への合流は `Merge Gate` の合格が条件です。中身は `scripts/run_merge_gate.sh` が正本で、セッション内でも同じものを回せます。

```bash
bash scripts/run_merge_gate.sh
```

対象は `services/core/` の `uv lock --check`・`ruff`・`compileall`・`unittest`、`apps/desktop/` の型検査・ビルド・Playwright、Tauri シェルの `cargo fmt`・`clippy`・`test` です。cargo には `libwebkit2gtk-4.1-dev` などが、`tauri.conf.json` の resources には `apps/desktop/src-tauri/resources/sidecar/` に何かのファイルが要ります（無ければ空ファイルを置く）。

## 動作確認

```bash
# ブラウザで画面を見る（http://127.0.0.1:5173/?token=dev）
(cd services/core && uv run python -m manga_api --port 8765 --token dev) &
(cd apps/desktop && npm run dev)

# Windows（Git Bash）: デスクトップアプリとして動かす
bash scripts/build_sidecar.sh
cd apps/desktop && npx tauri dev
```

## 成果物配信

インストーラは GitHub Actions の Windows ランナーで作ります（`.github/workflows/release.yml`）。配布物の作り方に関わるファイルを変えた PR では自動で走り、インストーラを Artifacts に残します（実機での確認用）。手動実行も Artifacts に残すだけです。タグでは、配布用の公開リポジトリ `koupent/manga-organizer-releases` にインストーラと自動更新の案内（`latest.json`）を載せます。署名鍵と公開リポジトリへのトークンは Secrets にあります（`DEVELOPMENT.md` の「自動更新」）。署名鍵とパスワードの控えは、利用者の Google Drive（マイドライブ > GitHub > manga-orgaizer）にあります。

```bash
# 4 か所の version（tauri.conf.json / Cargo.toml / package.json / pyproject.toml）を揃えて main へマージした後、利用者が手元で
git fetch origin && git tag v4.0.0 origin/main && git push origin v4.0.0   # Release が作られ MangaOrganizer-v4.0.0-setup.exe が添付される
```

クラウドのセッションからはタグを push できません（作業ブランチ以外への push は 403）。タグは打とうとせず、上の 1 行を利用者に頼んでください。

## 主な場所

- `services/core/` — GUI 非依存のコアロジック（`manga_core`）とサイドカー API（`manga_api`）
- `apps/desktop/` — React + TypeScript のフロントエンド（Playwright で検証）
- `apps/desktop/src-tauri/` — Tauri シェル（Rust）
- `scripts/run_merge_gate.sh` — Merge Gate の中身（`.github/workflows/ci.yml` が回す）
- `scripts/build_sidecar.sh` — サイドカーを PyInstaller で梱包して Tauri の資材へ置く
- `.github/workflows/release.yml` — Windows インストーラのビルドと Release
