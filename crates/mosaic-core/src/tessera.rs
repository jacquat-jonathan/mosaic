//! Tessera control shared by the app and other processes (`mosaic mcp`): scheduler status, pausing,
//! and run requests. The scheduler itself runs inside the app; everything here is stored in the
//! vault's state folder (`vault_state`) under its cross-process lock, so another process reads and
//! changes the same state the app acts on.
//!
//! - Pauses are written straight to `tessera-state.json`. The app re-reads them before every
//!   scheduled, event or queued run, and notices a resume within its poll (`POLL`).
//! - A run another process wants goes into `tessera-requests.json`. The app takes the requests on its
//!   poll and queues them like agent-created events: they wait while paused, and the chain-depth
//!   limit applies to them.
//! - The chain-depth limit has no setter here on purpose: only the app changes it.

use crate::Workspace;
use crate::agents::{Agent, EventTrigger};
use crate::chat::RunTranscript;
use crate::error::{Error, Result};
use crate::settings::{AgentRun, TesseraSettings};
use crate::vault_state::VaultState;
use crate::workflow::Chain;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// How often the app checks for pauses and run requests from other processes.
pub const POLL: Duration = Duration::from_secs(2);
/// Pending requests the app hasn't picked up; more are refused rather than piling up.
pub const MAX_REQUESTS: usize = 20;
/// A request the app hasn't picked up within this long (it was closed, or on another vault) is
/// dropped as skipped rather than run at a surprising time later.
pub const REQUEST_TTL_SECS: i64 = 10 * 60;
/// The app's scheduler rewrites `last_checked` every 30 s; older than this, it isn't running.
const SCHEDULER_STALE_SECS: i64 = 90;
/// Set by the app on the `mosaic mcp` server of each workflow run: that run's id, so a run it
/// requests continues the run's chain. The agent can't change it (it has no shell).
pub const RUN_ENV: &str = "MOSAIC_TESSERA_RUN";

#[derive(Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TesseraStatus {
    pub paused: bool,
    pub max_chain_depth: u8,
    pub agents: Vec<WorkflowAgent>,
    pub runs: Vec<AgentRun>,
}

#[derive(Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct WorkflowAgent {
    pub name: String,
    pub title: String,
    pub schedule: Option<String>,
    pub on: Vec<String>,
    pub model: Option<String>,
    pub paused: bool,
    pub running: bool,
    pub queued: usize,
    pub error: Option<String>,
}

/// A run asked for by another process, waiting for the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunRequest {
    pub id: u64,
    /// The workflow's name.
    pub agent: String,
    /// Unix seconds.
    pub requested: i64,
    /// The workflow run whose agent asked (`RUN_ENV`), if any.
    pub parent_run: Option<u64>,
    /// Worked out when the request was made, from the parent run.
    pub chain: RequestChain,
}

impl RunRequest {
    pub fn expired(&self, now: i64) -> bool {
        now.saturating_sub(self.requested) > REQUEST_TTL_SECS
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestChain {
    pub id: String,
    pub depth: u8,
}

impl From<RequestChain> for Chain {
    fn from(c: RequestChain) -> Self {
        Chain {
            id: c.id,
            depth: c.depth,
        }
    }
}

/// What makes a workflow's triggers unusable, if anything.
pub fn trigger_error(agent: &Agent) -> Option<String> {
    let mut errors = Vec::new();
    if let Some(schedule) = &agent.schedule
        && let Err(e) = crate::schedule::parse(schedule)
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

/// The scheduler's status. `running` and `queued` answer per workflow name: the app passes its live
/// state, another process `stored_status`.
pub fn status(
    ws: &Workspace,
    cfg: TesseraSettings,
    running: impl Fn(&str) -> bool,
    queued: impl Fn(&str) -> usize,
) -> Result<TesseraStatus> {
    let agents = ws
        .agents()?
        .into_iter()
        .map(|a| WorkflowAgent {
            paused: cfg.paused_agents.contains(&a.name),
            running: running(&a.name),
            queued: queued(&a.name),
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

/// The status as another process sees it: running from the run records, queued from the requests
/// the app hasn't taken yet (its in-memory event queue isn't visible). A run the app was killed
/// during stays "running" in the records; `scheduler_active` tells whether the app is there.
pub fn stored_status(ws: &Workspace, state: &VaultState) -> Result<TesseraStatus> {
    let cfg = state.tessera()?;
    let requests = state.run_requests()?;
    let running: Vec<String> = cfg
        .runs
        .iter()
        .filter(|r| r.status == "running" && r.finished.is_none())
        .map(|r| r.agent.clone())
        .collect();
    let mut queued = HashMap::<String, usize>::new();
    for r in &requests {
        *queued.entry(r.agent.clone()).or_default() += 1;
    }
    status(
        ws,
        cfg,
        |name| running.iter().any(|a| a == name),
        |name| queued.get(name).copied().unwrap_or(0),
    )
}

/// Whether the app's scheduler checked in recently (its 30 s tick rewrites `last_checked`).
pub fn scheduler_active(cfg: &TesseraSettings, now: i64) -> bool {
    cfg.last_checked > 0 && now.saturating_sub(cfg.last_checked) <= SCHEDULER_STALE_SECS
}

/// Pause or resume every workflow.
pub fn pause_all(state: &VaultState, paused: bool) -> Result<()> {
    state.update_tessera(|cfg| cfg.paused = paused)
}

/// Pause or resume one workflow, by name.
pub fn pause_agent(state: &VaultState, name: &str, paused: bool) -> Result<()> {
    state.update_tessera(|cfg| {
        cfg.paused_agents.retain(|n| n != name);
        if paused {
            cfg.paused_agents.push(name.to_string());
        }
    })
}

/// The chain a requested run joins. From inside a workflow run it continues that run's chain one
/// step deeper (as a note the run creates would); otherwise it starts a chain at depth 1, so a
/// requested run always counts as a chained run.
pub fn requested_chain(
    cfg: &TesseraSettings,
    parent_run: Option<u64>,
    request: u64,
) -> Result<RequestChain> {
    let Some(parent) = parent_run else {
        return Ok(RequestChain {
            id: format!("request-{request}"),
            depth: 1,
        });
    };
    let run = cfg
        .runs
        .iter()
        .find(|r| r.id == parent)
        .ok_or_else(|| Error::Invalid(format!("workflow run {parent} isn't known")))?;
    Ok(RequestChain {
        id: run
            .chain_id
            .clone()
            .unwrap_or_else(|| format!("run-{parent}")),
        depth: run.chain_depth.unwrap_or(0).saturating_add(1),
    })
}

/// Ask the app to run workflow `name`. Returns the request id; the run starts once the app picks it
/// up (within `POLL` while it is open), unless everything or this workflow is paused, in which case
/// it waits. Refused when the run would go past the chain-depth limit.
pub fn request_run(
    ws: &Workspace,
    state: &VaultState,
    name: &str,
    parent_run: Option<u64>,
    now_ms: i64,
) -> Result<u64> {
    let agent = ws.agent(name)?;
    if let Some(error) = trigger_error(&agent) {
        return Err(Error::Invalid(error));
    }
    let cfg = state.tessera()?;
    state.update_run_requests(|pending| {
        if pending.len() >= MAX_REQUESTS {
            return Err(Error::Invalid(format!(
                "{MAX_REQUESTS} workflow runs are already waiting for Mosaic"
            )));
        }
        let base = u64::try_from(now_ms).unwrap_or(0).saturating_mul(1_000);
        let id = pending
            .iter()
            .map(|r| r.id + 1)
            .max()
            .unwrap_or(0)
            .max(base);
        let chain = requested_chain(&cfg, parent_run, id)?;
        if chain.depth > cfg.max_chain_depth {
            return Err(Error::Invalid(format!(
                "This run would be at workflow-chain depth {} (maximum {}).",
                chain.depth, cfg.max_chain_depth
            )));
        }
        pending.push(RunRequest {
            id,
            agent: agent.name.clone(),
            requested: now_ms / 1_000,
            parent_run,
            chain,
        });
        Ok(id)
    })?
}

/// Take every pending request (the app).
pub fn take_run_requests(state: &VaultState) -> Result<Vec<RunRequest>> {
    state.update_run_requests(std::mem::take)
}

/// The parent run id from `RUN_ENV`, for a `mosaic mcp` server started by a workflow run.
pub fn parent_run_from_env() -> Option<u64> {
    std::env::var(RUN_ENV).ok()?.trim().parse().ok()
}

/// What another process can change and the app must react to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Control {
    pub paused: bool,
    pub paused_agents: Vec<String>,
}

impl Control {
    pub fn of(cfg: &TesseraSettings) -> Self {
        let mut paused_agents = cfg.paused_agents.clone();
        paused_agents.sort();
        paused_agents.dedup();
        Self {
            paused: cfg.paused,
            paused_agents,
        }
    }

    /// Whether going from `self` to `next` let anything run that couldn't before.
    pub fn resumed(&self, next: &Control) -> bool {
        (self.paused && !next.paused)
            || self
                .paused_agents
                .iter()
                .any(|name| !next.paused_agents.contains(name))
    }
}

/// Live transcripts the app holds replace the stored ones of runs still in progress.
pub fn with_transcripts(
    mut cfg: TesseraSettings,
    live: impl Fn(u64) -> Option<RunTranscript>,
) -> TesseraSettings {
    for run in &mut cfg.runs {
        if let Some(t) = live(run.id) {
            run.transcript = t;
        }
    }
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{QueuedRun, RunCause, WorkflowQueue};
    use crate::{Vault, index::Index};
    use std::time::Instant;

    struct Fixture {
        _vault: tempfile::TempDir,
        _state: tempfile::TempDir,
        ws: Workspace,
        state: VaultState,
    }

    fn fixture() -> Fixture {
        let vault = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            Vault::open(vault.path()).unwrap(),
            Index::in_memory().unwrap(),
        );
        let folder = ws.vault_preferences().unwrap().agents_folder;
        ws.files
            .create(
                &format!("{folder}/digest.md"),
                "---\ntitle: Digest\non: [created in Inbox/]\n---\nSummarize.",
            )
            .unwrap();
        ws.files
            .create(
                &format!("{folder}/broken.md"),
                "---\ntitle: Broken\nschedule: whenever\n---\nNope.",
            )
            .unwrap();
        let state = VaultState::in_dir(dir.path().into()).unwrap();
        Fixture {
            _vault: vault,
            _state: dir,
            ws,
            state,
        }
    }

    fn run(id: u64, chain: Option<(&str, u8)>) -> AgentRun {
        serde_json::from_value(serde_json::json!({
            "id": id, "agent": "digest", "title": "Digest", "started": 1,
            "finished": null, "late": false, "status": "running", "answer": "",
            "error": null, "proposals": 0,
            "chain_id": chain.map(|c| c.0), "chain_depth": chain.map(|c| c.1),
        }))
        .unwrap()
    }

    #[test]
    fn pauses_are_shared_state() {
        let f = fixture();
        pause_all(&f.state, true).unwrap();
        pause_agent(&f.state, "digest", true).unwrap();
        pause_agent(&f.state, "digest", true).unwrap();
        // Another handle on the same folder, as another process would open it.
        let other = VaultState::in_dir(f._state.path().into()).unwrap();
        let cfg = other.tessera().unwrap();
        assert!(cfg.paused);
        assert_eq!(cfg.paused_agents, vec!["digest"]);
        pause_all(&other, false).unwrap();
        pause_agent(&other, "digest", false).unwrap();
        let cfg = f.state.tessera().unwrap();
        assert!(!cfg.paused);
        assert!(cfg.paused_agents.is_empty());
    }

    #[test]
    fn control_reports_resumes_only() {
        let paused = Control {
            paused: true,
            paused_agents: vec!["a".into()],
        };
        let all_resumed = Control {
            paused: false,
            paused_agents: vec!["a".into()],
        };
        assert!(paused.resumed(&all_resumed));
        assert!(!all_resumed.resumed(&paused));
        assert!(all_resumed.resumed(&Control::default()));
        assert!(!Control::default().resumed(&all_resumed));
    }

    #[test]
    fn requests_are_queued_and_taken_once() {
        let f = fixture();
        let a = request_run(&f.ws, &f.state, "digest", None, 5_000).unwrap();
        let b = request_run(&f.ws, &f.state, "Digest", None, 5_000).unwrap();
        assert_ne!(a, b);
        let other = VaultState::in_dir(f._state.path().into()).unwrap();
        let taken = take_run_requests(&other).unwrap();
        assert_eq!(taken.len(), 2);
        assert_eq!(taken[0].agent, "digest");
        assert_eq!(taken[0].requested, 5);
        assert_eq!(
            taken[0].chain,
            RequestChain {
                id: format!("request-{a}"),
                depth: 1
            }
        );
        assert!(take_run_requests(&f.state).unwrap().is_empty());
        assert!(!taken[0].expired(5 + REQUEST_TTL_SECS));
        assert!(taken[0].expired(6 + REQUEST_TTL_SECS));
    }

    #[test]
    fn requests_refuse_unknown_or_broken_workflows() {
        let f = fixture();
        assert!(request_run(&f.ws, &f.state, "nobody", None, 1).is_err());
        assert!(request_run(&f.ws, &f.state, "broken", None, 1).is_err());
        assert!(f.state.run_requests().unwrap().is_empty());
    }

    #[test]
    fn requested_runs_continue_the_parent_chain_and_respect_the_limit() {
        let f = fixture();
        f.state
            .update_tessera(|cfg| {
                cfg.max_chain_depth = 2;
                cfg.runs = vec![
                    run(7, None),
                    run(8, Some(("event-1", 1))),
                    run(9, Some(("event-1", 2))),
                ];
            })
            .unwrap();
        // A manual run (no chain) is depth 0: its request is depth 1 in the run's own chain.
        request_run(&f.ws, &f.state, "digest", Some(7), 1).unwrap();
        request_run(&f.ws, &f.state, "digest", Some(8), 1).unwrap();
        let chains: Vec<_> = f
            .state
            .run_requests()
            .unwrap()
            .into_iter()
            .map(|r| (r.chain.id, r.chain.depth))
            .collect();
        assert_eq!(chains, vec![("run-7".into(), 1), ("event-1".into(), 2)]);
        // Depth 3 > maximum 2.
        let error = request_run(&f.ws, &f.state, "digest", Some(9), 1).unwrap_err();
        assert!(error.to_string().contains("depth 3"), "{error}");
        // An unknown parent is refused, never treated as a fresh chain.
        assert!(request_run(&f.ws, &f.state, "digest", Some(404), 1).is_err());
        // With the limit at 0 nothing can be requested at all.
        f.state
            .update_tessera(|cfg| cfg.max_chain_depth = 0)
            .unwrap();
        assert!(request_run(&f.ws, &f.state, "digest", None, 1).is_err());
        assert_eq!(f.state.run_requests().unwrap().len(), 2);
    }

    #[test]
    fn pending_requests_are_bounded() {
        let f = fixture();
        for _ in 0..MAX_REQUESTS {
            request_run(&f.ws, &f.state, "digest", None, 1).unwrap();
        }
        assert!(request_run(&f.ws, &f.state, "digest", None, 1).is_err());
        take_run_requests(&f.state).unwrap();
        assert!(request_run(&f.ws, &f.state, "digest", None, 1).is_ok());
    }

    #[test]
    fn concurrent_requests_all_land() {
        let f = fixture();
        let dir = f._state.path().to_path_buf();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let dir = dir.clone();
                let ws = &f.ws;
                scope.spawn(move || {
                    let state = VaultState::in_dir(dir).unwrap();
                    request_run(ws, &state, "digest", None, 1).unwrap();
                });
            }
        });
        let ids: std::collections::HashSet<_> = take_run_requests(&f.state)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids.len(), 8);
    }

    #[test]
    fn requested_runs_enter_the_queue_under_the_chain_limit() {
        let mut queue = WorkflowQueue::default();
        let job = |depth| QueuedRun {
            root: "/v".into(),
            agent: "digest".into(),
            cause: RunCause::Requested {
                chain: Chain {
                    id: format!("c{depth}"),
                    depth,
                },
                request: 1,
            },
        };
        let now = Instant::now();
        assert!(queue.enqueue(job(1), 1, now).is_none());
        assert!(queue.enqueue(job(2), 1, now).unwrap().contains("depth 2"));
        // The same workflow requested twice in one chain runs once.
        assert!(queue.enqueue(job(1), 1, now).unwrap().contains("repeated"));
        assert_eq!(queue.count(std::path::Path::new("/v"), "digest"), 1);
        let paused = TesseraSettings {
            paused: true,
            ..Default::default()
        };
        assert!(
            queue
                .next(std::path::Path::new("/v"), &paused, |_, _| false)
                .is_none()
        );
        let next = queue
            .next(
                std::path::Path::new("/v"),
                &TesseraSettings::default(),
                |_, _| false,
            )
            .unwrap();
        assert_eq!(next.cause.label(), "Requested");
        assert_eq!(next.cause.chain().unwrap().depth, 1);
    }

    #[test]
    fn stored_status_reads_state_and_requests() {
        let f = fixture();
        f.state
            .update_tessera(|cfg| {
                cfg.paused_agents = vec!["digest".into()];
                cfg.runs = vec![run(1, None)];
            })
            .unwrap();
        request_run(&f.ws, &f.state, "digest", None, 1).unwrap();
        let status = stored_status(&f.ws, &f.state).unwrap();
        assert!(!status.paused);
        assert_eq!(status.max_chain_depth, 3);
        let digest = status.agents.iter().find(|a| a.name == "digest").unwrap();
        assert!(digest.paused && digest.running);
        assert_eq!(digest.queued, 1);
        let broken = status.agents.iter().find(|a| a.name == "broken").unwrap();
        assert!(broken.error.is_some() && !broken.running);
        assert_eq!(status.runs.len(), 1);
    }

    #[test]
    fn scheduler_activity_follows_the_last_check() {
        let cfg = |last_checked| TesseraSettings {
            last_checked,
            ..Default::default()
        };
        assert!(!scheduler_active(&cfg(0), 100));
        assert!(scheduler_active(&cfg(1_000), 1_060));
        assert!(!scheduler_active(&cfg(1_000), 1_200));
    }
}
