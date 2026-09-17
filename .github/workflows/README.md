# GitHub Actions Workflows

このリポジトリの Actions はローカル成果物 CD 専用です。PR や branch / tag push では起動しません。

## release.yml

`workflow_dispatch` のみ。必須入力:

- `artifact_ref`
- `artifact_sha256`
- `source_commit`
- `source_tree`

ジョブは公開済みの不変成果物を取得し、digest を照合したうえで製品向け GitHub Release に exe を添付します。ビルドは行いません。

## ローカル手順

1. Linux Dev Container で `bash scripts/run_merge_gate.sh --publish-status`
2. Windows ホストで成果物をビルド・公開（`scripts/build_release_artifact.sh` と `scripts/publish_release_artifact.mjs`）
3. `gh workflow run release.yml` で `release.yml` を一度だけ起動（入力は 2 で得た `artifactRef` と測定値）

詳細はリポジトリ直下の `DEVELOPMENT.md` を参照してください。
