//! Tauri シェル。
//!
//! ウィンドウを出し、Python サイドカーを起動し、フロントエンドへ接続情報を
//! 渡す。ブラウザではドロップされたファイルの実パスを取得できないため、
//! ここで受けてフロントエンドへ渡す。

mod sidecar;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Emitter, Manager};

use sidecar::{ConnectionView, Sidecar, SidecarState};

/// フロントエンドへ渡すドロップ 1 件
#[derive(Clone, Debug, Serialize)]
pub struct DroppedEntry {
    pub path: String,
    pub is_dir: bool,
}

/// フロントエンドへ渡すドロップ結果
#[derive(Clone, Debug, Serialize)]
pub struct DroppedEntries {
    pub entries: Vec<DroppedEntry>,
}

/// 整理の入力として受け付ける形式
const ARCHIVE_SUFFIXES: [&str; 7] = ["zip", "cbz", "rar", "cbr", "7z", "cb7", "epub"];

/// 整理の入力として扱える拡張子を持つか
fn has_archive_suffix(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|suffix| ARCHIVE_SUFFIXES.contains(&suffix.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// ドロップされたパスから、整理へ渡せるものだけを取り出す。
///
/// フォルダには拡張子が無いので、拡張子だけで絞るとフォルダが 1 件も残らない。
/// そこで実在するディレクトリは拡張子を見ずに残し、それ以外だけ拡張子で決める。
/// 「蔵書.zip」という名前のフォルダを取り違えないよう、判断は名前ではなく実在を
/// 見る。実在しないパスはディレクトリではないものとして扱う。
pub fn dropped_entries(paths: &[PathBuf]) -> Vec<DroppedEntry> {
    let mut kept: Vec<DroppedEntry> = paths
        .iter()
        .filter_map(|path| {
            // 実在を見るには読みに行くしかなく、読みに行けば失敗しうる。
            // 権限が無い、リンクの先が消えている、共有が応答しない——
            // どれもディレクトリではないものとして扱う。理由を区別しても、
            // 落とした人へ伝える手立てが今は無いためで、区別できるように
            // なったらここが分かれ目になる
            let is_dir = match path.metadata() {
                Ok(metadata) => metadata.is_dir(),
                Err(_unreadable) => false,
            };
            if !is_dir && !has_archive_suffix(path) {
                return None;
            }
            Some(DroppedEntry {
                path: path.to_string_lossy().into_owned(),
                is_dir,
            })
        })
        .collect();
    kept.sort_by(|left, right| left.path.cmp(&right.path));
    kept.dedup_by(|left, right| left.path == right.path);
    kept
}

/// フロントエンドが接続情報を取りに来る。
///
/// サイドカーは窓を出した後に背景で起動するので、成否が決まるまで待つ。
/// 失敗したときはその理由を返し、画面がそのまま出す
#[tauri::command]
async fn sidecar_connection(app: tauri::AppHandle) -> Result<ConnectionView, String> {
    // 待つのは非同期の実行器ではなく、待つための別スレッドで行う
    tauri::async_runtime::spawn_blocking(move || app.state::<SidecarState>().wait_connection())
        .await
        .map_err(|error| error.to_string())?
}

/// サイドカーを止める。更新のインストーラを走らせる直前に画面が呼ぶ。
///
/// Windows の更新はインストーラを起こして `process::exit` で抜けるので、
/// `RunEvent::Exit` の後始末を通らない。サイドカーが残ったままだと、
/// インストーラが `manga-api.exe` と同梱物を上書きできない
#[tauri::command]
fn stop_sidecar(state: tauri::State<'_, SidecarState>) {
    state.stop();
}

/// サイドカーを立ち上げる
fn launch_sidecar(app: &tauri::AppHandle) -> Result<Sidecar, String> {
    let state_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&state_dir).map_err(|error| error.to_string())?;

    // 読み書きできる場所は絞らない（--allow-root を渡さない）。蔵書は
    // 2 台目のドライブや NAS に置かれることが多く、ホームへ縛ると整理
    // そのものができなくなるため。サイドカーは 127.0.0.1 だけで待ち受け、
    // 起動ごとの使い捨てトークンが無ければ応じない
    //
    // 同梱物は tauri.conf.json の resources の相対パスのまま置かれる
    // （インストール先でも tauri dev の target/debug でも同じ形）
    let program = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("resources")
        .join("sidecar")
        .join(if cfg!(windows) {
            "manga-api.exe"
        } else {
            "manga-api"
        });

    let args = ["--exit-with-parent".to_string()];
    Sidecar::start(&program, &args, &state_dir, &[]).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_connection, stop_sidecar])
        .setup(|app| {
            // 起動を待つ間も窓を動かしておく。起動できなくても窓は出し、
            // 理由は接続情報を取りに来た画面へ返す
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let outcome = launch_sidecar(&handle);
                handle.state::<SidecarState>().settle(outcome);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let tauri::WindowEvent::DragDrop(drag) = event else {
                return;
            };
            // ドロップを受ける設定では WebView2 に HTML のドラッグイベントが
            // 届かない。来た・離れたも転送しないと、画面は離す前に「落とせる」
            // と示せない（#106）
            match drag {
                tauri::DragDropEvent::Enter { .. } => {
                    let _ = window.emit("files-dragging", true);
                }
                tauri::DragDropEvent::Leave => {
                    let _ = window.emit("files-dragging", false);
                }
                tauri::DragDropEvent::Drop { paths, .. } => {
                    let _ = window.emit("files-dragging", false);
                    // ブラウザでは実パスが取れない。ネイティブ側で受けて渡す
                    let payload = DroppedEntries {
                        entries: dropped_entries(paths),
                    };
                    let _ = window.emit("files-dropped", payload);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri アプリの起動に失敗しました")
        .run(|app, event| {
            // 終わるときは process::exit で抜けるので、持っているサイドカーの
            // Drop が走らない。閉じた後に残さないよう、ここで止める
            if let tauri::RunEvent::Exit = event {
                app.state::<SidecarState>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::Path;
    use std::time::SystemTime;

    // ここから下は、整理の入り口へフォルダを落としたときの挙動を固定する。
    // フォルダには拡張子が無く、拡張子だけで見ると捨てられてしまう。

    /// テストのあいだだけ実在させる作業用ディレクトリ。
    ///
    /// フォルダかどうかは実在を見ないと決まらないため、本物を作る必要がある。
    /// `tempfile` は依存に入っていないので、プロセス ID・時刻・テスト名で一意な
    /// 名前を作り、`Drop` で後片付けまでやる（テストが落ちても残さない）。
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            // 一時領域は他人と共有する。名前が読めてしまうと、先回りして
            // 作られた場所の中へ書きに行くことになり、中身がリンクなら
            // その先を空にしかねない。時刻を混ぜて名前を当てさせない
            let unique = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("時刻を読めませんでした")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "manga-organizer-drop-{}-{unique}-{label}",
                std::process::id()
            ));
            // create_dir_all と違い、既にあれば作れずに落ちる。他人の場所を
            // 黙って使い回すより、そこで止まる方が正しい
            fs::create_dir(&root).expect("作業用ディレクトリを作れませんでした");
            Self { root }
        }

        /// 実在するディレクトリを作って、その絶対パスを返す
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(&path).expect("ディレクトリを作れませんでした");
            path
        }

        /// 実在するファイルを作って、その絶対パスを返す
        fn file(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, b"").expect("ファイルを作れませんでした");
            path
        }

        /// 作らないパス。実在しない入力を試すために使う
        fn missing(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// 期待値の組み立て。path と is_dir を必ず対にして比べる
    fn expected(path: &Path, is_dir: bool) -> (String, bool) {
        (path.to_string_lossy().into_owned(), is_dir)
    }

    /// 実際の結果を、path と is_dir の対に開く。
    /// 件数だけの assert では is_dir の取り違えを見逃すため、必ずこれを通す
    fn actual(entries: &[DroppedEntry]) -> Vec<(String, bool)> {
        entries
            .iter()
            .map(|entry| (entry.path.clone(), entry.is_dir))
            .collect()
    }

    #[test]
    fn keeps_a_dropped_folder() {
        let tree = TempTree::new("keeps-a-dropped-folder");
        let folder = tree.dir("作品フォルダ");

        assert_eq!(
            vec![expected(&folder, true)],
            actual(&dropped_entries(std::slice::from_ref(&folder)))
        );
    }

    #[test]
    fn keeps_folders_and_archives_and_drops_the_rest() {
        let tree = TempTree::new("keeps-folders-and-archives");
        let folder = tree.dir("a_フォルダ");
        let archive = tree.file("b_蔵書.zip");
        let note = tree.file("c_メモ.txt");

        assert_eq!(
            vec![expected(&folder, true), expected(&archive, false)],
            actual(&dropped_entries(&[
                folder.clone(),
                archive.clone(),
                note.clone(),
            ]))
        );
    }

    #[test]
    fn a_folder_named_like_an_archive_is_still_a_folder() {
        // 拡張子だけで見ると「残る」ことは残るが is_dir を取り違える。
        // 実在を見ているかどうかは、この 1 件で分かれる
        let tree = TempTree::new("folder-named-like-an-archive");
        let folder = tree.dir("蔵書.zip");

        assert_eq!(
            vec![expected(&folder, true)],
            actual(&dropped_entries(std::slice::from_ref(&folder)))
        );
    }

    #[test]
    fn an_archive_file_is_not_a_folder() {
        let tree = TempTree::new("archive-file-is-not-a-folder");
        let archive = tree.file("蔵書.zip");

        assert_eq!(
            vec![expected(&archive, false)],
            actual(&dropped_entries(std::slice::from_ref(&archive)))
        );
    }

    #[test]
    fn a_missing_path_is_judged_by_its_suffix() {
        let tree = TempTree::new("missing-path");
        let ghost_archive = tree.missing("消えた蔵書.zip");
        let ghost_folder = tree.missing("消えたフォルダ");

        assert_eq!(
            vec![expected(&ghost_archive, false)],
            actual(&dropped_entries(&[
                ghost_archive.clone(),
                ghost_folder.clone(),
            ]))
        );
    }

    #[test]
    fn sorts_and_removes_duplicates_across_folders_and_archives() {
        let tree = TempTree::new("sorts-and-removes-duplicates");
        let folder = tree.dir("a_フォルダ");
        let archive = tree.file("b_蔵書.zip");

        assert_eq!(
            vec![expected(&folder, true), expected(&archive, false)],
            actual(&dropped_entries(&[
                archive.clone(),
                folder.clone(),
                archive.clone(),
                folder.clone(),
            ]))
        );
    }

    /// 何も落とされなかったとき、何も返さない
    #[test]
    fn an_empty_drop_keeps_nothing() {
        let empty: Vec<(String, bool)> = Vec::new();

        assert_eq!(empty, actual(&dropped_entries(&[])));
    }

    /// 対応形式と大小文字を、まとめて押さえる。
    ///
    /// 他のテストは小文字の .zip しか使わないので、ARCHIVE_SUFFIXES から
    /// 1 つ落ちても、大小を畳む処理が消えても、どれも通ってしまう。
    /// 7 形式すべてと大文字混じりを実在させて、まとめてここで見る
    #[test]
    fn keeps_every_supported_suffix_whatever_the_case() {
        let tree = TempTree::new("every-supported-suffix");
        // 並び順は path 順に決まる。先頭の番号で期待する順序を固定する
        let archives: Vec<PathBuf> = [
            "01_蔵書.zip",
            "02_蔵書.CBZ",
            "03_蔵書.rar",
            "04_蔵書.Cbr",
            "05_蔵書.7Z",
            "06_蔵書.cb7",
            "07_蔵書.ePub",
        ]
        .iter()
        .map(|name| tree.file(name))
        .collect();
        // 対象外のものは、大小どちらで書かれていても残らない
        let notes = [tree.file("08_メモ.txt"), tree.file("09_メモ.TXT")];

        let dropped: Vec<PathBuf> = archives.iter().chain(notes.iter()).cloned().collect();

        assert_eq!(
            archives
                .iter()
                .map(|archive| expected(archive, false))
                .collect::<Vec<_>>(),
            actual(&dropped_entries(&dropped))
        );
    }

    /// 境界の綴りを固定する。
    ///
    /// フロントエンドは `{ path: string; is_dir: boolean }` を手で書いており、
    /// こちらのフィールド名を変えても、どちらのコンパイラも何も言わない。
    /// 直列化した結果をここに写して、綴りを黙って動かせなくする
    #[test]
    fn the_payload_keeps_the_names_the_front_end_reads() {
        let payload = DroppedEntries {
            entries: vec![
                DroppedEntry {
                    path: "D:\\蔵書\\作品フォルダ".to_string(),
                    is_dir: true,
                },
                DroppedEntry {
                    path: "D:\\蔵書\\作品 第1巻.zip".to_string(),
                    is_dir: false,
                },
            ],
        };

        assert_eq!(
            serde_json::json!({
                "entries": [
                    { "path": "D:\\蔵書\\作品フォルダ", "is_dir": true },
                    { "path": "D:\\蔵書\\作品 第1巻.zip", "is_dir": false },
                ]
            }),
            serde_json::to_value(&payload).expect("直列化できませんでした")
        );
    }

    /// 配線を 1 本にする。
    ///
    /// 上のテストは `dropped_entries` だけを見るので、`on_window_event` が
    /// 古い `keep_archives(paths, false)` を呼んだままでも通ってしまう。
    /// ドロップの受け口が新しい入り口だけを通ることを、ここで押さえる。
    #[test]
    fn the_window_drop_handler_uses_the_single_entry_point() {
        const SOURCE: &str = include_str!("lib.rs");

        let handler = SOURCE
            .split_once(".on_window_event(")
            .expect("on_window_event が見つかりません")
            .1
            .split_once(".build(tauri::generate_context!())")
            .expect("build が見つかりません")
            .0;

        assert!(
            handler.contains("dropped_entries("),
            "ドロップの受け口が dropped_entries を通っていません: {handler}"
        );
        assert!(
            !handler.contains("keep_archives("),
            "ドロップの受け口が古い keep_archives を呼んだままです: {handler}"
        );
    }

    /// ドラッグが窓の上に来た・離れたも前面へ転送する（#106）。
    ///
    /// 窓のイベントは単体では起こせないので、上と同じく受け口の書き方で
    /// 押さえる。転送が無いと、画面は離す前に「落とせる」と示せない。
    #[test]
    fn the_window_drop_handler_forwards_drag_enter_and_leave() {
        const SOURCE: &str = include_str!("lib.rs");

        let handler = SOURCE
            .split_once(".on_window_event(")
            .expect("on_window_event が見つかりません")
            .1
            .split_once(".build(tauri::generate_context!())")
            .expect("build が見つかりません")
            .0;

        for variant in ["DragDropEvent::Enter", "DragDropEvent::Leave"] {
            assert!(
                handler.contains(variant),
                "{variant} を受けていません: {handler}"
            );
        }
        assert!(
            handler.contains("\"files-dragging\""),
            "ドラッグの状態を前面へ送っていません: {handler}"
        );
    }
}
