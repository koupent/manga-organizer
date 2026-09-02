# Manga Organizer — 開発ハーネス

Windows向け漫画アーカイブ整理アプリです。アプリ本体は `manga-organizer/` にあります。

## 開発基盤

- Engineering Dev Foundation v0.8.0（`.dev-foundation/`）
- Engineering Workflow Plugin v0.15.0 + 公式 ECC v2.2.0（`.engineering-workflow/`）

固定 SHA は `.engineering-workflow/workflow-plugin.lock.json` と `.dev-foundation/foundation.lock.json` を正本とします。

Dev Container 再作成後、コンテナ内で Plugin を導入します。これを忘れると marketplace が `cache-miss` になり、Claude Code ハーネス（Agent ルーティング）が動きません。

```bash
bash scripts/install_workflow.sh
```

導入後は Claude Code を再起動してください。SessionStart で provenance 検証が通れば、`workflow-coordinator` 経由の Agent / Task が使えます。

## 品質ゲート

コード品質は GitHub Actions ではなくローカル必須です。

```bash
bash scripts/run_merge_gate.sh
bash scripts/run_merge_gate.sh --publish-status
```

対象は `services/core/` と `manga-organizer/` の `uv lock --check`、`ruff`、`compileall`、`unittest` です。

## 成果物配信

Windows ホストで exe をビルドし、公開済み成果物の照合だけを Actions が行います。

```bash
# Windows ホスト（Git Bash）
node <plugin-root>/scripts/local-delivery.mjs prepare --project-dir .
node <plugin-root>/scripts/local-delivery.mjs dispatch --project-dir .
```

または Plugin 導入後の同等コマンド。`scripts/build_release_artifact.sh` は非 Windows では失敗します。

## 主な場所

- `services/core/` — GUI 非依存のコアロジック（`manga_core` パッケージ）
- `manga-organizer/src/gui/` — 現行 Tkinter アプリ
- `manga-organizer/pyproject.toml` — uv / ruff（コアをパス依存で参照）
- `scripts/run_merge_gate.sh` — Local Merge Gate
- `.engineering-workflow/config.json` — localCi / delivery 契約
