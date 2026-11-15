# Manga Organizer

Windows 向け漫画アーカイブ整理アプリです。Tauri シェル + React フロントエンド + Python サイドカーで構成します。

## 開発の場

実装は Claude Code のクラウド（claude.ai/code）で行い、変更は PR で出します。Docker / Orca の開発コンテナは廃止しました。詳細は `DEVELOPMENT.md` を参照してください。

## 品質ゲート（CI）

PR ごとに GitHub Actions（`.github/workflows/ci.yml`）が `Merge Gate`（ubuntu）と `Core (Windows)`（コアのテストを Windows で）を回し、main への合流は `Merge Gate` の合格が条件です。中身は `scripts/run_merge_gate.sh` が正本で、セッション内でも同じものを回せます。直前のコミットから版の番号だけが変わった追記は、宣言の一致だけ確かめてこの 2 つは回しません。

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

インストーラは GitHub Actions の Windows ランナーで、`v*` タグのときに作ります（`.github/workflows/release.yml`）。確かめたうえで、このリポジトリの Release にインストーラと自動更新の案内（`latest.json`）を載せます（アプリはログインせずに落とすので、リポジトリは public）。手動実行は Artifacts に残すだけです。プルリクエストでは作りません。署名鍵は Secrets にあります（`DEVELOPMENT.md` の「自動更新」）。署名鍵とパスワードの控えは、利用者の Google Drive（マイドライブ > GitHub > manga-orgaizer）にあります。

```bash
# 4 か所の version（tauri.conf.json / Cargo.toml / package.json / pyproject.toml）を揃え、必須 CI を通して main へマージした後に実行
git fetch origin && git tag v4.0.0 origin/main && git push origin v4.0.0   # Release が作られ MangaOrganizer-v4.0.0-setup.exe が添付される
```

利用者から「リリースしてください」と依頼された場合、その依頼にはエージェントによるリリースタグの作成・push と公開までの代行を含みます。タグ操作のために再度承認を求めたり、利用者に操作を差し戻したりせず、必須 CI の成功、main へのマージ、タグと版の一致を確認して実行してください。タグの push 後はリリースワークフローの成功と配布物（インストーラ・latest.json）の公開まで確認します。

以前のクラウド環境のタグ push 制限を、現在もある前提で扱わないでください。実際に権限や接続の問題で失敗した場合は、使える正規の接続手段を確認し、それでも進められないときだけ具体的なエラーと残作業を利用者に伝えてください。既存タグの付け替えや必須チェックの回避は行いません。

## 主な場所

- `services/core/` — GUI 非依存のコアロジック（`manga_core`）とサイドカー API（`manga_api`）
- `apps/desktop/` — React + TypeScript のフロントエンド（Playwright で検証）
- `apps/desktop/src-tauri/` — Tauri シェル（Rust）
- `scripts/run_merge_gate.sh` — Merge Gate の中身（`.github/workflows/ci.yml` が回す）
- `scripts/build_sidecar.sh` — サイドカーを PyInstaller で梱包して Tauri の資材へ置く
- `.github/workflows/release.yml` — Windows インストーラのビルドと Release
