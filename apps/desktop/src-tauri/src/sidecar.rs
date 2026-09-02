//! Python サイドカーの起動と後始末。
//!
//! サイドカーは起動して接続を受け付けられるようになってから、待ち受け先と
//! 使い捨てトークンを stdout へ 1 行で出す。ここではそれを読み取り、
//! フロントエンドへ渡せる形にする。
//!
//! アプリを閉じたときにプロセスを残さないよう、Drop で確実に終了させる。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
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
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());

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

/// 起動中のサイドカーを保持する。アプリ全体で 1 つ
#[derive(Default)]
pub struct SidecarState(pub Mutex<Option<Sidecar>>);

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
    fn errors_describe_the_cause_in_japanese() {
        let message = SidecarError::Timeout.to_string();
        assert!(message.contains("応答しませんでした"), "{message}");
    }
}
