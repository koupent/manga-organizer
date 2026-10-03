# Manga Organizer - 開発者ドキュメント

このドキュメントは、Manga Organizer の開発者向け情報です。

## 目次

- [開発環境のセットアップ](#開発環境のセットアップ)
- [Local Merge Gate](#local-merge-gate)
- [動作確認](#動作確認)
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
- Windows ホスト（デスクトップアプリとして動かすとき。Git Bash・Node 20・Rust・uv）
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

## 動作確認

### 開発コンテナで画面を見る（ブラウザ）

サイドカーを固定ポートとトークンで起動し、Vite の dev server が `/api` を中継します。

```bash
# 端末 1
cd services/core
uv run python -m manga_api --port 8765 --token dev

# 端末 2
cd apps/desktop
npm run dev
```

ブラウザで `http://127.0.0.1:5173/?token=dev` を開きます。コンテナの 5173 番は Orca のポート転送か、ホストから `ssh -L 5173:127.0.0.1:5173 -p 2223 -i ~/.ssh/id_manga_organaizer_orca node@127.0.0.1` で手元へ出します。辿れるのはコンテナの中のファイルです。

ネイティブのドロップ（エクスプローラーからの実パス）だけはブラウザでは確かめられません。

### Windows でデスクトップアプリとして動かす

Windows ホストの Git Bash で、サイドカーを一度作ってから Tauri を開発モードで起動します。

```bash
bash scripts/build_sidecar.sh   # サイドカーを apps/desktop/src-tauri/resources/sidecar へ
cd apps/desktop
npm ci
npx tauri dev
```

インストーラまで作るときは `npx tauri build`（`apps/desktop/src-tauri/target/release/bundle/nsis/` に出ます）。サイドカーを変えたら `build_sidecar.sh` をやり直してください（`tauri build` は自分で作り直します）。

### 配る物そのものを試す

`.github/workflows/release.yml` が走った PR では、Actions の実行結果の Artifacts にインストーラ（`MangaOrganizer-vX.X.X-setup.exe`）が残ります。タグを打つ前に実機へ入れて確かめられます。

## ビルドとリリース

インストーラは GitHub Actions の Windows ランナーで作ります（`.github/workflows/release.yml`）。作ったインストーラを黙って入れ、同梱のサイドカーが応答するところまで確かめます。

- PR: 配布物の作り方に関わるファイル（`src-tauri/`・依存の宣言・`manga_api.spec`・`build_sidecar.sh` など）を変えたときだけ走り、インストーラを Artifacts に残す
- `v*` タグの push: 同じことをしたうえで、タグ名の GitHub Release を作ってインストーラを添付する
- 手動（`workflow_dispatch`）: 任意のブランチで試す

リポジトリが private なので、Release をダウンロードできるのはコラボレーターとして招待した人だけです。

## バージョンアップ手順

1. 次の 4 箇所の version を同じ値に更新し、lock を作り直す（`release.yml` が一致を検証し、食い違うと止まります）

   - `apps/desktop/src-tauri/tauri.conf.json` — インストーラに刻まれる正本
   - `apps/desktop/src-tauri/Cargo.toml`（`Cargo.lock` は `cargo update -p manga-organizer-desktop`）
   - `apps/desktop/package.json`（`package-lock.json` の自分の version も）
   - `services/core/pyproject.toml`（`uv.lock` は `uv lock`）

2. PR 経由で main へ squash merge（Local Merge Gate 必須）
3. main の先頭にタグを打って push する

   ```bash
   git switch main && git pull
   git tag v4.0.0
   git push origin v4.0.0
   ```

4. Actions の「Windows インストーラ」が緑になると、Releases に `MangaOrganizer-v4.0.0-setup.exe` が載る

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
│   └── build_sidecar.sh
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
