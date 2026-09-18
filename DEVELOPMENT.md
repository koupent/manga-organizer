# Manga Organizer - 開発者ドキュメント

このドキュメントは、Manga Organizer の開発者向け情報です。

## 目次

- [開発環境のセットアップ](#開発環境のセットアップ)
- [Local Merge Gate](#local-merge-gate)
- [ビルドとリリース](#ビルドとリリース)
- [バージョンアップ手順](#バージョンアップ手順)
- [プロジェクト構造](#プロジェクト構造)
- [コーディング規約](#コーディング規約)

## 開発基盤

開発は **常駐 Docker コンテナ**（sshd）の中で行い、[Orca ADE](https://www.onorca.dev/) から SSH で接続します。

正本:

- `docker/Dockerfile` — ツールチェーン（Python / uv / Node 20 / Rust / gh / Tauri 依存 / Claude Code / Codex）
- `docker/compose.yaml` — ポート `127.0.0.1:2223`、リポジトリを `/workspace/manga-organizer` に bind、SSH ホスト鍵と各 CLI の認証を named volume で永続化
- `docker/entrypoint.sh` — ホスト鍵の生成、volume の所有調整、公開鍵の配置、sshd の起動
- `scripts/run_merge_gate.sh` — Local Merge Gate

VS Code / Cursor の Dev Container と Engineering Dev Foundation / Workflow Plugin は使いません。

## 開発環境のセットアップ

### 必要環境

- Docker Desktop
- Orca ADE（SSH ターゲットで接続）
- Windows ホスト（exe ビルド時）
- SSH 鍵 `~/.ssh/id_manga_organaizer_orca`（無ければ `ssh-keygen -t ed25519 -f ~/.ssh/id_manga_organaizer_orca`）

### 手順

```bash
git clone https://github.com/koupent/manga-organizer.git
cd manga-organizer
```

1. SSH 公開鍵を用意する

```bash
cp docker/authorized_keys.example docker/authorized_keys
cat ~/.ssh/id_manga_organaizer_orca.pub >> docker/authorized_keys
```

2. 開発コンテナを起動する（Windows ホスト / Git Bash）

```bash
bash scripts/dev-up.sh
```

3. Orca の Settings → SSH に登録する

- Host: `127.0.0.1`
- Port: `2223`
- User: `node`
- IdentityFile: `~/.ssh/id_manga_organaizer_orca`

4. Orca からその SSH 先でリポジトリを開き、初回だけ依存を同期する

```bash
bash scripts/dev-setup.sh
```

5. コンテナの中で、名乗りと各 CLI の認証を通す（初回だけ）

ホストの `~/.gitconfig` も資格情報もコンテナへは渡していないので、ここで一度入れます。

```bash
git config --global user.name "あなたの名前"
git config --global user.email "you@example.com"

gh auth login      # PR・run_merge_gate.sh --publish-status に要る
gh auth setup-git  # git push が gh の資格情報を使うようにする
claude             # Claude Code
codex              # Codex
```

`gh auth login` だけでは `git push` は通りません。credential helper を入れる `gh auth setup-git` まで実行してください。

通した認証は named volume に入るので、**イメージを作り直しても消えません。**Claude Code のセッション履歴（`sessions` / `projects`）も残るため、リビルドを挟んでも作業を続けられます。

| 対象 | 置き場（volume） |
|---|---|
| Claude Code の認証・履歴・セッション | `claude-home` → `/home/node/.claude` |
| Codex | `codex-home` → `/home/node/.codex` |
| gh | `gh-config` → `/home/node/.config/gh` |
| git の名乗り | `git-config` → `/home/node/.config/git` |
| SSH ホスト鍵 | `ssh-host-keys` → `/etc/ssh/host_keys` |
| Playwright のブラウザ | `playwright-cache` → `/home/node/.cache/ms-playwright` |

`docker compose down` では消えません。捨てるときだけ `docker volume rm manga-organizer_claude-home` のように明示します。

接続確認（ホストから）:

```bash
ssh -p 2223 -i ~/.ssh/id_manga_organaizer_orca node@127.0.0.1
```

## Local Merge Gate

品質判定は GitHub Actions ではなく、**開発コンテナ内**で必須です。

```bash
bash scripts/run_merge_gate.sh
bash scripts/run_merge_gate.sh --publish-status
```

実行内容:

- `services/core/` — `uv lock --check`・`ruff`・`compileall`・`unittest`
- OpenAPI スキーマ照合
- `apps/desktop/` — 型検査・ビルド・Playwright
- Tauri シェル — `cargo fmt`・`clippy`・`test`

`--publish-status` は GitHub の `Local Merge Gate` commit status を更新します。

## ビルドとリリース

タグ push では何も起動しません。Actions は `workflow_dispatch` 専用の照合・公開だけを行います。

### Windows ホストでの成果物作成

```bash
# リポジトリルート（Git Bash）
bash scripts/build_release_artifact.sh
# 成果物: .artifacts/MangaOrganizer.exe
```

現時点で `scripts/build_release_artifact.sh` は未実装として失敗します。旧
Tkinter アプリの PyInstaller 経路は #28 で撤去済みで、Tauri シェルと Python
サイドカーを 1 つのインストーラへまとめる処理はまだありません。サイドカー
単体の梱包は `scripts/build_sidecar.sh` にあります。

### 公開と CD 起動

`scripts/publish_release_artifact.mjs` が成果物を不変 prerelease として公開し、`artifactRef` を stdout へ JSON で返します。

```bash
ENGINEERING_DELIVERY_ARTIFACT_PATH=.artifacts/MangaOrganizer.exe \
ENGINEERING_DELIVERY_ARTIFACT_SHA256=<sha256> \
ENGINEERING_DELIVERY_ARTIFACT_SIZE=<bytes> \
ENGINEERING_DELIVERY_SOURCE_COMMIT=<40桁 commit> \
ENGINEERING_DELIVERY_SOURCE_TREE=<40桁 tree> \
  node scripts/publish_release_artifact.mjs
```

続けて `.github/workflows/release.yml` を一度だけ起動します。digest 照合後、製品向け GitHub Release へ exe が添付されます。

```bash
gh workflow run release.yml \
  -f artifact_ref=<上の artifactRef> \
  -f artifact_sha256=<sha256> \
  -f source_commit=<commit> \
  -f source_tree=<tree>
```

非 Windows では `scripts/build_release_artifact.sh` は失敗します。

## バージョンアップ手順

1. 次の 4 箇所の version を同じ値に更新する（`release.yml` が一致を検証し、食い違うと公開が止まります）

   - `apps/desktop/src-tauri/tauri.conf.json` — exe に刻まれる正本
   - `apps/desktop/src-tauri/Cargo.toml`
   - `apps/desktop/package.json`
   - `services/core/pyproject.toml`

2. PR 経由で main へ squash merge（Local Merge Gate 必須）
3. Windows ホストでビルド・公開し、`release.yml` を起動する（[ビルドとリリース](#ビルドとリリース)）

## プロジェクト構造

```
manga-organizer/                 # リポジトリルート
├── apps/desktop/                # Tauri シェル + React フロントエンド
│   ├── src/                     # React + TypeScript
│   ├── e2e/                     # Playwright
│   └── src-tauri/               # Rust
├── services/core/               # コアロジックとサイドカー API
│   ├── src/manga_core/
│   ├── src/manga_api/
│   ├── tests/
│   ├── pyproject.toml
│   ├── uv.lock
│   └── manga_api.spec           # サイドカーの PyInstaller 定義
├── docker/                      # 常駐開発コンテナ（Orca SSH）
│   ├── Dockerfile
│   ├── compose.yaml
│   ├── entrypoint.sh
│   └── authorized_keys.example
├── scripts/
│   ├── dev-up.sh
│   ├── dev-setup.sh
│   ├── run_merge_gate.sh
│   ├── build_sidecar.sh
│   ├── build_release_artifact.sh
│   └── publish_release_artifact.mjs
├── .github/workflows/release.yml
├── CLAUDE.md
└── DEVELOPMENT.md
```

## コーディング規約

- Python は ruff（`services/core/pyproject.toml` の `[tool.ruff]`）に従う
- ブランチ: `feature/issue-<番号>-...` / `fix/issue-<番号>-...`
- コミットメッセージ: `# <Issue番号> <接頭辞>: <概要>`
- main へのマージは squash のみ

## トラブルシューティング

### tkinter が見つからない（Linux）

```bash
sudo apt-get install python3-tk
```

### SSH で Permission denied

- `docker/authorized_keys` に `id_manga_organaizer_orca.pub` があるか確認
- Orca / ssh が `~/.ssh/id_manga_organaizer_orca` を使っているか確認
- コンテナを再起動: `bash scripts/dev-up.sh`

### リビルド後に Orca が繋がらない／ホスト鍵が違うと言われる

ホスト鍵は `ssh-host-keys` volume にあり、通常はリビルドしても変わりません。`docker volume rm` で消した場合だけ作り直されるので、そのときはピン留めを更新します。

現在の鍵を確認する:

```bash
docker exec manga-organizer-dev-1 ssh-keygen -lf /etc/ssh/host_keys/ssh_host_ed25519_key.pub
```

- ホストの `ssh`: `ssh-keygen -R '[127.0.0.1]:2223'` で古い項目を消してから接続し直す
- Orca: `%APPDATA%Orcaprofileslocal-defaultssh-host-keys.json` の port 2223 の項目を消して接続し直す

### cargo / uv が見つからない

開発コンテナ外で動いています。`bash scripts/dev-up.sh` のあと、SSH 先（`/workspace/manga-organizer`）で作業してください。

### git commit で「Author identity unknown」／git push が Username を訊いてくる

コンテナに名乗りと GitHub の認証が入っていません。[開発環境のセットアップ](#開発環境のセットアップ)の手順 5 を通してください。一度通せば volume に残るので、リビルドのあとに通し直す必要はありません。

```bash
git config --global --get user.email
gh auth status
git config --get-regexp '^credential\.' # gh auth setup-git を通していれば出る
```
