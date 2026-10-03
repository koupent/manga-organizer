# GitHub Actions Workflows

コードの品質ゲートは Actions ではなく開発コンテナ内の Local Merge Gate（`scripts/run_merge_gate.sh`）です。Actions は Windows インストーラを作って配るためだけに使います。

## release.yml

Windows ランナーでインストーラ（NSIS）を作り、黙ってインストールして同梱のサイドカーが応答するところまで確かめます。

| 起動 | すること |
|---|---|
| PR（配布物の作り方に関わるファイルを変えたときだけ） | 作って確かめ、インストーラを Artifacts に残す |
| `workflow_dispatch` | 同上（任意のブランチで試すとき） |
| `v*` タグの push | 同上に加えて、タグと同じ名前の GitHub Release を作りインストーラを添付する |

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
