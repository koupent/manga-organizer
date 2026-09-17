# Manga Organizer

Windows 向け漫画アーカイブ整理アプリです。Tauri シェル + React フロントエンド + Python サイドカーで構成します。

## 品質ゲート

コード品質は GitHub Actions ではなくローカル必須です。

```bash
bash scripts/run_merge_gate.sh
bash scripts/run_merge_gate.sh --publish-status
```

対象は `services/core/` の `uv lock --check`・`ruff`・`compileall`・`unittest`、`apps/desktop/` の型検査・ビルド・Playwright、Tauri シェルの `cargo fmt`・`clippy`・`test` です。

`--publish-status` は GitHub の `Local Merge Gate` commit status を HEAD へ publish します。

## 成果物配信

Windows ホストで exe をビルドし、公開済み成果物の照合だけを Actions が行います。

```bash
# Windows ホスト（Git Bash）: 成果物をビルド
bash scripts/build_release_artifact.sh

# 不変 prerelease として公開（artifactRef が stdout に JSON で返る）
ENGINEERING_DELIVERY_ARTIFACT_PATH=.artifacts/MangaOrganizer.exe \
ENGINEERING_DELIVERY_ARTIFACT_SHA256=<sha256> \
ENGINEERING_DELIVERY_ARTIFACT_SIZE=<bytes> \
ENGINEERING_DELIVERY_SOURCE_COMMIT=<40桁 commit> \
ENGINEERING_DELIVERY_SOURCE_TREE=<40桁 tree> \
  node scripts/publish_release_artifact.mjs

# CD を 1 回だけ起動
gh workflow run release.yml \
  -f artifact_ref=<上の artifactRef> \
  -f artifact_sha256=<sha256> \
  -f source_commit=<commit> \
  -f source_tree=<tree>
```

`scripts/build_release_artifact.sh` は非 Windows では失敗します。現時点では Tauri シェルと Python サイドカーを 1 つのインストーラへまとめる処理が未実装のため、Windows でも失敗します。

## 主な場所

- `services/core/` — GUI 非依存のコアロジック（`manga_core`）とサイドカー API（`manga_api`）
- `apps/desktop/` — React + TypeScript のフロントエンド（Playwright で検証）
- `apps/desktop/src-tauri/` — Tauri シェル（Rust）
- `scripts/run_merge_gate.sh` — Local Merge Gate
- `scripts/publish_release_artifact.mjs` — 不変 prerelease の公開
