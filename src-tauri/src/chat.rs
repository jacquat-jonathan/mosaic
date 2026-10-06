//! The chat panel's runner: starts Claude Code headless in the vault folder (`claude -p`, stream-json
//! output) with only Mosaic's MCP server, and streams what happens to the UI as `chat-event`s. What
//! the output means, and which tools the chat may use, is in `mosaic_core::chat`.

use crate::{AppState, bundled_cli};
use mosaic_core::Error;
use mosaic_core::chat::{ALLOWED_TOOLS, ChatEvent, DISALLOWED_TOOLS, parse_line, system_prompt};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, Error>;

#[derive(Default)]
pub struct ChatState {
    next: AtomicU64,
    /// Running answers: run id → process group id.
    runs: Mutex<HashMap<u64, u32>>,
}

#[derive(Serialize, Clone)]
struct ChatPayload {
    run: u64,
    event: ChatEvent,
}

#[derive(Serialize)]
pub struct ClaudeInfo {
    /// Where `claude` was found, if it was.
    path: Option<String>,
    version: Option<String>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// The PATH Claude Code and its tools should see: the app starts with a minimal one.
pub(crate) fn path_env() -> String {
    let h = home();
    format!(
        "{}/.local/bin:{}/.claude/local:/opt/homebrew/bin:/usr/local/bin:{}",
        h.display(),
        h.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

/// Finds the `claude` command: the usual install places, then the login shell's PATH.
pub(crate) fn find_claude() -> Option<PathBuf> {
    let h = home();
    for p in [
        h.join(".local/bin/claude"),
        h.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ] {
        if p.is_file() {
            return Some(p);
        }
    }
    let out = Command::new("/bin/zsh")
        .args(["-lc", "command -v claude"])
        .output()
        .ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty() && out.status.success()).then(|| PathBuf::from(p))
}

/// The `mosaic` command for Claude Code's MCP config: the one bundled with the app, else the
/// installed one.
pub(crate) fn mosaic_cli() -> Option<PathBuf> {
    bundled_cli().or_else(|| {
        let p = home().join(".local/bin/mosaic");
        p.is_file().then_some(p)
    })
}

#[tauri::command]
pub fn chat_check() -> ClaudeInfo {
    let path = find_claude();
    let version = path.as_ref().and_then(|p| {
        let out = Command::new(p)
            .arg("--version")
            .env("PATH", path_env())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    });
    ClaudeInfo {
        path: path.map(|p| p.display().to_string()),
        version,
    }
}

/// Sends a message: starts Claude Code (resuming `session` if given) and returns the run's id;
/// its events arrive as `chat-event`. With `agent`, the message runs that agent from `Agents/`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn chat_send(
    app: AppHandle,
    state: State<AppState>,
    chats: State<ChatState>,
    message: String,
    session: Option<String>,
    context: Vec<String>,
    active: Option<String>,
    agent: Option<String>,
    selection_path: Option<String>,
    selection_text: Option<String>,
    model: Option<String>,
) -> CmdResult<u64> {
    let ws = state.get()?;
    let claude = find_claude().ok_or_else(|| {
        Error::Invalid("Claude Code isn't installed: install it from claude.com/claude-code, run `claude` once in a terminal to log in, then try again.".into())
    })?;
    let mosaic = mosaic_cli().ok_or_else(|| {
        Error::Invalid("The mosaic command wasn't found: install it in Settings › AI first.".into())
    })?;
    // Agents as skills for this session, fresh.
    let _ = ws.mirror_agents();
    let prompt = match agent.as_deref().filter(|a| !a.is_empty()) {
        Some(name) => mosaic_core::agents::agent_prompt(&ws.agent(name)?, Some(&message)),
        None => message,
    };
    let root = ws.vault.root().to_path_buf();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mcp = serde_json::json!({
        "mcpServers": { "mosaic": {
            "command": mosaic.display().to_string(),
            "args": ["--vault", root.display().to_string(), "mcp"],
        }}
    });
    let mut cmd = Command::new(claude);
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
    ])
    .arg("--mcp-config")
    .arg(mcp.to_string())
    .arg("--append-system-prompt")
    .arg(system_prompt(
        &name,
        active.as_deref(),
        &context,
        selection_path.as_deref().zip(selection_text.as_deref()),
    ))
    .arg("--allowedTools")
    .args(ALLOWED_TOOLS.split(' '))
    .arg("--disallowedTools")
    .args(DISALLOWED_TOOLS.split(' '));
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
        cmd.arg("--model").arg(model);
    }
    if let Some(s) = session.filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(s);
    }
    let mut child = cmd
        .current_dir(&root)
        .env("PATH", path_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| Error::Invalid(format!("couldn't start Claude Code: {e}")))?;
    // The message goes in on stdin, so one starting with "-" isn't taken for an option.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let run = chats.next.fetch_add(1, Ordering::SeqCst) + 1;
    chats
        .runs
        .lock()
        .expect("chat lock")
        .insert(run, child.id());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    std::thread::spawn(move || {
        let emit = |event: ChatEvent| {
            let _ = app.emit("chat-event", ChatPayload { run, event });
        };
        let err_tail = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut e) = stderr {
                let _ = e.read_to_string(&mut s);
            }
            s
        });
        let mut done = false;
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                for event in parse_line(&line) {
                    done |= matches!(event, ChatEvent::Done { .. });
                    emit(event);
                }
            }
        }
        let status = child.wait();
        let stderr = err_tail.join().unwrap_or_default();
        let stopped = {
            let chats = tauri::Manager::state::<ChatState>(&app);
            let mut runs = chats.runs.lock().expect("chat lock");
            runs.remove(&run).is_none()
        };
        if !done {
            let error = if stopped {
                "Stopped.".to_string()
            } else {
                let tail: String = stderr
                    .trim()
                    .lines()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                match status {
                    Ok(s) if s.success() => "Claude Code ended without an answer.".into(),
                    _ if tail.is_empty() => "Claude Code stopped with an error.".into(),
                    _ => tail,
                }
            };
            emit(ChatEvent::Done {
                session_id: None,
                cost_usd: None,
                error: Some(error),
            });
        }
    });
    Ok(run)
}

/// Stops an answer: kills Claude Code's whole process group.
#[tauri::command]
pub fn chat_stop(chats: State<ChatState>, run: u64) -> CmdResult<()> {
    if let Some(pgid) = chats.runs.lock().expect("chat lock").remove(&run) {
        let _ = Command::new("kill")
            .args(["-TERM", "--", &format!("-{pgid}")])
            .status();
    }
    Ok(())
}
