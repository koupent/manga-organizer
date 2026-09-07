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

/// フロントエンドが接続情報を取りに来る
#[tauri::command]
fn sidecar_connection(state: tauri::State<'_, SidecarState>) -> Result<ConnectionView, String> {
    state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(|running| ConnectionView::from(&running.connection))
        .ok_or_else(|| "サイドカーが起動していません".to_string())
}

/// 起動時にサイドカーを立ち上げ、接続情報を保持する
fn launch_sidecar(app: &tauri::AppHandle) -> Result<ConnectionView, String> {
    let state_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&state_dir).map_err(|error| error.to_string())?;

    // 読むのを許すのは利用者のホーム以下だけにする。トークンに加えた
    // もう一段の制限で、想定外のパスを読ませない。
    //
    // 書き出す先はここでは決まらない。蔵書は 2 台目のドライブや NAS に
    // 置かれることが多く、ホームへ縛ると整理そのものができなくなるため、
    // 利用者が画面で選んだ出力先をサイドカーが起動のあいだ覚える
    // （POST /api/output-roots）。書けるのはホーム以下と、その覚えだけ
    let home = app.path().home_dir().map_err(|error| error.to_string())?;

    let program = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("sidecar")
        .join(if cfg!(windows) {
            "manga-api.exe"
        } else {
            "manga-api"
        });

    let running =
        Sidecar::start(&program, &[], &state_dir, &[home]).map_err(|error| error.to_string())?;
    let connection = ConnectionView::from(&running.connection);

    let state = app.state::<SidecarState>();
    *state.0.lock().map_err(|error| error.to_string())? = Some(running);
    Ok(connection)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_connection])
        .setup(|app| {
            match launch_sidecar(app.handle()) {
                Ok(connection) => {
                    app.emit("sidecar-ready", connection)?;
                }
                Err(reason) => {
                    // 起動できなくてもウィンドウは出す。理由を画面に示す
                    app.emit("sidecar-failed", reason)?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                // ブラウザでは実パスが取れない。ネイティブ側で受けて渡す
                let payload = DroppedEntries {
                    entries: dropped_entries(paths),
                };
                let _ = window.emit("files-dropped", payload);
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri アプリの起動に失敗しました");
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::Path;

    // ここから下は、整理の入り口へフォルダを落としたときの挙動を固定する。
    // フォルダには拡張子が無く、拡張子だけで見ると捨てられてしまう。

    /// テストのあいだだけ実在させる作業用ディレクトリ。
    ///
    /// フォルダかどうかは実在を見ないと決まらないため、本物を作る必要がある。
    /// `tempfile` は依存に入っていないので、プロセス ID とテスト名で一意な名前を
    /// 作り、`Drop` で後片付けまでやる（テストが落ちても残さない）。
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "manga-organizer-drop-{}-{label}",
                std::process::id()
            ));
            // 前回の残骸があっても、まっさらから始める
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("作業用ディレクトリを作れませんでした");
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
            .split_once(".run(tauri::generate_context!())")
            .expect("run が見つかりません")
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
}
