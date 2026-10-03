//! Python サイドカーの起動と後始末。
//!
//! サイドカーは起動して接続を受け付けられるようになってから、待ち受け先と
//! 使い捨てトークンを stdout へ 1 行で出す。ここではそれを読み取り、
//! フロントエンドへ渡せる形にする。
//!
//! アプリを閉じたときにプロセスを残さないよう、Drop で確実に終了させる。

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// サイドカーが READY 行に付ける印
const READY_PREFIX: &str = "MANGA_API_READY ";

/// 起動を待つ上限。初回は依存の読み込みで時間がかかることがある
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

/// フロントエンドへ渡す接続情報
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub host: String,
    pub port: u16,
    pub token: String,
}

/// フロントエンドへ渡す形。基底 URL を組み立てておき、
/// ホストとポートの扱いを画面側に持ち込まない
#[derive(Clone, Debug, Serialize)]
pub struct ConnectionView {
    pub base_url: String,
    pub token: String,
}

impl From<&Connection> for ConnectionView {
    fn from(connection: &Connection) -> Self {
        Self {
            base_url: format!("http://{}:{}", connection.host, connection.port),
            token: connection.token.clone(),
        }
    }
}

#[derive(Debug)]
pub enum SidecarError {
    Spawn(String),
    Startup(String),
    Timeout,
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(detail) => write!(f, "サイドカーを起動できませんでした: {detail}"),
            Self::Startup(detail) => write!(f, "サイドカーの起動に失敗しました: {detail}"),
            Self::Timeout => write!(f, "サイドカーが応答しませんでした"),
        }
    }
}

/// 起動中のサイドカー。Drop で必ず終了させる
pub struct Sidecar {
    child: Child,
    pub connection: Connection,
}

impl Sidecar {
    /// サイドカーを起動し、接続を受け付けられるまで待つ
    pub fn start(
        program: &Path,
        args: &[String],
        state_dir: &Path,
        allowed_roots: &[PathBuf],
    ) -> Result<Self, SidecarError> {
        let mut command = Command::new(program);
        command.args(args);
        command.arg("--state-dir").arg(state_dir);
        for root in allowed_roots {
            command.arg("--allow-root").arg(root);
        }
        // stderr は誰かが読まないと、溜まったところで書き込みが止まり、
        // サイドカーごと固まる。ファイルへ流し、不具合の手掛かりにもする
        let log = File::create(state_dir.join("sidecar.log"))
            .map_err(|error| SidecarError::Spawn(error.to_string()))?;
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // コンソール向けの exe を窓のアプリから起こすと、黒い窓が別に開く
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| SidecarError::Spawn(error.to_string()))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SidecarError::Startup("stdout を取得できません".into()))?;

        let connection = read_connection(stdout)?;
        Ok(Self { child, connection })
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // アプリを閉じたあとにサイドカーが残ると、次回の起動で
        // 状態ファイルを掴んだままになる
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// READY 行を読み取り、接続情報に変換する
fn read_connection(stdout: std::process::ChildStdout) -> Result<Connection, SidecarError> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        if Instant::now() > deadline {
            return Err(SidecarError::Timeout);
        }
        let line = line.map_err(|error| SidecarError::Startup(error.to_string()))?;
        if let Some(payload) = line.strip_prefix(READY_PREFIX) {
            return serde_json::from_str(payload)
                .map_err(|error| SidecarError::Startup(error.to_string()));
        }
    }
    Err(SidecarError::Startup(
        "READY 行が出力されませんでした".into(),
    ))
}

/// 起動中のサイドカーを保持する。アプリ全体で 1 つ。
///
/// 起動は窓を出した後に背景で行う。初回はウイルス対策の走査で十数秒
/// かかることがあり、その間に窓を止めると「応答なし」に見えるため。
/// 画面が接続情報を取りに来たら、起動の成否が決まるまで待たせる。
#[derive(Default)]
pub struct SidecarState {
    slot: Mutex<Option<Result<Sidecar, String>>>,
    settled: Condvar,
}

impl SidecarState {
    /// 起動の成否を入れ、待っている側を起こす
    pub fn settle(&self, outcome: Result<Sidecar, String>) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(outcome);
        }
        self.settled.notify_all();
    }

    /// 起動の成否が決まるまで待ち、接続情報か失敗の理由を返す
    pub fn wait_connection(&self) -> Result<ConnectionView, String> {
        let slot = self.slot.lock().map_err(|error| error.to_string())?;
        let slot = self
            .settled
            .wait_while(slot, |slot| slot.is_none())
            .map_err(|error| error.to_string())?;
        match slot.as_ref() {
            Some(Ok(running)) => Ok(ConnectionView::from(&running.connection)),
            Some(Err(reason)) => Err(reason.clone()),
            None => Err("サイドカーが起動していません".into()),
        }
    }

    /// サイドカーを止める（Drop で終了させる）。アプリを閉じるときに呼ぶ
    pub fn stop(&self) {
        if let Ok(mut slot) = self.slot.lock() {
            slot.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_carries_a_ready_to_use_base_url() {
        let connection = Connection {
            host: "127.0.0.1".into(),
            port: 45619,
            token: "t".into(),
        };
        let view = ConnectionView::from(&connection);
        assert_eq!("http://127.0.0.1:45619", view.base_url);
        assert_eq!("t", view.token);
    }

    #[test]
    fn ready_line_is_parsed() {
        let payload = r#"{"host":"127.0.0.1","port":45619,"token":"abc"}"#;
        let connection: Connection = serde_json::from_str(payload).unwrap();
        assert_eq!(45619, connection.port);
        assert_eq!("abc", connection.token);
    }

    #[test]
    fn waiting_returns_the_reason_once_the_launch_fails() {
        let state = std::sync::Arc::new(SidecarState::default());
        let launcher = std::sync::Arc::clone(&state);
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            launcher.settle(Err("起動できませんでした".into()));
        });

        let reason = state.wait_connection().unwrap_err();
        thread.join().unwrap();
        assert_eq!("起動できませんでした", reason);
    }

    #[test]
    fn errors_describe_the_cause_in_japanese() {
        let message = SidecarError::Timeout.to_string();
        assert!(message.contains("応答しませんでした"), "{message}");
    }
}
