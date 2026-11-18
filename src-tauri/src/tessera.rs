//! Tessera: manual, scheduled and event-triggered vault agents. Automatic workflows run while the
//! app is open. Results and queue/chain safety state live outside the vault.

use crate::{AppState, chat};
use chrono::Local;
use mosaic_core::Error;
use mosaic_core::agents::{Agent, EventTrigger};
use mosaic_core::chat::{
    ChatEvent, RunTranscript, allowed_tools, disallowed_tools, event_prompt, parse_line,
    system_prompt,
};
use mosaic_core::settings::{AgentRun, TesseraSettings};
use mosaic_core::tessera::{self as core, Control, TesseraStatus, trigger_error};
use mosaic_core::vault_state::VaultState;
use mosaic_core::workflow::{
    Chain, QueuedRun, RunCause, RunHost, RunOutput, WorkflowQueue, run_with_retry, scheduled_runs,
};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, Error>;
#[derive(Default)]
struct EventState {
    root: PathBuf,
    known: HashSet<String>,
    queue: WorkflowQueue,
    /// A workflow registers the chain before its create tool runs; the watcher consumes it.
    origins: HashMap<String, Chain>,
}

#[derive(Default)]
pub struct TesseraState {
    generation: AtomicU64,
    next: AtomicU64,
    running: Mutex<HashSet<String>>,
    transcripts: Mutex<HashMap<u64, RunTranscript>>,
    events: Mutex<EventState>,
    /// Pauses as last seen, to notice another process's resume (`poll_external`).
    control: Mutex<Option<(PathBuf, Control, Option<std::time::SystemTime>)>>,
}

/// The scheduler's state for a vault, in `vaults/<id>/tessera-state.json` (not settings.json, which
/// it used to rewrite every 30 s). Shared with other processes through `mosaic_core::tessera`.
fn store(root: &Path) -> CmdResult<VaultState> {
    #[cfg(test)]
    if let Some(dir) = TEST_STORE.with(|s| s.borrow().clone()) {
        return VaultState::in_dir(dir);
    }
    VaultState::open(root)
}

// Tests keep the scheduler's state in a temporary folder instead of Application Support.
#[cfg(test)]
thread_local! {
    static TEST_STORE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn config(root: &Path) -> CmdResult<TesseraSettings> {
    store(root)?.tessera()
}

fn update<T>(root: &Path, change: impl FnOnce(&mut TesseraSettings) -> T) -> CmdResult<T> {
    store(root)?.update_tessera(change)
}

fn running_key(root: &Path, agent: &str) -> String {
    format!("{}\0{agent}", root.display())
}

#[tauri::command(async)]
#[specta::specta]
pub fn tessera_status(
    state: State<AppState>,
    tessera: State<TesseraState>,
) -> CmdResult<TesseraStatus> {
    let ws = state.get()?;
    let root = ws.vault.root();
    let cfg = {
        let transcripts = tessera.transcripts.lock().expect("tessera transcript lock");
        core::with_transcripts(config(root)?, |id| transcripts.get(&id).cloned())
    };
    let running = tessera.running.lock().expect("tessera lock");
    let events = tessera.events.lock().expect("tessera event lock");
    core::status(
        &ws,
        cfg,
        |name| running.contains(&running_key(root, name)),
        |name| events.queue.count(root, name),
    )
}

#[tauri::command(async)]
#[specta::specta]
pub fn tessera_pause_all(app: AppHandle, state: State<AppState>, paused: bool) -> CmdResult<()> {
    let ws = state.get()?;
    core::pause_all(&store(ws.vault.root())?, paused)?;
    if !paused {
        drain_queue(&app, &ws);
    }
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn tessera_pause_agent(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    paused: bool,
) -> CmdResult<()> {
    let ws = state.get()?;
    core::pause_agent(&store(ws.vault.root())?, &name, paused)?;
    if !paused {
        drain_queue(&app, &ws);
    }
    Ok(())
}

/// Only the app changes the chain-depth limit: `mosaic_core::tessera` has no setter, so another
/// process (an MCP client) can't raise its own limit.
#[tauri::command(async)]
#[specta::specta]
pub fn tessera_set_max_chain_depth(state: State<AppState>, depth: u8) -> CmdResult<()> {
    if depth > 10 {
        return Err(Error::Invalid(
            "workflow chain depth must be between 0 and 10".into(),
        ));
    }
    let ws = state.get()?;
    update(ws.vault.root(), |cfg| cfg.max_chain_depth = depth)
}

#[tauri::command(async)]
#[specta::specta]
pub fn tessera_run(app: AppHandle, state: State<AppState>, name: String) -> CmdResult<u64> {
    let ws = state.get()?;
    start_agent(&app, &ws, &name, RunCause::Manual)
}

#[tauri::command(async)]
#[specta::specta]
pub fn tessera_test_event(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    path: String,
) -> CmdResult<u64> {
    let ws = state.get()?;
    let agent = ws.agent(&name)?;
    ws.files.read(&path)?;
    let trigger = agent
        .on
        .iter()
        .find(|raw| EventTrigger::parse(raw).is_ok_and(|event| event.matches_created(&path)))
        .cloned()
        .ok_or_else(|| Error::Invalid(format!("{path} doesn't match this workflow's events")))?;
    let chain = Chain {
        id: new_id(&app, "test"),
        depth: 0,
    };
    start_agent(
        &app,
        &ws,
        &name,
        RunCause::Event {
            trigger,
            path,
            chain,
            test: true,
        },
    )
}

/// Resets the event snapshot and queue when a vault becomes active. Existing files never count as
/// creations, which also means there is intentionally no offline catch-up.
pub fn reset_events(app: &AppHandle, ws: &Arc<mosaic_core::Workspace>) {
    let known = ws
        .files
        .list("", true)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| e.path)
        .collect();
    *app.state::<TesseraState>()
        .events
        .lock()
        .expect("tessera event lock") = EventState {
        root: ws.vault.root().to_path_buf(),
        known,
        ..EventState::default()
    };
}

/// Called after the vault watcher refreshed changed paths. A path not in the activation snapshot is
/// a creation; only Markdown notes can match M26 event triggers.
pub fn vault_changed(app: &AppHandle, ws: &Arc<mosaic_core::Workspace>, paths: &[String]) {
    let root = ws.vault.root();
    let mut created = Vec::new();
    let removed_known;
    {
        let state = app.state::<TesseraState>();
        let mut events = state.events.lock().expect("tessera event lock");
        if events.root != root {
            return;
        }
        removed_known = paths
            .iter()
            .filter(|path| events.known.contains(*path) && !ws.vault.exists(path))
            .cloned()
            .collect::<HashSet<_>>();
        for path in paths {
            let exists = ws.vault.exists(path);
            let known = events.known.contains(path);
            if exists {
                events.known.insert(path.clone());
                if !known && path.to_ascii_lowercase().ends_with(".md") {
                    created.push((path.clone(), events.origins.remove(path)));
                } else if !known {
                    // Origins are registered before an agent creates any kind of file. Only
                    // Markdown can trigger a workflow, so don't retain binary-file origins.
                    events.origins.remove(path);
                }
            } else {
                events.known.remove(path);
                events.origins.remove(path);
            }
        }
    }
    for (path, origin) in created {
        // A move has a new destination path too, but it is not a creation trigger. Mosaic records
        // the rename before the watcher fires. For a moved folder, map the destination child back
        // to its source and require that source to have disappeared in the same watcher batch.
        let moved = recent_mosaic_move_source(ws, &path)
            .is_some_and(|(source, exact)| exact || removed_known.contains(&source));
        if ws.files.read(&path).is_err() || moved {
            continue;
        }
        let chain = origin.unwrap_or_else(|| {
            let from_agent = ws
                .files
                .history(&path, 1)
                .ok()
                .and_then(|v| v.into_iter().next())
                .is_some_and(|v| v.source == "agent");
            Chain {
                id: new_id(app, "event"),
                depth: u8::from(from_agent),
            }
        });
        dispatch_created(app, ws, &path, chain);
    }
}

fn recent_mosaic_move_source(ws: &mosaic_core::Workspace, path: &str) -> Option<(String, bool)> {
    let now = Local::now().timestamp_millis();
    let mut candidate = path;
    loop {
        if let Some(version) = ws.files.history(candidate, 3).ok().and_then(|versions| {
            versions.into_iter().find(|version| {
                version.action == "renamed"
                    && (0..=5_000).contains(&now.saturating_sub(version.time))
            })
        }) && let Some(from) = version.from_path
        {
            let suffix = path.strip_prefix(candidate).unwrap_or_default();
            return Some((format!("{from}{suffix}"), candidate == path));
        }
        let (parent, _) = candidate.rsplit_once('/')?;
        candidate = parent;
    }
}

/// Invalidates the old vault's schedule loop and starts one for the newly active vault.
pub fn start_scheduler(app: AppHandle) {
    let generation = app
        .state::<TesseraState>()
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    std::thread::spawn(move || {
        tick(&app, true);
        let mut last_tick = Instant::now();
        loop {
            std::thread::sleep(core::POLL);
            if app
                .state::<TesseraState>()
                .generation
                .load(Ordering::SeqCst)
                != generation
            {
                break;
            }
            if let Ok(ws) = app.state::<AppState>().get() {
                poll_external(&app, &ws);
            }
            if last_tick.elapsed() >= Duration::from_secs(30) {
                last_tick = Instant::now();
                tick(&app, false);
            }
        }
    });
}

/// Picks up what other processes (`mosaic mcp`) asked through `mosaic_core::tessera`: run
/// requests are queued like agent-created events (they wait while paused and count toward the
/// chain-depth limit), and a resume written by another process starts what was waiting.
fn poll_external(app: &AppHandle, ws: &Arc<mosaic_core::Workspace>) {
    let root = ws.vault.root();
    let tessera = app.state::<TesseraState>();
    let external = tessera.observe_external(root);
    for (agent, cause, reason) in external.skipped {
        record_skipped(app, root, &agent, &cause, reason);
    }
    if external.changed {
        let _ = app.emit("tessera-changed", ());
        // A resume, or a request taken while nothing is paused, can start what was waiting.
        drain_queue(app, ws);
    }
}

/// What `observe_external` found.
#[derive(Default)]
struct External {
    /// Requests the queue refused (chain-depth limit, repeats, full queue): agent, cause, reason.
    skipped: Vec<(String, RunCause, String)>,
    /// Requests were taken or another process changed a pause.
    changed: bool,
    /// Something paused before can run now.
    resumed: bool,
}

impl TesseraState {
    /// Takes the pending run requests into the event queue and compares the pauses with the ones
    /// seen last time. Reads the state file only when it was written since.
    fn observe_external(&self, root: &Path) -> External {
        let mut external = External::default();
        let Ok(state) = store(root) else {
            return external;
        };
        for request in core::take_run_requests(&state).unwrap_or_default() {
            external.changed = true;
            let agent = request.agent.clone();
            if let Err((cause, reason)) = self.queue_requested(root, request) {
                external.skipped.push((agent, cause, reason));
            }
        }
        let modified = state.tessera_modified();
        let mut control = self.control.lock().expect("tessera control lock");
        let unchanged = control
            .as_ref()
            .is_some_and(|(r, _, m)| r == root && *m == modified);
        if !unchanged && let Ok(cfg) = state.tessera() {
            let next = Control::of(&cfg);
            if let Some((r, previous, _)) = control.as_ref()
                && r == root
                && previous != &next
            {
                external.changed = true;
                external.resumed = previous.resumed(&next);
            }
            *control = Some((root.to_path_buf(), next, modified));
        }
        external
    }

    /// Queues a requested run, checked against the chain-depth limit as it is now.
    fn queue_requested(
        &self,
        root: &Path,
        request: core::RunRequest,
    ) -> Result<(), (RunCause, String)> {
        let expired = request.expired(Local::now().timestamp());
        let cause = RunCause::Requested {
            chain: request.chain.into(),
            request: request.id,
        };
        if expired {
            return Err((
                cause,
                "Requested while Mosaic wasn't running this vault's workflows.".into(),
            ));
        }
        let cfg = config(root).map_err(|e| (cause.clone(), e.to_string()))?;
        let reason = self
            .events
            .lock()
            .expect("tessera event lock")
            .queue
            .enqueue(
                QueuedRun {
                    root: root.to_path_buf(),
                    agent: request.agent,
                    cause: cause.clone(),
                },
                cfg.max_chain_depth,
                Instant::now(),
            );
        reason.map_or(Ok(()), |reason| Err((cause, reason)))
    }

    /// The oldest queued run allowed to start now. Pauses are re-read from the shared state each
    /// time, so a pause another process wrote holds the queue.
    fn next_queued(&self, root: &Path) -> Option<QueuedRun> {
        let cfg = config(root).ok()?;
        if cfg.paused {
            return None;
        }
        let running = self.running.lock().expect("tessera lock").clone();
        let mut events = self.events.lock().expect("tessera event lock");
        events.queue.next(root, &cfg, |root, agent| {
            running.contains(&running_key(root, agent))
        })
    }
}

fn tick(app: &AppHandle, startup: bool) {
    let Ok(ws) = app.state::<AppState>().get() else {
        return;
    };
    let root = ws.vault.root().to_path_buf();
    let now = Local::now();
    let Ok(cfg) = update(&root, |cfg| {
        let previous = cfg.clone();
        cfg.last_checked = cfg.last_checked.max(now.timestamp());
        previous
    }) else {
        return;
    };
    for (name, cause) in scheduled_runs(&ws.agents().unwrap_or_default(), &cfg, now, startup) {
        let _ = start_agent(app, &ws, &name, cause);
    }
}

fn new_id(app: &AppHandle, prefix: &str) -> String {
    let state = app.state::<TesseraState>();
    format!(
        "{prefix}-{}-{}",
        Local::now().timestamp_millis(),
        state.next.fetch_add(1, Ordering::SeqCst)
    )
}

fn dispatch_created(app: &AppHandle, ws: &Arc<mosaic_core::Workspace>, path: &str, chain: Chain) {
    let Ok(cfg) = config(ws.vault.root()) else {
        return;
    };
    if cfg.paused {
        return;
    }
    let mut matching = Vec::new();
    for agent in ws.agents().unwrap_or_default() {
        if cfg.paused_agents.contains(&agent.name) {
            continue;
        }
        if let Some(trigger) = agent
            .on
            .iter()
            .find(|raw| EventTrigger::parse(raw).is_ok_and(|event| event.matches_created(path)))
        {
            matching.push((agent.name, trigger.clone()));
        }
    }
    for (agent, trigger) in matching {
        enqueue_event(app, ws, agent, trigger, path.to_string(), chain.clone());
    }
    drain_queue(app, ws);
}

fn enqueue_event(
    app: &AppHandle,
    ws: &Arc<mosaic_core::Workspace>,
    agent: String,
    trigger: String,
    path: String,
    chain: Chain,
) {
    let Ok(cfg) = config(ws.vault.root()) else {
        return;
    };
    let reason = {
        let state = app.state::<TesseraState>();
        let mut events = state.events.lock().expect("tessera event lock");
        events.queue.enqueue(
            QueuedRun {
                root: ws.vault.root().to_path_buf(),
                agent: agent.clone(),
                cause: RunCause::Event {
                    trigger: trigger.clone(),
                    path: path.clone(),
                    chain: chain.clone(),
                    test: false,
                },
            },
            cfg.max_chain_depth,
            Instant::now(),
        )
    };
    if let Some(reason) = reason {
        let cause = RunCause::Event {
            trigger,
            path,
            chain,
            test: false,
        };
        record_skipped(app, ws.vault.root(), &agent, &cause, reason);
    } else {
        let _ = app.emit("tessera-changed", ());
    }
}

fn drain_queue(app: &AppHandle, ws: &Arc<mosaic_core::Workspace>) {
    loop {
        let job = app.state::<TesseraState>().next_queued(ws.vault.root());
        let Some(job) = job else { break };
        if let Err(error) = start_agent(app, ws, &job.agent, job.cause.clone()) {
            // Another drain may have won the race to start this workflow. Put its event back
            // instead of turning a valid queued run into a skipped one.
            let is_running = app
                .state::<TesseraState>()
                .running
                .lock()
                .expect("tessera lock")
                .contains(&running_key(&job.root, &job.agent));
            if is_running {
                app.state::<TesseraState>()
                    .events
                    .lock()
                    .expect("tessera event lock")
                    .queue
                    .requeue(job);
                break;
            }
            if job.cause.chain().is_some() {
                record_skipped(
                    app,
                    ws.vault.root(),
                    &job.agent,
                    &job.cause,
                    error.to_string(),
                );
            }
        }
    }
}

fn record_skipped(app: &AppHandle, root: &Path, agent: &str, cause: &RunCause, reason: String) {
    let title = app
        .state::<AppState>()
        .get()
        .ok()
        .and_then(|ws| ws.agent(agent).ok())
        .map(|a| a.title)
        .unwrap_or_else(|| agent.to_string());
    let now = Local::now().timestamp();
    let id = run_id(app);
    let _ = update(root, |cfg| {
        cfg.runs.insert(
            0,
            AgentRun {
                id,
                agent: agent.into(),
                title,
                started: now,
                finished: Some(now),
                late: false,
                trigger: Some(match cause {
                    RunCause::Event { trigger, .. } => trigger.clone(),
                    other => other.label(),
                }),
                trigger_path: cause.path().map(str::to_string),
                chain_id: cause.chain().map(|c| c.id.clone()),
                chain_depth: cause.chain().map(|c| c.depth),
                model: None,
                attempts: 0,
                status: "skipped".into(),
                answer: String::new(),
                error: Some(reason),
                proposals: 0,
                changes: Vec::new(),
                changed_paths: Vec::new(),
                proposal_ids: Vec::new(),
                transcript: RunTranscript::default(),
            },
        );
        cfg.runs.truncate(100);
    });
    let _ = app.emit("tessera-changed", ());
}

fn start_agent(
    app: &AppHandle,
    ws: &Arc<mosaic_core::Workspace>,
    name: &str,
    cause: RunCause,
) -> CmdResult<u64> {
    let agent = ws.agent(name)?;
    if let Some(error) = trigger_error(&agent) {
        return Err(Error::Invalid(error));
    }
    let tessera = app.state::<TesseraState>();
    let key = running_key(ws.vault.root(), &agent.name);
    {
        let mut running = tessera.running.lock().expect("tessera lock");
        if !running.insert(key.clone()) {
            return Err(Error::Invalid(format!(
                "{} is already running",
                agent.title
            )));
        }
    }
    let result = spawn(app, ws, agent, cause);
    if result.is_err() {
        tessera.running.lock().expect("tessera lock").remove(&key);
    }
    result
}

fn run_id(app: &AppHandle) -> u64 {
    let state = app.state::<TesseraState>();
    (Local::now().timestamp_millis() as u64) * 1_000
        + state.next.fetch_add(1, Ordering::SeqCst) % 1_000
}

fn spawn(
    app: &AppHandle,
    ws: &Arc<mosaic_core::Workspace>,
    agent: Agent,
    cause: RunCause,
) -> CmdResult<u64> {
    let claude = chat::find_claude()
        .ok_or_else(|| Error::Invalid("Claude Code isn't installed or logged in".into()))?;
    let mosaic = chat::mosaic_cli().ok_or_else(|| {
        Error::Invalid("The mosaic command wasn't found; install it in Settings › AI".into())
    })?;
    let _ = ws.mirror_agents();
    let root = ws.vault.root().to_path_buf();
    let id = run_id(app);
    update(&root, |cfg| {
        cfg.runs.insert(
            0,
            AgentRun {
                id,
                agent: agent.name.clone(),
                title: agent.title.clone(),
                started: Local::now().timestamp(),
                finished: None,
                late: cause.late(),
                trigger: Some(cause.label()),
                trigger_path: cause.path().map(str::to_string),
                chain_id: cause.chain().map(|c| c.id.clone()),
                chain_depth: cause.chain().map(|c| c.depth),
                model: agent.model.clone(),
                attempts: 1,
                status: "running".into(),
                answer: String::new(),
                error: None,
                proposals: 0,
                changes: Vec::new(),
                changed_paths: Vec::new(),
                proposal_ids: Vec::new(),
                transcript: RunTranscript::default(),
            },
        );
        cfg.runs.truncate(100);
    })?;
    let _ = app.emit("tessera-changed", ());

    let handle = app.clone();
    let key = running_key(&root, &agent.name);
    std::thread::spawn(move || {
        let completed = run_with_retry(&mut DesktopRun {
            app: &handle,
            root: &root,
            claude: &claude,
            mosaic: &mosaic,
            agent: &agent,
            cause: &cause,
            id,
        });

        let _ = update(&root, |cfg| {
            if let Some(run) = cfg.runs.iter_mut().find(|r| r.id == id) {
                completed.apply_to(run, Local::now().timestamp());
            }
        });
        handle
            .state::<TesseraState>()
            .transcripts
            .lock()
            .expect("tessera transcript lock")
            .remove(&id);
        handle
            .state::<TesseraState>()
            .running
            .lock()
            .expect("tessera lock")
            .remove(&key);
        let _ = handle.emit("tessera-changed", ());
        if let Ok(ws) = handle.state::<AppState>().get()
            && ws.vault.root() == root
        {
            drain_queue(&handle, &ws);
        }
    });
    Ok(id)
}

fn update_attempts(root: &Path, id: u64, attempts: u8) {
    let _ = update(root, |cfg| {
        if let Some(run) = cfg.runs.iter_mut().find(|r| r.id == id) {
            run.attempts = attempts;
        }
    });
}

fn launch(
    claude: &Path,
    mosaic: &Path,
    root: &Path,
    agent: &Agent,
    cause: &RunCause,
    run_id: u64,
) -> Result<Child, String> {
    let vault_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut args = vec!["--vault".to_string(), root.display().to_string()];
    for path in &agent.may_change {
        args.push("--may-change".into());
        args.push(path.clone());
    }
    if agent.may_change.is_empty() {
        args.push("--may-change".into());
        args.push("/.mosaic-no-direct-writes".into());
    }
    args.push("mcp".into());
    // The run's id lets a run this agent requests (M7b) continue this run's workflow chain.
    let env = serde_json::json!({ core::RUN_ENV: run_id.to_string() });
    let mcp = serde_json::json!({"mcpServers":{"mosaic":{"command":mosaic,"args":args,"env":env}}});
    let mut command = Command::new(claude);
    command
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
        .arg(
            system_prompt(&vault_name, None, &[], None)
                + &cause.path().map(event_prompt).unwrap_or_default(),
        )
        // The web only when the workflow opts in (`web: true`), for every trigger.
        .arg("--allowedTools")
        .args(allowed_tools(agent.web))
        .arg("--disallowedTools")
        .args(disallowed_tools(agent.web));
    if let Some(model) = agent.model.as_deref() {
        command.arg("--model").arg(model);
    }
    let mut child = command
        .current_dir(root)
        .env("PATH", chat::path_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("couldn't start Claude Code: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = mosaic_core::agents::agent_prompt(agent, cause.request().as_deref());
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("couldn't send the workflow prompt: {e}"))?;
    }
    Ok(child)
}

fn publish_transcript(app: &AppHandle, id: u64, transcript: &RunTranscript) {
    app.state::<TesseraState>()
        .transcripts
        .lock()
        .expect("tessera transcript lock")
        .insert(id, transcript.clone());
    let _ = app.emit("tessera-changed", ());
}

fn collect_child(
    app: &AppHandle,
    mut child: Child,
    cause: &RunCause,
    run_id: u64,
    transcript: &mut RunTranscript,
) -> RunOutput {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let err_tail = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let child_chain = cause.chain().map_or_else(
        || Chain {
            id: format!("run-{run_id}"),
            depth: 1,
        },
        |chain| Chain {
            id: chain.id.clone(),
            depth: chain.depth.saturating_add(1),
        },
    );
    let mut output = RunOutput::default();
    let mut published = Instant::now() - Duration::from_secs(1);
    let mut creation_tools: HashMap<String, String> = HashMap::new();
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            for event in parse_line(&line) {
                match &event {
                    ChatEvent::Tool {
                        id,
                        summary,
                        path: Some(path),
                        writes: true,
                    } if creation_summary(summary) => {
                        creation_tools.insert(id.clone(), path.clone());
                        register_origin(app, path, child_chain.clone());
                    }
                    ChatEvent::ToolDone { id, error, review }
                        if error.is_some() || review.is_some() =>
                    {
                        if let Some(path) = creation_tools.remove(id) {
                            remove_origin(app, &path, &child_chain.id);
                        }
                    }
                    _ => {}
                }
                transcript.push(event.clone());
                output.apply(event);
                if published.elapsed() >= Duration::from_millis(250) {
                    publish_transcript(app, run_id, transcript);
                    published = Instant::now();
                }
            }
        }
    }
    let status = child.wait();
    let stderr = err_tail.join().unwrap_or_default();
    if output.error.is_none() && !status.is_ok_and(|s| s.success()) {
        let tail = stderr
            .trim()
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        output.error = Some(if tail.is_empty() {
            "Claude Code exited before completing the workflow".into()
        } else {
            tail
        });
    }
    output
}

fn creation_summary(summary: &str) -> bool {
    summary.starts_with("Created ")
        || summary.starts_with("Copied ")
        || (summary.starts_with("Added ") && !summary.starts_with("Added to "))
}

fn register_origin(app: &AppHandle, path: &str, chain: Chain) {
    app.state::<TesseraState>()
        .events
        .lock()
        .expect("tessera event lock")
        .origins
        .insert(path.to_string(), chain);
}

fn remove_origin(app: &AppHandle, path: &str, chain_id: &str) {
    let state = app.state::<TesseraState>();
    let mut events = state.events.lock().expect("tessera event lock");
    if events.origins.get(path).is_some_and(|c| c.id == chain_id) {
        events.origins.remove(path);
    }
}

/// Tauri/process/storage adapter; retry and result-transition decisions live in mosaic-core.
struct DesktopRun<'a> {
    app: &'a AppHandle,
    root: &'a Path,
    claude: &'a Path,
    mosaic: &'a Path,
    agent: &'a Agent,
    cause: &'a RunCause,
    id: u64,
}

impl RunHost for DesktopRun<'_> {
    fn record_attempt(&mut self, attempt: u8) {
        update_attempts(self.root, self.id, attempt);
    }
    fn attempt(&mut self, transcript: &mut RunTranscript) -> RunOutput {
        launch(
            self.claude,
            self.mosaic,
            self.root,
            self.agent,
            self.cause,
            self.id,
        )
        .map(|child| collect_child(self.app, child, self.cause, self.id, transcript))
        .unwrap_or_else(RunOutput::failed)
    }
    fn publish(&mut self, transcript: &RunTranscript) {
        publish_transcript(self.app, self.id, transcript);
    }
    fn wait(&mut self, delay: Duration) {
        std::thread::sleep(delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mosaic_core::{Vault, Workspace, index::Index};

    /// The scheduler's state in a temporary folder for this test's thread, and another handle on
    /// it standing for a separate process (`mosaic mcp`).
    fn shared_store() -> (tempfile::TempDir, VaultState) {
        let dir = tempfile::tempdir().unwrap();
        TEST_STORE.with(|s| *s.borrow_mut() = Some(dir.path().to_path_buf()));
        let other = VaultState::in_dir(dir.path().to_path_buf()).unwrap();
        (dir, other)
    }

    fn request(agent: &str, id: u64) -> core::RunRequest {
        core::RunRequest {
            id,
            agent: agent.into(),
            requested: Local::now().timestamp(),
            parent_run: None,
            chain: core::RequestChain {
                id: format!("request-{id}"),
                depth: 1,
            },
        }
    }

    #[test]
    fn an_external_pause_holds_queued_runs_until_an_external_resume() {
        let (_dir, other) = shared_store();
        let root = Path::new("/vault");
        let tessera = TesseraState::default();
        tessera.observe_external(root);
        tessera.queue_requested(root, request("digest", 1)).unwrap();

        core::pause_all(&other, true).unwrap();
        let seen = tessera.observe_external(root);
        assert!(seen.changed && !seen.resumed);
        assert!(tessera.next_queued(root).is_none());
        let events = tessera.events.lock().unwrap();
        assert_eq!(events.queue.count(root, "digest"), 1);
        drop(events);

        core::pause_all(&other, false).unwrap();
        // The file's timestamp may not move within the same instant; force a re-read.
        tessera.control.lock().unwrap().as_mut().unwrap().2 = None;
        let seen = tessera.observe_external(root);
        assert!(seen.changed && seen.resumed);
        let job = tessera.next_queued(root).unwrap();
        assert_eq!(job.agent, "digest");
        assert_eq!(job.cause.chain().unwrap().depth, 1);
    }

    #[test]
    fn an_external_agent_pause_holds_only_that_workflow() {
        let (_dir, other) = shared_store();
        let root = Path::new("/vault");
        let tessera = TesseraState::default();
        tessera.observe_external(root);
        core::pause_agent(&other, "digest", true).unwrap();
        // A request taken while its workflow is paused waits in the queue.
        core::take_run_requests(&other).unwrap();
        other
            .update_run_requests(|list| {
                list.push(request("digest", 1));
                list.push(request("weekly", 2));
            })
            .unwrap();
        let seen = tessera.observe_external(root);
        assert!(seen.changed && seen.skipped.is_empty());
        assert_eq!(tessera.next_queued(root).unwrap().agent, "weekly");
        assert!(tessera.next_queued(root).is_none());
        assert_eq!(
            tessera.events.lock().unwrap().queue.count(root, "digest"),
            1
        );
    }

    #[test]
    fn requests_over_the_current_chain_limit_are_skipped() {
        let (_dir, other) = shared_store();
        let root = Path::new("/vault");
        // The limit was lowered after the request was made: the app checks it again.
        other.update_tessera(|cfg| cfg.max_chain_depth = 0).unwrap();
        other
            .update_run_requests(|list| list.push(request("digest", 1)))
            .unwrap();
        let tessera = TesseraState::default();
        let seen = tessera.observe_external(root);
        assert_eq!(seen.skipped.len(), 1);
        assert!(
            seen.skipped[0].2.contains("depth 1"),
            "{}",
            seen.skipped[0].2
        );
        assert!(tessera.next_queued(root).is_none());
    }

    #[test]
    fn stale_requests_are_skipped_not_run() {
        let (_dir, other) = shared_store();
        let root = Path::new("/vault");
        let mut stale = request("digest", 1);
        stale.requested -= core::REQUEST_TTL_SECS + 1;
        other.update_run_requests(|list| list.push(stale)).unwrap();
        let tessera = TesseraState::default();
        let seen = tessera.observe_external(root);
        assert_eq!(seen.skipped.len(), 1);
        assert!(tessera.next_queued(root).is_none());
    }

    #[test]
    fn creation_detection_is_precise() {
        assert!(creation_summary("Created Daily/2026-10-07"));
        assert!(creation_summary("Copied Template to Daily/2026-10-07"));
        assert!(!creation_summary("Added to Daily/2026-10-07"));
    }

    #[test]
    fn mosaic_renames_are_not_creation_events() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
        );
        ws.files.create("Daily/First.md", "# First").unwrap();
        assert!(recent_mosaic_move_source(&ws, "Daily/First.md").is_none());
        ws.files
            .rename("Daily/First.md", "Daily/Renamed.md", true)
            .unwrap();
        ws.refresh("Daily/Renamed.md").unwrap();
        assert_eq!(
            recent_mosaic_move_source(&ws, "Daily/Renamed.md"),
            Some(("Daily/First.md".into(), true))
        );

        ws.files.create("Inbox/Nested.md", "# Nested").unwrap();
        ws.files.rename("Inbox", "Archive", true).unwrap();
        ws.refresh("Archive/Nested.md").unwrap();
        assert_eq!(
            recent_mosaic_move_source(&ws, "Archive/Nested.md"),
            Some(("Inbox/Nested.md".into(), false))
        );
    }
}
