# GitHub Actions Workflows

CI（lint・テスト）は Actions ではなく開発コンテナ内の Local Merge Gate（`scripts/run_merge_gate.sh`）で行います。Actions は CD（Windows インストーラを作って配る）だけに使い、PR や branch の push では起動しません。

## release.yml

Windows ランナーでインストーラ（NSIS）を作り、黙ってインストールして同梱のサイドカーが応答するところまで確かめます。

| 起動 | すること |
|---|---|
| `v*` タグの push | 作って確かめ、タグと同じ名前の GitHub Release を作ってインストーラを添付する |
| `workflow_dispatch`（手動） | 作って確かめ、インストーラを Artifacts に残すだけ（タグを打つ前に試すとき） |

タグは `tauri.conf.json`・`Cargo.toml`・`package.json`・`pyproject.toml` の版と一致している必要があります（`v4.0.0` なら全部 `4.0.0`）。

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
