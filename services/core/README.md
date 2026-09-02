# manga-core

漫画アーカイブの整理とページ順修正を担うコアロジック。GUI に依存しない。

現行の Tkinter アプリ（`manga-organizer/`）と、今後の Python サイドカー
（[#19](https://github.com/koupent/manga-organizer/issues/19) のアプリケーション刷新）の
双方から利用する。

## モジュール

| モジュール | 役割 |
|---|---|
| `archive_handler` | zip / rar / 7z の展開と ZIP 生成 |
| `page_reorder` | ZIP 内のページ順をメタ情報を保ったまま並べ替える |
| `viewer_contract` | 出力が suzume-viewer で正しく読める形かの判定を集約 |
| `volume_detector` | ファイル名からの巻数推定と命名規則 |
| `file_organizer` | 展開から梱包までの取りまとめ |
| `manga_database` | タイトル・著者の辞書（SQLite） |
| `api_client` | AniList によるメタデータ補完 |
| `naming` | 自然順ソート |
| `file_times` | タイムスタンプの退避と復元 |

## テスト

```bash
uv run python -m unittest discover -s tests
```

## サイドカー API

Tauri シェル（[#22](https://github.com/koupent/manga-organizer/issues/22)）が子プロセスとして起動する。

```bash
uv run python -m manga_api --state-dir ~/.manga-organizer --allow-root /path/to/library
```

起動して**接続を受け付けられる状態になってから**、待ち受け先を stdout へ 1 行で出す。

```
MANGA_API_READY {"host": "127.0.0.1", "port": 45619, "token": "..."}
```

`127.0.0.1` でのみ待ち受け、全経路で使い捨てトークンを必須にする。`--allow-root`
を与えると、その配下のアーカイブしか読み書きしない。OpenAPI は `/openapi.json`
で取得でき、フロントエンドの型生成に使う。
