//! Tessera: manual, scheduled and event-triggered vault agents. Automatic workflows run while the
//! app is open. Results and queue/chain safety state live outside the vault.

use crate::{AppState, chat};
use chrono::{Local, TimeZone};
use mosaic_core::Error;
use mosaic_core::agents::{Agent, EventTrigger};
use mosaic_core::chat::{ALLOWED_TOOLS, ChatEvent, DISALLOWED_TOOLS, parse_line, system_prompt};
use mosaic_core::settings::{AgentRun, Settings, TesseraSettings};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
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
const MAX_QUEUE: usize = 100;
const MAX_CHAIN_RUNS: usize = 20;
const CHAIN_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Chain {
    id: String,
    depth: u8,
}

#[derive(Clone, Debug)]
enum RunCause {
    Manual,
    Schedule {
        text: String,
        late: bool,
    },
    Event {
        trigger: String,
        path: String,
        chain: Chain,
        test: bool,
    },
}

impl RunCause {
    fn label(&self) -> String {
        match self {
            Self::Manual => "Manual".into(),
            Self::Schedule { text, .. } => format!("Scheduled: {text}"),
            Self::Event {
                trigger,
                path,
                test,
                ..
            } => format!("{}{} · {path}", if *test { "Test: " } else { "" }, trigger),
        }
    }

    fn path(&self) -> Option<&str> {
        match self {
            Self::Event { path, .. } => Some(path),
            _ => None,
        }
    }

    fn chain(&self) -> Option<&Chain> {
        match self {
            Self::Event { chain, .. } => Some(chain),
            _ => None,
        }
    }

    fn late(&self) -> bool {
        matches!(self, Self::Schedule { late: true, .. })
    }

    fn request(&self) -> Option<String> {
        match self {
            Self::Event {
                trigger,
                path,
                test,
                ..
            } => Some(format!(
                "{}This workflow was triggered because `{path}` matched `{trigger}`. Read the note's latest content before acting. The triggering note is the subject of this run.",
                if *test {
                    "This is a test trigger using an existing note. "
                } else {
                    ""
                }
            )),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
struct QueuedRun {
    root: PathBuf,
    agent: String,
    cause: RunCause,
}

struct ChainState {
    seen: HashSet<String>,
    runs: usize,
    touched: Instant,
}

impl ChainState {
    fn new() -> Self {
        Self {
            seen: HashSet::new(),
            runs: 0,
            touched: Instant::now(),
        }
    }
}

#[derive(Default)]
struct EventState {
    root: PathBuf,
    known: HashSet<String>,
    queue: VecDeque<QueuedRun>,
    /// A workflow registers the chain before its create tool runs; the watcher consumes it.
    origins: HashMap<String, Chain>,
    chains: HashMap<String, ChainState>,
}

#[derive(Default)]
pub struct TesseraState {
    generation: AtomicU64,
    next: AtomicU64,
    running: Mutex<HashSet<String>>,
    events: Mutex<EventState>,
}

#[derive(Serialize)]
pub struct TesseraStatus {
    paused: bool,
    max_chain_depth: u8,
    agents: Vec<WorkflowAgent>,
    runs: Vec<AgentRun>,
}

#[derive(Serialize)]
struct WorkflowAgent {
    name: String,
    title: String,
    schedule: Option<String>,
    on: Vec<String>,
    model: Option<String>,
    paused: bool,
    running: bool,
    queued: usize,
    error: Option<String>,
}

fn save(root: &Path, value: TesseraSettings) -> CmdResult<()> {
    Settings::update(|s| {
        s.set_tessera(root, value);
        true
    })
    .map_err(|e| Error::Io {
        path: "settings.json".into(),
        source: e,
    })
}

fn running_key(root: &Path, agent: &str) -> String {
    format!("{}\0{agent}", root.display())
}

fn trigger_error(agent: &Agent) -> Option<String> {
    let mut errors = Vec::new();
    if let Some(schedule) = &agent.schedule
        && let Err(e) = mosaic_core::schedule::parse(schedule)
    {
        errors.push(e);
    }
    for event in &agent.on {
        if let Err(e) = EventTrigger::parse(event) {
            errors.push(e);
        }
    }
    (!errors.is_empty()).then(|| errors.join(" · "))
}

#[tauri::command]
pub fn tessera_status(
    state: State<AppState>,
    tessera: State<TesseraState>,
) -> CmdResult<TesseraStatus> {
    let ws = state.get()?;
    let cfg = Settings::load().tessera(ws.vault.root());
    let running = tessera.running.lock().expect("tessera lock");
    let events = tessera.events.lock().expect("tessera event lock");
    let agents = ws
        .agents()?
        .into_iter()
        .map(|a| WorkflowAgent {
            paused: cfg.paused_agents.contains(&a.name),
            running: running.contains(&running_key(ws.vault.root(), &a.name)),
            queued: events
                .queue
                .iter()
                .filter(|q| q.root == ws.vault.root() && q.agent == a.name)
                .count(),
            error: trigger_error(&a),
            name: a.name,
            title: a.title,
            schedule: a.schedule,
            on: a.on,
            model: a.model,
        })
        .collect();
    Ok(TesseraStatus {
        paused: cfg.paused,
        max_chain_depth: cfg.max_chain_depth,
        agents,
        runs: cfg.runs,
    })
}

#[tauri::command]
pub fn tessera_pause_all(app: AppHandle, state: State<AppState>, paused: bool) -> CmdResult<()> {
    let ws = state.get()?;
    let mut cfg = Settings::load().tessera(ws.vault.root());
    cfg.paused = paused;
    save(ws.vault.root(), cfg)?;
    if !paused {
        drain_queue(&app, &ws);
    }
    Ok(())
}

#[tauri::command]
pub fn tessera_pause_agent(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    paused: bool,
) -> CmdResult<()> {
    let ws = state.get()?;
    let mut cfg = Settings::load().tessera(ws.vault.root());
    cfg.paused_agents.retain(|n| n != &name);
    if paused {
        cfg.paused_agents.push(name);
    }
    save(ws.vault.root(), cfg)?;
    if !paused {
        drain_queue(&app, &ws);
    }
    Ok(())
}

#[tauri::command]
pub fn tessera_set_max_chain_depth(state: State<AppState>, depth: u8) -> CmdResult<()> {
    if depth > 10 {
        return Err(Error::Invalid(
            "workflow chain depth must be between 0 and 10".into(),
        ));
    }
    let ws = state.get()?;
    let mut cfg = Settings::load().tessera(ws.vault.root());
    cfg.max_chain_depth = depth;
    save(ws.vault.root(), cfg)
}

#[tauri::command]
pub fn tessera_run(app: AppHandle, state: State<AppState>, name: String) -> CmdResult<u64> {
    let ws = state.get()?;
    start_agent(&app, &ws, &name, RunCause::Manual)
}

#[tauri::command]
pub fn tessera_test_event(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    path: String,
) -> CmdResult<u64> {
    let ws = state.get()?;
    let agent = ws.agent(&name)?;
    ws.read(&path)?;
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
        if ws.read(&path).is_err() || moved {
            continue;
        }
        let chain = origin.unwrap_or_else(|| {
            let from_agent = ws
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
        if let Some(version) = ws.history(candidate, 3).ok().and_then(|versions| {
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
            let _ = start_agent(
                app,
                &ws,
                &agent.name,
                RunCause::Schedule {
                    text: text.clone(),
                    late: startup,
                },
            );
        }
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
    let cfg = Settings::load().tessera(ws.vault.root());
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
    let cfg = Settings::load().tessera(ws.vault.root());
    let key = format!("{agent}\0created\0{path}");
    let reason = {
        let state = app.state::<TesseraState>();
        let mut events = state.events.lock().expect("tessera event lock");
        events
            .chains
            .retain(|_, chain| chain.touched.elapsed() < CHAIN_TTL);
        let queue_full = events.queue.len() >= MAX_QUEUE;
        let guard = events
            .chains
            .entry(chain.id.clone())
            .or_insert_with(ChainState::new);
        guard.touched = Instant::now();
        if chain.depth > cfg.max_chain_depth {
            Some(format!(
                "Suppressed at workflow-chain depth {} (maximum {}).",
                chain.depth, cfg.max_chain_depth
            ))
        } else if guard.runs >= MAX_CHAIN_RUNS {
            Some(format!(
                "Suppressed after {MAX_CHAIN_RUNS} runs in the same workflow chain."
            ))
        } else if !guard.seen.insert(key) {
            Some("Suppressed a repeated workflow/event/path in the same chain.".into())
        } else if queue_full {
            Some(format!("Event queue is full ({MAX_QUEUE} runs)."))
        } else {
            guard.runs += 1;
            events.queue.push_back(QueuedRun {
                root: ws.vault.root().to_path_buf(),
                agent: agent.clone(),
                cause: RunCause::Event {
                    trigger: trigger.clone(),
                    path: path.clone(),
                    chain: chain.clone(),
                    test: false,
                },
            });
            None
        }
    };
    if let Some(reason) = reason {
        record_skipped(
            app,
            ws.vault.root(),
            &agent,
            &trigger,
            &path,
            &chain,
            reason,
        );
    } else {
        let _ = app.emit("tessera-changed", ());
    }
}

fn drain_queue(app: &AppHandle, ws: &Arc<mosaic_core::Workspace>) {
    loop {
        let cfg = Settings::load().tessera(ws.vault.root());
        if cfg.paused {
            return;
        }
        let running = app
            .state::<TesseraState>()
            .running
            .lock()
            .expect("tessera lock")
            .clone();
        let job = {
            let state = app.state::<TesseraState>();
            let mut events = state.events.lock().expect("tessera event lock");
            let position = events.queue.iter().position(|job| {
                job.root == ws.vault.root()
                    && !cfg.paused_agents.contains(&job.agent)
                    && !running.contains(&running_key(&job.root, &job.agent))
            });
            position.and_then(|i| events.queue.remove(i))
        };
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
                    .push_front(job);
                break;
            }
            if let RunCause::Event {
                trigger,
                path,
                chain,
                ..
            } = job.cause
            {
                record_skipped(
                    app,
                    ws.vault.root(),
                    &job.agent,
                    &trigger,
                    &path,
                    &chain,
                    error.to_string(),
                );
            }
        }
    }
}

fn record_skipped(
    app: &AppHandle,
    root: &Path,
    agent: &str,
    trigger: &str,
    path: &str,
    chain: &Chain,
    reason: String,
) {
    let title = app
        .state::<AppState>()
        .get()
        .ok()
        .and_then(|ws| ws.agent(agent).ok())
        .map(|a| a.title)
        .unwrap_or_else(|| agent.to_string());
    let now = Local::now().timestamp();
    let id = run_id(app);
    let mut cfg = Settings::load().tessera(root);
    cfg.runs.insert(
        0,
        AgentRun {
            id,
            agent: agent.into(),
            title,
            started: now,
            finished: Some(now),
            late: false,
            trigger: Some(trigger.into()),
            trigger_path: Some(path.into()),
            chain_id: Some(chain.id.clone()),
            chain_depth: Some(chain.depth),
            model: None,
            attempts: 0,
            status: "skipped".into(),
            answer: String::new(),
            error: Some(reason),
            proposals: 0,
            changes: Vec::new(),
            changed_paths: Vec::new(),
            proposal_ids: Vec::new(),
        },
    );
    cfg.runs.truncate(100);
    let _ = save(root, cfg);
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
    let mut cfg = Settings::load().tessera(&root);
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
        },
    );
    cfg.runs.truncate(100);
    save(&root, cfg)?;
    let _ = app.emit("tessera-changed", ());

    let handle = app.clone();
    let key = running_key(&root, &agent.name);
    std::thread::spawn(move || {
        let mut attempts = 0u8;
        let output = loop {
            attempts += 1;
            update_attempts(&root, id, attempts);
            let result = launch(&claude, &mosaic, &root, &agent, &cause)
                .map(|child| collect_child(&handle, child, &cause, id))
                .unwrap_or_else(|e| RunOutput {
                    error: Some(e),
                    ..RunOutput::default()
                });
            let retry = attempts < 3
                && result.changes.is_empty()
                && result.proposals == 0
                && result.error.as_deref().is_some_and(transient_failure);
            if !retry {
                break result;
            }
            std::thread::sleep(Duration::from_secs(u64::from(attempts)));
        };

        let mut cfg = Settings::load().tessera(&root);
        if let Some(run) = cfg.runs.iter_mut().find(|r| r.id == id) {
            run.finished = Some(Local::now().timestamp());
            run.status = if output.error.is_some() {
                "failed"
            } else {
                "done"
            }
            .into();
            run.answer = output.answer;
            run.error = output.error;
            run.proposals = output.proposals;
            run.changes = output.changes;
            run.changed_paths = output.changed_paths;
            run.proposal_ids = output.proposal_ids;
            run.attempts = attempts;
        }
        let _ = save(&root, cfg);
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
    let mut cfg = Settings::load().tessera(root);
    if let Some(run) = cfg.runs.iter_mut().find(|r| r.id == id) {
        run.attempts = attempts;
    }
    let _ = save(root, cfg);
}

fn launch(
    claude: &Path,
    mosaic: &Path,
    root: &Path,
    agent: &Agent,
    cause: &RunCause,
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
    let mcp = serde_json::json!({"mcpServers":{"mosaic":{"command":mosaic,"args":args}}});
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
        .arg(system_prompt(&vault_name, cause.path(), &[], None))
        .arg("--allowedTools")
        .args(ALLOWED_TOOLS.split(' '))
        .arg("--disallowedTools")
        .args(DISALLOWED_TOOLS.split(' '));
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

fn collect_child(app: &AppHandle, mut child: Child, cause: &RunCause, run_id: u64) -> RunOutput {
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
                output.apply(event);
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

fn transient_failure(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    [
        "couldn't start",
        "exited before completing",
        "connection",
        "temporar",
        "timed out",
        "timeout",
        "overloaded",
        "unavailable",
        "rate limit",
        "broken pipe",
    ]
    .iter()
    .any(|needle| e.contains(needle))
}

#[derive(Default)]
struct RunOutput {
    answer: String,
    error: Option<String>,
    proposals: usize,
    changes: Vec<String>,
    changed_paths: Vec<String>,
    proposal_ids: Vec<i64>,
    write_tools: HashMap<String, (String, Option<String>)>,
}

impl RunOutput {
    fn apply(&mut self, event: ChatEvent) {
        match event {
            ChatEvent::Text { text } => {
                if !self.answer.is_empty() {
                    self.answer.push('\n');
                }
                self.answer.push_str(&text);
            }
            ChatEvent::ToolDone { id, error, review } => {
                if let Some(proposal) = review {
                    self.proposals += 1;
                    if !self.proposal_ids.contains(&proposal) {
                        self.proposal_ids.push(proposal);
                    }
                }
                if let Some((summary, path)) = self.write_tools.remove(&id)
                    && error.is_none()
                {
                    self.changes.push(summary);
                    if review.is_none()
                        && let Some(path) = path
                        && !self.changed_paths.contains(&path)
                    {
                        self.changed_paths.push(path);
                    }
                }
            }
            ChatEvent::Tool {
                id,
                summary,
                path,
                writes: true,
                ..
            } => {
                self.write_tools.insert(id, (summary, path));
            }
            ChatEvent::Done { error: e, .. } => self.error = e,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mosaic_core::{Vault, Workspace, index::Index};

    #[test]
    fn run_details_distinguish_direct_changes_proposals_and_failures() {
        let mut out = RunOutput::default();
        for (id, path, error, review) in [
            ("a", "Changed.md", None, None),
            ("b", "Proposed.md", None, Some(24)),
            ("c", "Failed.md", Some("denied".to_string()), None),
        ] {
            out.apply(ChatEvent::Tool {
                id: id.into(),
                summary: format!("Edited {path}"),
                path: Some(path.into()),
                writes: true,
            });
            out.apply(ChatEvent::ToolDone {
                id: id.into(),
                error,
                review,
            });
        }
        assert_eq!(out.changed_paths, vec!["Changed.md"]);
        assert_eq!(out.proposal_ids, vec![24]);
        assert_eq!(out.proposals, 1);
        assert_eq!(out.changes.len(), 2);
        assert!(!out.changes.iter().any(|s| s.contains("Failed")));
    }

    #[test]
    fn retry_policy_is_transient_and_creation_detection_is_precise() {
        assert!(transient_failure("connection unavailable"));
        assert!(transient_failure(
            "Claude Code exited before completing the workflow"
        ));
        assert!(!transient_failure("permission denied"));
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
        ws.create("Daily/First.md", "# First").unwrap();
        assert!(recent_mosaic_move_source(&ws, "Daily/First.md").is_none());
        ws.rename("Daily/First.md", "Daily/Renamed.md", true)
            .unwrap();
        ws.refresh("Daily/Renamed.md").unwrap();
        assert_eq!(
            recent_mosaic_move_source(&ws, "Daily/Renamed.md"),
            Some(("Daily/First.md".into(), true))
        );

        ws.create("Inbox/Nested.md", "# Nested").unwrap();
        ws.rename("Inbox", "Archive", true).unwrap();
        ws.refresh("Archive/Nested.md").unwrap();
        assert_eq!(
            recent_mosaic_move_source(&ws, "Archive/Nested.md"),
            Some(("Inbox/Nested.md".into(), false))
        );
    }
}
