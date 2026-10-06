//! Tessera: scheduled vault agents. Schedules are checked while the app is open; a single missed
//! occurrence runs on startup. Results live in app settings, never in the vault.

use crate::{AppState, chat};
use chrono::{Local, TimeZone};
use mosaic_core::Error;
use mosaic_core::chat::{ALLOWED_TOOLS, ChatEvent, DISALLOWED_TOOLS, parse_line, system_prompt};
use mosaic_core::settings::{AgentRun, Settings, TesseraSettings};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, Error>;

#[derive(Default)]
pub struct TesseraState {
    generation: AtomicU64,
    next: AtomicU64,
    running: Mutex<HashSet<String>>,
}

#[derive(Serialize)]
pub struct TesseraStatus {
    paused: bool,
    agents: Vec<ScheduledAgent>,
    runs: Vec<AgentRun>,
}

#[derive(Serialize)]
struct ScheduledAgent {
    name: String,
    title: String,
    schedule: String,
    paused: bool,
    running: bool,
    error: Option<String>,
}

fn save(root: &std::path::Path, value: TesseraSettings) -> CmdResult<()> {
    Settings::update(|s| {
        s.set_tessera(root, value);
        true
    })
    .map_err(|e| Error::Io {
        path: "settings.json".into(),
        source: e,
    })
}

#[tauri::command]
pub fn tessera_status(
    state: State<AppState>,
    tessera: State<TesseraState>,
) -> CmdResult<TesseraStatus> {
    let ws = state.get()?;
    let cfg = Settings::load().tessera(ws.vault.root());
    let running = tessera.running.lock().expect("tessera lock");
    let agents = ws
        .agents()?
        .into_iter()
        .filter_map(|a| {
            a.schedule.map(|schedule| {
                let error = mosaic_core::schedule::parse(&schedule).err();
                ScheduledAgent {
                    paused: cfg.paused_agents.contains(&a.name),
                    running: running.contains(&format!(
                        "{}\0{}",
                        ws.vault.root().display(),
                        a.name
                    )),
                    name: a.name,
                    title: a.title,
                    schedule,
                    error,
                }
            })
        })
        .collect();
    Ok(TesseraStatus {
        paused: cfg.paused,
        agents,
        runs: cfg.runs,
    })
}

#[tauri::command]
pub fn tessera_pause_all(state: State<AppState>, paused: bool) -> CmdResult<()> {
    let ws = state.get()?;
    let mut cfg = Settings::load().tessera(ws.vault.root());
    cfg.paused = paused;
    save(ws.vault.root(), cfg)
}

#[tauri::command]
pub fn tessera_pause_agent(state: State<AppState>, name: String, paused: bool) -> CmdResult<()> {
    let ws = state.get()?;
    let mut cfg = Settings::load().tessera(ws.vault.root());
    cfg.paused_agents.retain(|n| n != &name);
    if paused {
        cfg.paused_agents.push(name);
    }
    save(ws.vault.root(), cfg)
}

#[tauri::command]
pub fn tessera_run(app: AppHandle, state: State<AppState>, name: String) -> CmdResult<u64> {
    let ws = state.get()?;
    start_agent(&app, &ws, &name, false)
}

/// Invalidates the old vault's loop and starts one for the newly active vault.
pub fn start_scheduler(app: AppHandle) {
    let generation = app
        .state::<TesseraState>()
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    std::thread::spawn(move || {
        tick(&app, true);
        loop {
            std::thread::sleep(Duration::from_secs(30));
            if app
                .state::<TesseraState>()
                .generation
                .load(Ordering::SeqCst)
                != generation
            {
                break;
            }
            tick(&app, false);
        }
    });
}

fn tick(app: &AppHandle, startup: bool) {
    let Ok(ws) = app.state::<AppState>().get() else {
        return;
    };
    let root = ws.vault.root().to_path_buf();
    let now = Local::now();
    let mut cfg = Settings::load().tessera(&root);
    if cfg.last_checked == 0 {
        cfg.last_checked = now.timestamp();
        let _ = save(&root, cfg);
        return;
    }
    let last = Local
        .timestamp_opt(cfg.last_checked, 0)
        .single()
        .unwrap_or(now);
    let paused = cfg.paused;
    let paused_agents = cfg.paused_agents.clone();
    cfg.last_checked = now.timestamp();
    let _ = save(&root, cfg);
    if paused {
        return;
    }
    for agent in ws.agents().unwrap_or_default() {
        let Some(text) = &agent.schedule else {
            continue;
        };
        if paused_agents.contains(&agent.name) {
            continue;
        }
        let Ok(schedule) = mosaic_core::schedule::parse(text) else {
            continue;
        };
        if mosaic_core::schedule::due(&schedule, last, now) {
            let _ = start_agent(app, &ws, &agent.name, startup);
        }
    }
}

fn start_agent(
    app: &AppHandle,
    ws: &mosaic_core::Workspace,
    name: &str,
    late: bool,
) -> CmdResult<u64> {
    let agent = ws.agent(name)?;
    let tessera = app.state::<TesseraState>();
    let running_key = format!("{}\0{}", ws.vault.root().display(), agent.name);
    {
        let mut running = tessera.running.lock().expect("tessera lock");
        if !running.insert(running_key.clone()) {
            return Err(Error::Invalid(format!(
                "{} is already running",
                agent.title
            )));
        }
    }
    let result = spawn(app, ws, &agent, late);
    if result.is_err() {
        tessera
            .running
            .lock()
            .expect("tessera lock")
            .remove(&running_key);
    }
    result
}

fn spawn(
    app: &AppHandle,
    ws: &mosaic_core::Workspace,
    agent: &mosaic_core::agents::Agent,
    late: bool,
) -> CmdResult<u64> {
    let claude = chat::find_claude()
        .ok_or_else(|| Error::Invalid("Claude Code isn't installed or logged in".into()))?;
    let mosaic = chat::mosaic_cli().ok_or_else(|| {
        Error::Invalid("The mosaic command wasn't found; install it in Settings › AI".into())
    })?;
    let _ = ws.mirror_agents();
    let root = ws.vault.root().to_path_buf();
    let vault_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut args = vec!["--vault".to_string(), root.display().to_string()];
    for path in &agent.may_change {
        args.push("--may-change".into());
        args.push(path.clone());
    }
    // An explicitly empty allowlist must still review every write.
    if agent.may_change.is_empty() {
        args.push("--may-change".into());
        args.push("/.mosaic-no-direct-writes".into());
    }
    args.push("mcp".into());
    let mcp = serde_json::json!({"mcpServers":{"mosaic":{"command":mosaic,"args":args}}});
    let mut child = Command::new(claude);
    child
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
        ])
        .arg("--mcp-config")
        .arg(mcp.to_string())
        .arg("--append-system-prompt")
        .arg(system_prompt(&vault_name, None, &[], None))
        .arg("--allowedTools")
        .args(ALLOWED_TOOLS.split(' '))
        .arg("--disallowedTools")
        .args(DISALLOWED_TOOLS.split(' '))
        .current_dir(&root)
        .env("PATH", chat::path_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = child
        .spawn()
        .map_err(|e| Error::Invalid(format!("couldn't start Claude Code: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(mosaic_core::agents::agent_prompt(agent, None).as_bytes());
    }
    let state = app.state::<TesseraState>();
    let id = (Local::now().timestamp_millis() as u64) * 1_000
        + state.next.fetch_add(1, Ordering::SeqCst) % 1_000;
    let mut cfg = Settings::load().tessera(&root);
    cfg.runs.insert(
        0,
        AgentRun {
            id,
            agent: agent.name.clone(),
            title: agent.title.clone(),
            started: Local::now().timestamp(),
            finished: None,
            late,
            status: "running".into(),
            answer: String::new(),
            error: None,
            proposals: 0,
            changes: Vec::new(),
        },
    );
    cfg.runs.truncate(100);
    save(&root, cfg)?;
    let _ = app.emit("tessera-changed", ());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let handle = app.clone();
    let running_key = format!("{}\0{}", root.display(), agent.name);
    std::thread::spawn(move || {
        let err_tail = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut e) = stderr {
                let _ = e.read_to_string(&mut s);
            }
            s
        });
        let mut answer = String::new();
        let mut error = None;
        let mut proposals = 0;
        let mut changes = Vec::new();
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                for event in parse_line(&line) {
                    match event {
                        ChatEvent::Text { text } => {
                            if !answer.is_empty() {
                                answer.push('\n');
                            }
                            answer.push_str(&text);
                        }
                        ChatEvent::ToolDone {
                            review: Some(_), ..
                        } => proposals += 1,
                        ChatEvent::Tool {
                            summary,
                            writes: true,
                            ..
                        } => changes.push(summary),
                        ChatEvent::Done { error: e, .. } => error = e,
                        _ => {}
                    }
                }
            }
        }
        let status = child.wait();
        let stderr = err_tail.join().unwrap_or_default();
        if error.is_none() && !status.is_ok_and(|s| s.success()) {
            error = Some(
                stderr
                    .trim()
                    .lines()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        let mut cfg = Settings::load().tessera(&root);
        if let Some(run) = cfg.runs.iter_mut().find(|r| r.id == id) {
            run.finished = Some(Local::now().timestamp());
            run.status = if error.is_some() { "failed" } else { "done" }.into();
            run.answer = answer;
            run.error = error;
            run.proposals = proposals;
            run.changes = changes;
        }
        let _ = save(&root, cfg);
        handle
            .state::<TesseraState>()
            .running
            .lock()
            .expect("tessera lock")
            .remove(&running_key);
        let _ = handle.emit("tessera-changed", ());
    });
    Ok(id)
}
