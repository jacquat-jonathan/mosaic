//! Registering `mosaic mcp` with Claude Desktop and Claude Code, and checking that it works.
//!
//! Formats, as documented by the clients:
//! - Claude Desktop reads `claude_desktop_config.json` (`{"mcpServers": {name: {command, args}}}`)
//!   from its config folder when it starts. Commands must be absolute paths: it is launched from
//!   the Dock and doesn't have the terminal's PATH.
//! - Claude Code keeps user and local registrations in `~/.claude.json` (or
//!   `$CLAUDE_CONFIG_DIR/.claude.json`): user ones in `mcpServers`, local ones in
//!   `projects[<folder>].mcpServers`. Project ones are in `<folder>/.mcp.json`. When one name is
//!   registered in several scopes, local wins over project, which wins over user (whole entries).

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The name Mosaic registers itself under in both clients.
pub const SERVER_NAME: &str = "mosaic";

/// A stdio server registration: what the client runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ServerEntry {
    pub command: String,
    pub args: Vec<String>,
}

impl ServerEntry {
    /// The recommended registration: the CLI's absolute path, following the app's vault.
    pub fn for_cli(cli: &Path) -> Self {
        Self {
            command: cli.display().to_string(),
            args: vec!["mcp".into()],
        }
    }

    fn from_json(v: &Value) -> Self {
        let args = v["args"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| s.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        Self {
            command: v["command"].as_str().unwrap_or_default().to_string(),
            args,
        }
    }
}

/// Where Claude Desktop reads its configuration on this platform.
pub fn claude_desktop_config_path() -> Option<PathBuf> {
    let dir = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        PathBuf::from(xdg)
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".config")
    };
    Some(dir.join("Claude").join("claude_desktop_config.json"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum DesktopState {
    /// No config file yet (Claude Desktop not installed, or never configured).
    Missing,
    /// The file exists without a `mosaic` server.
    NotConfigured,
    /// `mosaic` runs exactly the expected command.
    Configured,
    /// `mosaic` runs something else (an old path, a pinned vault, a bare `mosaic`).
    Different { entry: ServerEntry },
    /// The file isn't valid JSON (Claude Desktop then ignores every server in it).
    Invalid { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DesktopStatus {
    pub path: String,
    pub state: DesktopState,
}

fn parse_config(text: &str) -> std::result::Result<Map<String, Value>, String> {
    // An empty file is what some editors leave behind; treat it as `{}`.
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => match map.get("mcpServers") {
            None | Some(Value::Object(_)) => Ok(map),
            Some(_) => Err("\"mcpServers\" isn't an object".into()),
        },
        Ok(_) => Err("the file isn't a JSON object".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// How Mosaic is (or isn't) registered in the Claude Desktop config at `path`.
pub fn desktop_status(path: &Path, expected: &ServerEntry) -> DesktopStatus {
    let state = match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DesktopState::Missing,
        Err(e) => DesktopState::Invalid {
            error: e.to_string(),
        },
        Ok(text) => match parse_config(&text) {
            Err(error) => DesktopState::Invalid { error },
            Ok(map) => match map.get("mcpServers").and_then(|s| s.get(SERVER_NAME)) {
                None => DesktopState::NotConfigured,
                Some(v) => {
                    let entry = ServerEntry::from_json(v);
                    // `env` could pin a vault (MOSAIC_VAULT) behind an otherwise correct entry.
                    let env_set = v["env"].as_object().is_some_and(|e| !e.is_empty());
                    if &entry == expected && !env_set {
                        DesktopState::Configured
                    } else {
                        DesktopState::Different { entry }
                    }
                }
            },
        },
    };
    DesktopStatus {
        path: path.display().to_string(),
        state,
    }
}

/// The config text with Mosaic's server set to `entry`. Every other server and setting is kept;
/// an existing `mosaic` entry is replaced. Refuses a file it can't read as a JSON object rather
/// than overwrite the human's other servers.
pub fn merge_desktop_config(existing: Option<&str>, entry: &ServerEntry) -> Result<String> {
    let mut map = match existing {
        None => Map::new(),
        Some(text) => parse_config(text).map_err(|e| {
            Error::Invalid(format!(
                "Claude Desktop's config file isn't valid JSON ({e}); fix or remove it first"
            ))
        })?,
    };
    let servers = map
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    servers
        .as_object_mut()
        .expect("checked by parse_config")
        .insert(
            SERVER_NAME.into(),
            json!({ "command": entry.command, "args": entry.args }),
        );
    Ok(serde_json::to_string_pretty(&Value::Object(map)).expect("JSON values serialize") + "\n")
}

/// Registers Mosaic in Claude Desktop's config at `path`, keeping its other servers. The previous
/// file is kept next to it as `claude_desktop_config.json.bak`.
pub fn write_desktop_config(path: &Path, entry: &ServerEntry) -> Result<DesktopStatus> {
    let io = |source| Error::Io {
        path: path.display().to_string(),
        source,
    };
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(io(e)),
    };
    let text = merge_desktop_config(existing.as_deref(), entry)?;
    let dir = path
        .parent()
        .ok_or_else(|| Error::Invalid(format!("no folder for {}", path.display())))?;
    std::fs::create_dir_all(dir).map_err(io)?;
    if let Some(old) = &existing
        && old != &text
    {
        let mut backup = path.as_os_str().to_owned();
        backup.push(".bak");
        std::fs::write(PathBuf::from(backup), old).map_err(io)?;
    }
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(io)?;
    tmp.write_all(text.as_bytes()).map_err(io)?;
    tmp.persist(path).map_err(|e| io(e.error))?;
    Ok(desktop_status(path, entry))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum RegistrationScope {
    User,
    Local,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum RegistrationProblem {
    /// A local or project registration: in that folder it hides the user registration.
    ShadowsUser,
    /// Tied to one vault with `--vault` or `MOSAIC_VAULT`.
    PinsVault,
    /// A bare or relative command: apps started from the Dock don't have the terminal's PATH.
    NotAbsolute,
    /// The command doesn't exist (an old install location).
    CommandMissing,
    /// Runs another program than this app's `mosaic` command.
    OtherCommand,
}

/// A Claude Code registration named `mosaic`, with what's wrong with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Registration {
    pub scope: RegistrationScope,
    /// The project folder, for local and project registrations.
    pub project: Option<String>,
    pub entry: ServerEntry,
    pub problems: Vec<RegistrationProblem>,
}

/// Claude Code's own config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
pub fn claude_code_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir).join(".claude.json"));
    }
    Some(PathBuf::from(std::env::var_os("HOME")?).join(".claude.json"))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn problems(v: &Value, scope: RegistrationScope, cli: Option<&Path>) -> Vec<RegistrationProblem> {
    use RegistrationProblem::*;
    let entry = ServerEntry::from_json(v);
    let mut found = vec![];
    if scope != RegistrationScope::User {
        found.push(ShadowsUser);
    }
    let pinned_env = v["env"]
        .as_object()
        .is_some_and(|e| e.contains_key("MOSAIC_VAULT"));
    if pinned_env
        || entry
            .args
            .iter()
            .any(|a| a == "--vault" || a.starts_with("--vault="))
    {
        found.push(PinsVault);
    }
    let command = Path::new(&entry.command);
    if !command.is_absolute() {
        found.push(NotAbsolute);
    } else if !command.exists() {
        found.push(CommandMissing);
    } else if let Some(cli) = cli
        && !same_file(command, cli)
    {
        found.push(OtherCommand);
    }
    found
}

/// Every Claude Code registration named `mosaic` that Claude Code's config file mentions: the user
/// one, local ones, and project ones (`.mcp.json`) in the folders Claude Code has been used in.
/// `cli` is this app's `mosaic` command, when known. Read-only; a missing or unreadable file
/// yields nothing.
pub fn claude_code_registrations(config: &Path, cli: Option<&Path>) -> Vec<Registration> {
    let Some(root) = std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        return vec![];
    };
    let mut found = vec![];
    let mut add = |v: &Value, scope, project: Option<&str>| {
        if v.is_object() {
            found.push(Registration {
                scope,
                project: project.map(str::to_string),
                entry: ServerEntry::from_json(v),
                problems: problems(v, scope, cli),
            });
        }
    };
    add(
        &root["mcpServers"][SERVER_NAME],
        RegistrationScope::User,
        None,
    );
    if let Some(projects) = root["projects"].as_object() {
        for (folder, p) in projects {
            add(
                &p["mcpServers"][SERVER_NAME],
                RegistrationScope::Local,
                Some(folder),
            );
            let shared = std::fs::read_to_string(Path::new(folder).join(".mcp.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok());
            if let Some(shared) = shared {
                add(
                    &shared["mcpServers"][SERVER_NAME],
                    RegistrationScope::Project,
                    Some(folder),
                );
            }
        }
    }
    found
}

/// What a test connection found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ProbeResult {
    /// The server started and answered the MCP handshake and the tool list.
    pub ok: bool,
    pub server_version: Option<String>,
    pub tools: u32,
    /// Connected, but no vault can be opened yet: why, as the agent would be told.
    pub no_vault: Option<String>,
    /// Why it failed, when it did.
    pub error: Option<String>,
    /// The end of what the server wrote to stderr.
    pub stderr: String,
}

/// Starts `command args` the way Claude Desktop does (no terminal: only HOME, a system PATH and
/// `env`), speaks MCP to it over stdio and reports whether a client could use it.
pub fn probe(
    command: &Path,
    args: &[String],
    env: &[(String, String)],
    timeout: Duration,
) -> ProbeResult {
    let mut result = ProbeResult {
        ok: false,
        server_version: None,
        tools: 0,
        no_vault: None,
        error: None,
        stderr: String::new(),
    };
    let mut cmd = Command::new(command);
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in [
        "HOME",
        "USER",
        "TMPDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "SYSTEMROOT",
    ] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            result.error = Some(format!("couldn't start {}: {e}", command.display()));
            return result;
        }
    };
    let mut stdin = child.stdin.take().expect("piped");
    let stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let (tx, lines) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    // Read on a thread and waited for with a limit: a process the server started can keep the pipe
    // open after the server is gone.
    let (err_tx, err_text) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        let _ = err_tx.send(text);
    });
    let deadline = Instant::now() + timeout;
    let outcome = (|| -> std::result::Result<(), String> {
        let mut send = |msg: Value| {
            writeln!(stdin, "{msg}")
                .and_then(|_| stdin.flush())
                .map_err(|_| "the server exited before answering".to_string())
        };
        let answer = |id: u64| -> std::result::Result<Value, String> {
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                let line = match lines.recv_timeout(left) {
                    Ok(line) => line,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        return Err(format!("no answer within {} s", timeout.as_secs()));
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("the server exited before answering".into());
                    }
                };
                let msg: Value = serde_json::from_str(&line)
                    .ok()
                    .filter(|m: &Value| m["jsonrpc"] == "2.0")
                    .ok_or_else(|| {
                        format!("the server printed something other than MCP messages: {line}")
                    })?;
                if msg["id"] == json!(id) {
                    if let Some(e) = msg.get("error") {
                        return Err(format!("the server refused the request: {e}"));
                    }
                    return Ok(msg["result"].clone());
                }
            }
        };
        send(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "mosaic-connection-test", "version": env!("CARGO_PKG_VERSION") }
            }
        }))?;
        let init = answer(1)?;
        result.server_version = init["serverInfo"]["version"].as_str().map(str::to_string);
        send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))?;
        let tools = answer(2)?;
        result.tools = tools["tools"].as_array().map_or(0, |t| t.len() as u32);
        // A cheap read-only call shows whether a vault opens.
        send(json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "list_files", "arguments": {} }
        }))?;
        let listed = answer(3)?;
        if listed["isError"] == json!(true) {
            let text = listed["content"][0]["text"].as_str().unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(text).unwrap_or_default();
            if parsed["code"] == "no_vault" {
                result.no_vault = parsed["message"].as_str().map(str::to_string);
            } else {
                return Err(format!("listing the vault failed: {text}"));
            }
        }
        Ok(())
    })();
    // End of input first: the server (and anything it started that reads stdin) exits on its own.
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let stderr = err_text
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_default();
    let tail_from = stderr.char_indices().rev().nth(1999).map_or(0, |(i, _)| i);
    result.stderr = stderr[tail_from..].trim().to_string();
    match outcome {
        Ok(()) => result.ok = true,
        Err(e) => result.error = Some(e),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> ServerEntry {
        ServerEntry::for_cli(Path::new("/Applications/Mosaic.app/Contents/MacOS/mosaic"))
    }

    #[test]
    fn merging_keeps_other_servers_and_settings() {
        let existing = r#"{"globalShortcut":"Cmd+K","mcpServers":{"other":{"command":"/bin/other","args":["x"],"env":{"K":"V"}},"mosaic":{"command":"mosaic","args":["--vault","/old","mcp"]}}}"#;
        let merged: Value =
            serde_json::from_str(&merge_desktop_config(Some(existing), &entry()).unwrap()).unwrap();
        assert_eq!(merged["globalShortcut"], "Cmd+K");
        assert_eq!(
            merged["mcpServers"]["other"],
            json!({"command":"/bin/other","args":["x"],"env":{"K":"V"}})
        );
        assert_eq!(
            merged["mcpServers"]["mosaic"],
            json!({"command":"/Applications/Mosaic.app/Contents/MacOS/mosaic","args":["mcp"]})
        );
    }

    #[test]
    fn merging_creates_a_config_from_nothing_or_an_empty_file() {
        for existing in [None, Some(""), Some("{}"), Some("{\"mcpServers\":{}}")] {
            let merged: Value =
                serde_json::from_str(&merge_desktop_config(existing, &entry()).unwrap()).unwrap();
            assert_eq!(merged["mcpServers"]["mosaic"]["args"], json!(["mcp"]));
        }
    }

    #[test]
    fn merging_refuses_a_broken_file_instead_of_overwriting_it() {
        for broken in [
            "{\"mcpServers\": {",
            "[]",
            "{\"mcpServers\": []}",
            "{} {\"mcpServers\":{}}",
        ] {
            let e = merge_desktop_config(Some(broken), &entry()).unwrap_err();
            assert!(e.to_string().contains("isn't valid JSON"), "{e}");
        }
    }

    #[test]
    fn writing_reports_status_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Claude/claude_desktop_config.json");
        assert_eq!(desktop_status(&path, &entry()).state, DesktopState::Missing);
        assert_eq!(
            write_desktop_config(&path, &entry()).unwrap().state,
            DesktopState::Configured
        );
        assert!(
            !dir.path()
                .join("Claude/claude_desktop_config.json.bak")
                .exists()
        );

        let old =
            r#"{"mcpServers":{"mosaic":{"command":"mosaic","args":["mcp"]},"x":{"command":"/x"}}}"#;
        std::fs::write(&path, old).unwrap();
        assert_eq!(
            desktop_status(&path, &entry()).state,
            DesktopState::Different {
                entry: ServerEntry {
                    command: "mosaic".into(),
                    args: vec!["mcp".into()]
                }
            }
        );
        write_desktop_config(&path, &entry()).unwrap();
        let backup = dir.path().join("Claude/claude_desktop_config.json.bak");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), old);
        let now: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(now["mcpServers"]["x"]["command"], "/x");

        std::fs::write(&path, "{oops").unwrap();
        assert!(matches!(
            desktop_status(&path, &entry()).state,
            DesktopState::Invalid { .. }
        ));
        assert!(write_desktop_config(&path, &entry()).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{oops",
            "left alone"
        );
    }

    #[test]
    fn an_env_pinned_vault_is_not_configured() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        let e = entry();
        std::fs::write(
            &path,
            json!({"mcpServers":{"mosaic":{"command":e.command,"args":["mcp"],"env":{"MOSAIC_VAULT":"/v"}}}}).to_string(),
        )
        .unwrap();
        assert!(matches!(
            desktop_status(&path, &e).state,
            DesktopState::Different { .. }
        ));
    }

    #[test]
    fn finds_every_mosaic_registration_and_its_problems() {
        use RegistrationProblem::*;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("Mosaic.app/mosaic");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "").unwrap();
        let link = dir.path().join("bin/mosaic");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&cli, &link).unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(
            b.join(".mcp.json"),
            json!({"mcpServers":{"mosaic":{"command":"/gone/mosaic","args":["mcp"]}}}).to_string(),
        )
        .unwrap();
        let config = dir.path().join(".claude.json");
        std::fs::write(
            &config,
            json!({
                "mcpServers": { "mosaic": { "type": "stdio", "command": link, "args": ["mcp"] } },
                "projects": {
                    a.to_str().unwrap(): { "mcpServers": { "mosaic": { "command": "mosaic", "args": ["--vault", "/v", "mcp"] } } },
                    b.to_str().unwrap(): { "mcpServers": {} },
                    "/no/such/project": {}
                }
            })
            .to_string(),
        )
        .unwrap();
        let found = claude_code_registrations(&config, Some(&cli));
        assert_eq!(found.len(), 3, "{found:?}");
        assert_eq!(found[0].scope, RegistrationScope::User);
        #[cfg(unix)]
        assert_eq!(
            found[0].problems,
            vec![],
            "a link to the app's command is fine"
        );
        assert_eq!(found[1].scope, RegistrationScope::Local);
        assert_eq!(found[1].project.as_deref(), a.to_str());
        assert_eq!(found[1].problems, vec![ShadowsUser, PinsVault, NotAbsolute]);
        assert_eq!(found[2].scope, RegistrationScope::Project);
        assert_eq!(found[2].problems, vec![ShadowsUser, CommandMissing]);

        assert!(claude_code_registrations(&dir.path().join("none.json"), None).is_empty());
    }

    #[test]
    fn probing_reports_a_command_that_cant_start() {
        let r = probe(
            Path::new("/no/such/mosaic"),
            &["mcp".into()],
            &[],
            Duration::from_secs(5),
        );
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("couldn't start"));
    }

    #[cfg(unix)]
    #[test]
    fn probing_rejects_output_that_isnt_mcp() {
        let r = probe(
            Path::new("/bin/sh"),
            &["-c".into(), "echo hello; cat >/dev/null".into()],
            &[],
            Duration::from_secs(5),
        );
        assert!(!r.ok);
        assert!(
            r.error
                .as_deref()
                .unwrap()
                .contains("other than MCP messages"),
            "{r:?}"
        );

        let r = probe(
            Path::new("/bin/sh"),
            &["-c".into(), "echo boom >&2; exit 1".into()],
            &[],
            Duration::from_secs(5),
        );
        assert_eq!(
            r.error.as_deref(),
            Some("the server exited before answering")
        );
        assert_eq!(r.stderr, "boom");
    }
}
