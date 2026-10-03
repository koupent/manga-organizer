# GitHub Actions Workflows

| ワークフロー | いつ | すること |
|---|---|---|
| `ci.yml`（CI） | 毎回の PR | `Merge Gate` ジョブで `scripts/run_merge_gate.sh` を回す。main への合流の必須チェック |
| `release.yml`（Windows インストーラ） | 配布物の作り方に関わる変更の PR | インストーラを作り、黙って入れて同梱のサイドカーが応答するか、アプリを閉じるとサイドカーも止まるかまで確かめ、Artifacts に残す |
| | `workflow_dispatch`（手動） | 同上（Release は作らない） |
| | `v*` タグの push | 同上に加えて、タグと同じ名前の GitHub Release を作りインストーラを添付する |

タグは `tauri.conf.json`・`Cargo.toml`・`package.json`・`pyproject.toml` の版と一致している必要があります（`v4.0.0` なら全部 `4.0.0`）。

Windows ランナーは分数が 2 倍に数えられるため、`release.yml` は PR では paths で絞っています。`ci.yml` は必須チェックが「待ち」のまま残らないよう絞りません。

## リリース手順

1. 4 か所の版を上げた PR を main へマージする
2. main の先頭にタグを打って push する

   ```bash
   git switch main && git pull
   git tag v4.0.0
   git push origin v4.0.0
   ```

3. Actions の「Windows インストーラ」が緑になると、Releases に `MangaOrganizer-v4.0.0-setup.exe` が載る

詳細はリポジトリ直下の `DEVELOPMENT.md` を参照してください。
