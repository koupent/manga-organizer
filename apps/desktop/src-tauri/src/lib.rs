//! Tauri シェル。
//!
//! ウィンドウを出し、Python サイドカーを起動し、フロントエンドへ接続情報を
//! 渡す。ブラウザではドロップされたファイルの実パスを取得できないため、
//! ここで受けてフロントエンドへ渡す。

mod sidecar;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{Emitter, Manager};

use sidecar::{ConnectionView, Sidecar, SidecarState};

/// フロントエンドへ渡すドロップ結果
#[derive(Clone, Debug, Serialize)]
pub struct DroppedPaths {
    pub paths: Vec<String>,
}

/// ページ順を編集できる形式。viewer が読む ZIP に限る
const EDITABLE_SUFFIXES: [&str; 2] = ["zip", "cbz"];

/// 整理の入力として受け付ける形式
const ARCHIVE_SUFFIXES: [&str; 7] = ["zip", "cbz", "rar", "cbr", "7z", "cb7", "epub"];

/// ドロップされたパスから、扱えるアーカイブだけを取り出す
pub fn keep_archives(paths: &[PathBuf], editable_only: bool) -> Vec<String> {
    let allowed: &[&str] = if editable_only {
        &EDITABLE_SUFFIXES
    } else {
        &ARCHIVE_SUFFIXES
    };
    let mut kept: Vec<String> = paths
        .iter()
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|suffix| allowed.contains(&suffix.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    kept.sort();
    kept.dedup();
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

    // 読み書きを許すのは利用者のホーム以下だけにする。トークンに加えた
    // もう一段の制限で、想定外のパスを読ませない
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
                let payload = DroppedPaths {
                    paths: keep_archives(paths, false),
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

    #[test]
    fn keeps_only_archives() {
        let paths = vec![
            PathBuf::from("/library/a.zip"),
            PathBuf::from("/library/b.CBZ"),
            PathBuf::from("/library/c.txt"),
            PathBuf::from("/library/d"),
        ];
        assert_eq!(
            vec!["/library/a.zip".to_string(), "/library/b.CBZ".to_string()],
            keep_archives(&paths, true)
        );
    }

    #[test]
    fn accepts_more_formats_when_organising() {
        let paths = vec![
            PathBuf::from("/library/a.rar"),
            PathBuf::from("/library/b.7z"),
            PathBuf::from("/library/c.zip"),
        ];
        assert_eq!(3, keep_archives(&paths, false).len());
        assert_eq!(1, keep_archives(&paths, true).len());
    }

    #[test]
    fn removes_duplicates_and_sorts() {
        let paths = vec![
            PathBuf::from("/library/b.zip"),
            PathBuf::from("/library/a.zip"),
            PathBuf::from("/library/a.zip"),
        ];
        assert_eq!(
            vec!["/library/a.zip".to_string(), "/library/b.zip".to_string()],
            keep_archives(&paths, true)
        );
    }
}
