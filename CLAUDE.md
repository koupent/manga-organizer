# Manga Organizer

Windows 向け漫画アーカイブ整理アプリです。Tauri シェル + React フロントエンド + Python サイドカーで構成します。

## 開発基盤

常駐 Docker（`docker/`）の中で開発し、[Orca ADE](https://www.onorca.dev/) から SSH（`127.0.0.1:2223` / user `node`）で接続します。

```bash
# Windows ホスト
cp docker/authorized_keys.example docker/authorized_keys
cat ~/.ssh/id_manga_organaizer_orca.pub >> docker/authorized_keys
bash scripts/dev-up.sh

# SSH 先（初回）
bash scripts/dev-setup.sh
```

詳細は `DEVELOPMENT.md` を参照してください。

## 品質ゲート

コード品質は GitHub Actions ではなくローカル必須です（開発コンテナ内）。

```bash
bash scripts/run_merge_gate.sh
bash scripts/run_merge_gate.sh --publish-status
```

対象は `services/core/` の `uv lock --check`・`ruff`・`compileall`・`unittest`、`apps/desktop/` の型検査・ビルド・Playwright、Tauri シェルの `cargo fmt`・`clippy`・`test` です。

`--publish-status` は GitHub の `Local Merge Gate` commit status を HEAD へ publish します。

## 動作確認

```bash
# 開発コンテナ: ブラウザで画面を見る（http://127.0.0.1:5173/?token=dev）
(cd services/core && uv run python -m manga_api --port 8765 --token dev) &
(cd apps/desktop && npm run dev)

# Windows ホスト（Git Bash）: デスクトップアプリとして動かす
bash scripts/build_sidecar.sh
cd apps/desktop && npx tauri dev
```

## 成果物配信

CD だけを GitHub Actions で行います（`.github/workflows/release.yml`、Windows ランナー）。PR や branch の push では起動しません。手動実行（`gh workflow run release.yml --ref <branch>`）はインストーラを Artifacts に残すだけです。

```bash
# 4 か所の version（tauri.conf.json / Cargo.toml / package.json / pyproject.toml）を揃えて main へマージした後
git tag v4.0.0
git push origin v4.0.0   # Release が作られ MangaOrganizer-v4.0.0-setup.exe が添付される
```

## 主な場所

- `services/core/` — GUI 非依存のコアロジック（`manga_core`）とサイドカー API（`manga_api`）
- `apps/desktop/` — React + TypeScript のフロントエンド（Playwright で検証）
- `apps/desktop/src-tauri/` — Tauri シェル（Rust）
- `docker/` — Orca SSH 用の常駐開発コンテナ
- `scripts/run_merge_gate.sh` — Local Merge Gate
- `scripts/build_sidecar.sh` — サイドカーを PyInstaller で梱包して Tauri の資材へ置く
- `.github/workflows/release.yml` — Windows インストーラのビルドと Release
