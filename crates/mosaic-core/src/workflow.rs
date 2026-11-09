//! Workflow policy independent of the desktop host. Time and execution effects are supplied by
//! callers; this module never starts processes, sleeps, emits Tauri events or replaces stored state.
use crate::chat::{ChatEvent, RunTranscript};
use crate::settings::{AgentRun, TesseraSettings};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_QUEUE: usize = 100;
const MAX_CHAIN_RUNS: usize = 20;
const CHAIN_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chain {
    pub id: String,
    pub depth: u8,
}

#[derive(Clone, Debug)]
pub enum RunCause {
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
    pub fn label(&self) -> String {
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

    pub fn path(&self) -> Option<&str> {
        match self {
            Self::Event { path, .. } => Some(path),
            _ => None,
        }
    }

    pub fn chain(&self) -> Option<&Chain> {
        match self {
            Self::Event { chain, .. } => Some(chain),
            _ => None,
        }
    }

    pub fn late(&self) -> bool {
        matches!(self, Self::Schedule { late: true, .. })
    }

    pub fn request(&self) -> Option<String> {
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
pub struct QueuedRun {
    pub root: PathBuf,
    pub agent: String,
    pub cause: RunCause,
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
pub struct RunOutput {
    pub answer: String,
    pub error: Option<String>,
    pub proposals: usize,
    pub changes: Vec<String>,
    pub changed_paths: Vec<String>,
    pub proposal_ids: Vec<i64>,
    write_tools: HashMap<String, (String, Option<String>)>,
}

impl RunOutput {
    pub fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::default()
        }
    }

    pub fn apply(&mut self, event: ChatEvent) {
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

/// Schedule decisions consume a previously saved check boundary and an injected local clock.
/// The host advances the boundary transactionally even while paused, so unpausing does not replay
/// occurrences missed deliberately. Invalid schedules and a first-ever check schedule no run.
pub fn scheduled_runs(
    agents: &[crate::agents::Agent],
    cfg: &TesseraSettings,
    now: chrono::DateTime<chrono::Local>,
    startup: bool,
) -> Vec<(String, RunCause)> {
    use chrono::TimeZone;
    if cfg.paused || cfg.last_checked == 0 {
        return Vec::new();
    }
    let last = chrono::Local
        .timestamp_opt(cfg.last_checked, 0)
        .single()
        .unwrap_or(now);
    agents
        .iter()
        .filter_map(|agent| {
            if cfg.paused_agents.contains(&agent.name) {
                return None;
            }
            let text = agent.schedule.as_ref()?;
            let schedule = crate::schedule::parse(text).ok()?;
            crate::schedule::due(&schedule, last, now).then(|| {
                (
                    agent.name.clone(),
                    RunCause::Schedule {
                        text: text.clone(),
                        late: startup,
                    },
                )
            })
        })
        .collect()
}

struct ChainState {
    seen: HashSet<String>,
    runs: usize,
    touched: Instant,
}

/// In-memory queue and chain safety ledger. The host holds the short mutex while invoking these
/// methods. The supplied monotonic time makes expiry deterministic without a clock dependency.
#[derive(Default)]
pub struct WorkflowQueue {
    jobs: VecDeque<QueuedRun>,
    chains: HashMap<String, ChainState>,
}

impl WorkflowQueue {
    pub fn count(&self, root: &Path, agent: &str) -> usize {
        self.jobs
            .iter()
            .filter(|j| j.root == root && j.agent == agent)
            .count()
    }

    pub fn enqueue(&mut self, job: QueuedRun, max_depth: u8, now: Instant) -> Option<String> {
        let RunCause::Event { path, chain, .. } = &job.cause else {
            return Some("Only event workflows enter the event queue.".into());
        };
        self.chains
            .retain(|_, c| now.saturating_duration_since(c.touched) < CHAIN_TTL);
        let queue_full = self.jobs.len() >= MAX_QUEUE;
        let guard = self
            .chains
            .entry(chain.id.clone())
            .or_insert_with(|| ChainState {
                seen: HashSet::new(),
                runs: 0,
                touched: now,
            });
        guard.touched = now;
        let key = format!("{}\0created\0{path}", job.agent);
        if chain.depth > max_depth {
            Some(format!(
                "Suppressed at workflow-chain depth {} (maximum {}).",
                chain.depth, max_depth
            ))
        } else if guard.runs >= MAX_CHAIN_RUNS {
            Some(format!(
                "Suppressed after {MAX_CHAIN_RUNS} runs in the same workflow chain."
            ))
        } else if !guard.seen.insert(key) {
            Some("Suppressed a repeated workflow/event/path in the same chain.".into())
        } else if queue_full {
            // Preserve the existing semantics: even a queue-full event consumes its dedup key.
            Some(format!("Event queue is full ({MAX_QUEUE} runs)."))
        } else {
            guard.runs += 1;
            self.jobs.push_back(job);
            None
        }
    }

    /// Paused/busy jobs remain queued; the oldest eligible job can proceed without blocking others.
    pub fn next(
        &mut self,
        root: &Path,
        cfg: &TesseraSettings,
        running: impl Fn(&Path, &str) -> bool,
    ) -> Option<QueuedRun> {
        if cfg.paused {
            return None;
        }
        let position = self.jobs.iter().position(|job| {
            job.root == root
                && !cfg.paused_agents.contains(&job.agent)
                && !running(&job.root, &job.agent)
        });
        position.and_then(|i| self.jobs.remove(i))
    }

    /// Put back a job when another drain wins the host's atomic running reservation.
    pub fn requeue(&mut self, job: QueuedRun) {
        self.jobs.push_front(job);
    }
}

/// Concrete effects used by retry orchestration. A desktop adapter supplies process execution,
/// transactional attempt persistence, transcript events and delay; tests supply a deterministic fake.
/// Stream-level progress may be published by `attempt` as well as at the end of each attempt.
pub trait RunHost {
    fn record_attempt(&mut self, attempt: u8);
    fn attempt(&mut self, transcript: &mut RunTranscript) -> RunOutput;
    fn publish(&mut self, transcript: &RunTranscript);
    fn wait(&mut self, delay: Duration);
}

pub struct CompletedRun {
    pub output: RunOutput,
    pub attempts: u8,
    pub transcript: RunTranscript,
}

impl CompletedRun {
    /// Apply to the one run located by the host inside its read-modify-write transaction. Never
    /// replaces the ledger, so concurrent completions and user settings survive.
    pub fn apply_to(self, run: &mut AgentRun, finished: i64) {
        run.finished = Some(finished);
        run.status = if self.output.error.is_some() {
            "failed"
        } else {
            "done"
        }
        .into();
        run.answer = self.output.answer;
        run.error = self.output.error;
        run.proposals = self.output.proposals;
        run.changes = self.output.changes;
        run.changed_paths = self.output.changed_paths;
        run.proposal_ids = self.output.proposal_ids;
        run.attempts = self.attempts;
        run.transcript = self.transcript;
    }
}

pub fn retry_delay(attempt: u8, output: &RunOutput) -> Option<Duration> {
    (attempt < 3
        && output.changes.is_empty()
        && output.proposals == 0
        && output.error.as_deref().is_some_and(transient_failure))
    .then(|| Duration::from_secs(u64::from(attempt)))
}

pub fn run_with_retry(host: &mut impl RunHost) -> CompletedRun {
    let mut transcript = RunTranscript::default();
    for attempt in 1..=3 {
        if attempt > 1 {
            transcript.push(ChatEvent::Text {
                text: format!("*Retrying · attempt {attempt} of 3*"),
            });
        }
        host.record_attempt(attempt);
        let output = host.attempt(&mut transcript);
        if let Some(error) = &output.error
            && !matches!(transcript.events.last(), Some(ChatEvent::Done { error: Some(e), .. }) if e == error)
        {
            transcript.push(ChatEvent::Done {
                session_id: None,
                cost_usd: None,
                error: Some(error.clone()),
            });
        }
        host.publish(&transcript);
        match retry_delay(attempt, &output) {
            Some(delay) => host.wait(delay),
            None => {
                return CompletedRun {
                    output,
                    attempts: attempt,
                    transcript,
                };
            }
        }
    }
    unreachable!("third attempt never retries")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn run_cause_preserves_the_trigger_subject_and_chain() {
        let manual = RunCause::Manual;
        assert_eq!(manual.label(), "Manual");
        assert!(manual.path().is_none());
        assert!(manual.chain().is_none());
        assert!(manual.request().is_none());
        assert!(!manual.late());

        let schedule = RunCause::Schedule {
            text: "daily 08:00".into(),
            late: true,
        };
        assert_eq!(schedule.label(), "Scheduled: daily 08:00");
        assert!(schedule.late());
        assert!(schedule.path().is_none());
        assert!(schedule.chain().is_none());
        assert!(schedule.request().is_none());

        let chain = Chain {
            id: "root-run".into(),
            depth: 2,
        };
        for test in [false, true] {
            let event = RunCause::Event {
                trigger: "created in Inbox/".into(),
                path: "Inbox/Subject.md".into(),
                chain: chain.clone(),
                test,
            };
            assert_eq!(event.path(), Some("Inbox/Subject.md"));
            assert_eq!(event.chain(), Some(&chain));
            assert!(!event.late());
            assert_eq!(
                event.label(),
                format!(
                    "{}created in Inbox/ · Inbox/Subject.md",
                    if test { "Test: " } else { "" }
                )
            );
            let request = event.request().unwrap();
            assert!(request.contains("`Inbox/Subject.md` matched `created in Inbox/`"));
            assert!(request.contains("triggering note is the subject"));
            assert_eq!(request.contains("This is a test trigger"), test);
        }
    }

    #[test]
    fn run_output_keeps_answer_chunks_and_terminal_errors_without_claiming_reads_as_changes() {
        let mut out = RunOutput::default();
        out.apply(ChatEvent::Started {
            session_id: "session".into(),
            mosaic: true,
        });
        for text in ["Read the task history.", "Here is the summary."] {
            out.apply(ChatEvent::Text { text: text.into() });
        }
        out.apply(ChatEvent::Tool {
            id: "read".into(),
            summary: "Read Daily".into(),
            path: Some("Daily.md".into()),
            writes: false,
        });
        out.apply(ChatEvent::ToolDone {
            id: "read".into(),
            error: None,
            review: None,
        });
        out.apply(ChatEvent::Done {
            session_id: Some("session".into()),
            cost_usd: Some(0.01),
            error: Some("Connection interrupted".into()),
        });
        assert_eq!(out.answer, "Read the task history.\nHere is the summary.");
        assert_eq!(out.error.as_deref(), Some("Connection interrupted"));
        assert!(out.changes.is_empty());
        assert!(out.changed_paths.is_empty());
        assert!(out.proposal_ids.is_empty());
    }

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

    fn event(agent: &str, path: &str, chain: &str, depth: u8) -> QueuedRun {
        QueuedRun {
            root: "/vault".into(),
            agent: agent.into(),
            cause: RunCause::Event {
                trigger: "created in Inbox/".into(),
                path: path.into(),
                chain: Chain {
                    id: chain.into(),
                    depth,
                },
                test: false,
            },
        }
    }

    #[test]
    fn paused_busy_and_other_vault_jobs_remain_in_order() {
        let now = Instant::now();
        let mut q = WorkflowQueue::default();
        for name in ["paused", "busy", "ready"] {
            assert!(
                q.enqueue(event(name, "Inbox/a", "chain", 1), 3, now)
                    .is_none()
            );
        }
        let mut cfg = TesseraSettings {
            paused: true,
            ..TesseraSettings::default()
        };
        assert!(q.next(Path::new("/vault"), &cfg, |_, _| false).is_none());
        cfg.paused = false;
        cfg.paused_agents.push("paused".into());
        assert!(q.next(Path::new("/other"), &cfg, |_, _| false).is_none());
        let ready = q
            .next(Path::new("/vault"), &cfg, |_, agent| agent == "busy")
            .unwrap();
        assert_eq!(ready.agent, "ready");
        q.requeue(ready);
        assert_eq!(
            q.next(Path::new("/vault"), &cfg, |_, _| false)
                .unwrap()
                .agent,
            "ready"
        );
        cfg.paused_agents.clear();
        assert_eq!(
            q.next(Path::new("/vault"), &cfg, |_, _| false)
                .unwrap()
                .agent,
            "paused"
        );
        assert_eq!(
            q.next(Path::new("/vault"), &cfg, |_, _| false)
                .unwrap()
                .agent,
            "busy"
        );
    }

    #[test]
    fn chain_depth_duplicates_limit_and_expiry_use_supplied_time() {
        let now = Instant::now();
        let mut q = WorkflowQueue::default();
        assert!(
            q.enqueue(event("a", "Inbox/a", "c", 4), 3, now)
                .unwrap()
                .contains("depth 4")
        );
        for n in 0..20 {
            assert!(
                q.enqueue(event("a", &format!("Inbox/{n}"), "c", 3), 3, now)
                    .is_none()
            );
            if n == 0 {
                assert!(
                    q.enqueue(event("a", "Inbox/0", "c", 3), 3, now)
                        .unwrap()
                        .contains("repeated")
                );
            }
        }
        assert!(
            q.enqueue(event("a", "Inbox/21", "c", 3), 3, now)
                .unwrap()
                .contains("20 runs")
        );
        // The existing boundary is strict: at exactly TTL, the ledger expires.
        assert!(
            q.enqueue(event("a", "Inbox/0", "c", 3), 3, now + CHAIN_TTL)
                .is_none()
        );
    }

    #[test]
    fn queue_limit_and_rejected_event_dedup_are_preserved() {
        let now = Instant::now();
        let mut q = WorkflowQueue::default();
        for n in 0..100 {
            assert!(
                q.enqueue(event("a", "Inbox/a", &format!("c{n}"), 0), 3, now)
                    .is_none()
            );
        }
        assert!(
            q.enqueue(event("a", "Inbox/b", "full", 0), 3, now)
                .unwrap()
                .contains("queue is full")
        );
        q.next(Path::new("/vault"), &TesseraSettings::default(), |_, _| {
            false
        })
        .unwrap();
        assert!(
            q.enqueue(event("a", "Inbox/b", "full", 0), 3, now)
                .unwrap()
                .contains("repeated")
        );
        assert_eq!(q.count(Path::new("/vault"), "a"), 99);
    }

    #[derive(Default)]
    struct FakeHost {
        outputs: VecDeque<RunOutput>,
        calls: Vec<String>,
        published: Vec<RunTranscript>,
    }
    impl RunHost for FakeHost {
        fn record_attempt(&mut self, attempt: u8) {
            self.calls.push(format!("store:{attempt}"));
        }
        fn attempt(&mut self, _: &mut RunTranscript) -> RunOutput {
            self.calls.push("process".into());
            self.outputs.pop_front().expect("unexpected attempt")
        }
        fn publish(&mut self, transcript: &RunTranscript) {
            self.calls.push("event".into());
            self.published.push(transcript.clone());
        }
        fn wait(&mut self, delay: Duration) {
            self.calls.push(format!("wait:{}", delay.as_secs()));
        }
    }

    #[test]
    fn retry_orchestration_records_attempts_then_process_then_events_and_bounded_delays() {
        let mut host = FakeHost {
            outputs: VecDeque::from([
                RunOutput::failed("connection interrupted".into()),
                RunOutput::failed("temporarily unavailable".into()),
                RunOutput {
                    answer: "done".into(),
                    ..RunOutput::default()
                },
            ]),
            ..FakeHost::default()
        };
        let result = run_with_retry(&mut host);
        assert_eq!(result.attempts, 3);
        assert_eq!(result.output.answer, "done");
        assert_eq!(
            host.calls,
            [
                "store:1", "process", "event", "wait:1", "store:2", "process", "event", "wait:2",
                "store:3", "process", "event"
            ]
        );
        assert_eq!(host.published.len(), 3);
        assert!(host.outputs.is_empty());
        assert!(
            result.transcript.events.iter().any(
                |e| matches!(e, ChatEvent::Text {text} if text == "*Retrying · attempt 3 of 3*")
            )
        );
    }

    #[test]
    fn retries_stop_on_side_effects_permanent_errors_or_third_failure() {
        for output in [
            RunOutput {
                changes: vec!["Edited note".into()],
                error: Some("timeout".into()),
                ..RunOutput::default()
            },
            RunOutput {
                proposals: 1,
                error: Some("timeout".into()),
                ..RunOutput::default()
            },
            RunOutput::failed("permission denied".into()),
            RunOutput::default(),
        ] {
            let mut host = FakeHost {
                outputs: VecDeque::from([output]),
                ..FakeHost::default()
            };
            assert_eq!(run_with_retry(&mut host).attempts, 1);
            assert_eq!(host.calls, ["store:1", "process", "event"]);
        }
        let mut host = FakeHost {
            outputs: (0..3)
                .map(|_| RunOutput::failed("timeout".into()))
                .collect(),
            ..FakeHost::default()
        };
        assert_eq!(run_with_retry(&mut host).attempts, 3);
        assert_eq!(
            host.calls.iter().filter(|c| c.starts_with("wait")).count(),
            2
        );
    }
    #[test]
    fn schedule_uses_injected_clock_first_check_and_pause_boundaries() {
        use chrono::{Local, TimeZone};
        let now = Local
            .with_ymd_and_hms(2026, 10, 7, 8, 1, 0)
            .single()
            .unwrap();
        let agent = crate::agents::Agent {
            name: "daily".into(),
            title: "Daily".into(),
            description: String::new(),
            path: "Agents/Daily.md".into(),
            skill_folder: false,
            schedule: Some("daily 08:00".into()),
            on: vec![],
            model: None,
            may_change: vec![],
            web: false,
            instructions: String::new(),
        };
        let agents = [agent];
        let mut cfg = TesseraSettings::default();
        assert!(scheduled_runs(&agents, &cfg, now, true).is_empty());
        cfg.last_checked = now.timestamp() - 120;
        let runs = scheduled_runs(&agents, &cfg, now, true);
        assert_eq!(runs.len(), 1);
        assert!(runs[0].1.late());
        cfg.paused = true;
        assert!(scheduled_runs(&agents, &cfg, now, false).is_empty());
        cfg.paused = false;
        cfg.paused_agents.push("daily".into());
        assert!(scheduled_runs(&agents, &cfg, now, false).is_empty());
        cfg.paused_agents.clear();
        cfg.last_checked = now.timestamp();
        assert!(scheduled_runs(&agents, &cfg, now, false).is_empty());
    }

    #[test]
    fn completion_changes_one_run_and_preserves_its_identity_and_cause() {
        let mut run: AgentRun = serde_json::from_value(serde_json::json!({
            "id":42,"agent":"daily","title":"Daily","started":100,"finished":null,
            "late":true,"trigger":"Scheduled: daily 08:00","status":"running",
            "answer":"","error":null,"proposals":0
        }))
        .unwrap();
        let mut host = FakeHost {
            outputs: VecDeque::from([RunOutput::failed("permission denied".into())]),
            ..FakeHost::default()
        };
        run_with_retry(&mut host).apply_to(&mut run, 200);
        assert_eq!(run.id, 42);
        assert_eq!(run.started, 100);
        assert_eq!(run.finished, Some(200));
        assert_eq!(run.status, "failed");
        assert_eq!(run.attempts, 1);
        assert!(run.late);
        assert_eq!(run.trigger.as_deref(), Some("Scheduled: daily 08:00"));
        assert_eq!(run.error.as_deref(), Some("permission denied"));
    }
}
