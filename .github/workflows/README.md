# GitHub Actions Workflows

| ワークフロー | いつ | すること |
|---|---|---|
| `ci.yml`（CI） | 毎回の PR | `Merge Gate` ジョブで `scripts/run_merge_gate.sh` を回す（main への合流の必須チェック）。`Core (Windows)` でコアのテストを Windows でも回す |
| `release.yml`（Windows インストーラ） | `v*` タグの push | 署名付きのインストーラを作り、黙って入れて同梱のサイドカーが応答するか、保存が通るか（`scripts/smoke_saves.py`）、アプリを閉じるとサイドカーも止まるかまで確かめる。通ったらこのリポジトリに Release を作り、インストーラと `latest.json`（自動更新の案内）を載せる |
| | `workflow_dispatch`（手動） | タグを打つ前に同じ確かめを行い、Artifacts に残す（Release は作らない） |

タグは `tauri.conf.json`・`Cargo.toml`・`package.json`・`pyproject.toml` の版と一致している必要があります（`v4.0.0` なら全部 `4.0.0`）。

Windows ランナーは分数が 2 倍に数えられるため、インストーラはタグと手動実行だけで作る。`ci.yml` は必須チェックが「待ち」のまま残らないよう絞りません。

## リリース手順

1. 4 か所の版を上げた PR を main へマージする
2. main の先頭にタグを打って push する（利用者が手元の Git から。クラウドのセッションからはタグを push できない）

   ```bash
   git fetch origin && git tag v4.0.0 origin/main && git push origin v4.0.0
   ```

3. Actions の「Windows インストーラ」が緑になると、Releases に `MangaOrganizer-v4.0.0-setup.exe` と `latest.json` が載る

詳細はリポジトリ直下の `DEVELOPMENT.md` を参照してください。
