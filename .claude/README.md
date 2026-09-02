# Claude Code 設定

このディレクトリには Engineering Workflow Plugin / ECC のプロジェクト設定だけを置きます。

Dev Container 再作成後は、必ず次を実行してください。marketplace の実体は Claude 設定 volume 配下に置き、再ビルド後も切れないようにしています。

```bash
bash scripts/install_workflow.sh
```

プライベートリポジトリを clone できない場合は、あらかじめ固定 SHA の checkout を用意してから:

```bash
ENGINEERING_WORKFLOW_SOURCE_DIR=/path/to/workflow-plugin/<commit> \
ENGINEERING_ECC_SOURCE_DIR=/path/to/ecc/<commit> \
  bash scripts/install_workflow.sh
```

固定 SHA は `.engineering-workflow/workflow-plugin.lock.json` です。導入後は Claude Code を一度再起動し、SessionStart で provenance が通ることを確認してください。
