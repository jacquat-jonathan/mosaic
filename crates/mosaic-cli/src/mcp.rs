//! MCP server over stdio: one typed tool per core operation. Tool errors are returned as tool results
//! (`is_error`) with a stable code, so the model can recover (e.g. re-read after a `conflict`).

use base64::Engine;
use mosaic_core::planner::{
    CreateEvent, CreateTask, CreateWorkSession, FutureSessionPolicy, MoveTask, PlannerEvent,
    TaskStatus, UpdateEvent, UpdateTask, UpdateWorkSession,
};
use mosaic_core::settings::Settings;
use mosaic_core::{Error, Workspace};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, GetPromptRequestParams,
    GetPromptResponse, GetPromptResult, Implementation, InitializeRequestParams, InitializeResult,
    ListPromptsResult, ListResourcesResult, PaginatedRequestParams, Prompt, PromptArgument,
    PromptMessage, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
    ResourceContents, Role, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

mod subscriptions;

type ToolResult = Result<String, String>;

/// Added to results of changes that were proposed instead of made (folders under review).
const REVIEW_NOTE: &str = "Proposed, not applied: the person reviews changes in this folder and will accept or reject it in the Mosaic app. Your later reads and edits of this file build on the proposal. Check the outcome with list_proposals.";

/// A write's result, with a note when it became a proposal.
fn written(w: mosaic_core::Written) -> ToolResult {
    if w.review.is_some() {
        let mut v = serde_json::to_value(&w).map_err(|e| e.to_string())?;
        v["note"] = REVIEW_NOTE.into();
        ok(v)
    } else {
        ok(w)
    }
}

fn ok<T: Serialize>(value: T) -> ToolResult {
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn err(e: Error) -> String {
    serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
}

#[derive(Deserialize, JsonSchema)]
struct PathArg {
    /// Vault-relative path, e.g. `Projects/Plan.md`.
    path: String,
}

#[derive(Deserialize, JsonSchema)]
struct ListArgs {
    /// Folder to list, vault-relative. Empty for the vault root.
    #[serde(default)]
    dir: String,
    /// Include everything below the folder.
    #[serde(default)]
    recursive: bool,
}

#[derive(Deserialize, JsonSchema)]
struct SearchArgs {
    /// Words to find (all must match, prefix match). Supports "exact phrase", tag:name, path:folder.
    query: String,
    /// Maximum results (default 20).
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct ProposalsArgs {
    /// Maximum proposals (default 30): pending ones first, then recent decisions.
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct IdArg {
    /// A proposal id from list_proposals.
    id: i64,
}

#[derive(Deserialize, JsonSchema)]
struct QueryArgs {
    /// The query, e.g. `tag:project status=active due<today+7 sort:due limit:20`. See the tool description.
    query: String,
}

#[derive(Deserialize, JsonSchema)]
struct DaysArgs {
    /// First day, `2026-10-01`. Default: today.
    from: Option<String>,
    /// Last day (at most 62 days after `from`). Default: `from` plus 6 days.
    to: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct CarryOverArgs {
    /// The day to carry tasks into, `2026-10-04`. Default: today.
    day: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct CreateArgs {
    /// Vault-relative path of the new file, including its extension (`.md`, `.canvas`, …).
    path: String,
    /// Full content of the new file.
    #[serde(default)]
    content: String,
}

#[derive(Deserialize, JsonSchema)]
struct SetPreferencesArgs {
    /// Only the preferences to change, e.g. `{"link_style": "markdown"}`. `folder_colors` changes
    /// only the folders it names: `{"Projects": "blue", "Old": null}` (null removes a color).
    patch: serde_json::Map<String, serde_json::Value>,
    /// The `revision` from the get_vault_preferences you read before this change.
    expected_revision: String,
}
#[derive(Deserialize, JsonSchema)]
struct TemplateRuleArg {
    /// Vault-relative folder the rule applies to (and its subfolders); "" for the whole vault.
    folder: String,
    /// The template (a .md file inside the templates folder), or null for a Blank note that stops
    /// inheriting a parent folder's template.
    template: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct SetTemplateConfigArgs {
    /// Vault-relative folder holding the templates (not the vault root).
    folder: String,
    /// Every per-folder default, replacing the current list (one rule per folder).
    rules: Vec<TemplateRuleArg>,
    /// The `revision` from the get_template_config you read before this change.
    expected_revision: String,
}
#[derive(Serialize)]
struct Starter {
    name: &'static str,
    content: &'static str,
}
#[derive(Deserialize, JsonSchema)]
struct TemplatesArgs {
    path: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct NoteArgs {
    /// Destination note path, including .md. Defaults resolve using its parent folder.
    path: String,
    /// Explicit template path inside the configured Templates folder. Omit to use folder defaults.
    template: Option<String>,
    /// Explicitly choose an empty note instead of the folder default.
    #[serde(default)]
    blank: bool,
    /// RFC3339 with timezone offset. Reuse the preview context timestamp at creation.
    timestamp: Option<String>,
    /// Source hash from render_template; a changed template is refused.
    expected_template_hash: Option<String>,
}
impl From<NoteArgs> for mosaic_core::templates::TemplateRequest {
    fn from(a: NoteArgs) -> Self {
        Self {
            path: a.path,
            template: a.template,
            blank: a.blank,
            timestamp: a.timestamp,
            expected_template_hash: a.expected_template_hash,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct EditArgs {
    path: String,
    /// The complete new content of the file.
    content: String,
    /// Hash from `read_file`; the write is refused if the file changed since (recommended).
    expected_hash: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct PatchArgs {
    path: String,
    /// Exact text to replace; must occur exactly once in the file.
    find: String,
    /// Replacement text.
    replace: String,
    /// Hash from `read_file`; the edit is refused if the file changed since.
    expected_hash: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct AppendArgs {
    path: String,
    /// Text to add at the end (a newline is inserted first if needed). Creates the file if missing.
    content: String,
}

#[derive(Deserialize, JsonSchema)]
struct RenameArgs {
    /// Current vault-relative path of the file or folder.
    from: String,
    /// New vault-relative path.
    to: String,
    /// Rewrite links in other notes to follow the move (default true).
    update_links: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct HistoryArgs {
    path: String,
    /// Maximum versions (default 20), newest first.
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct RestoreArgs {
    path: String,
    /// Version id from `file_history`.
    id: i64,
    /// Hash from `read_file`; the restore is refused if the file changed since.
    expected_hash: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct MoveArgs {
    /// Vault-relative paths of the files and folders to move.
    paths: Vec<String>,
    /// Destination folder (created if missing; "" for the vault root).
    folder: String,
}

#[derive(Deserialize, JsonSchema)]
struct ImportArgs {
    /// Vault-relative path for the new file, e.g. `Attachments/chart.png`.
    path: String,
    /// The file's bytes, base64-encoded (at most 20 MB).
    data: String,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum PlannerTaskStatusArg {
    New,
    Blocked,
    InProgress,
    InQa,
    Done,
}

impl From<PlannerTaskStatusArg> for TaskStatus {
    fn from(value: PlannerTaskStatusArg) -> Self {
        match value {
            PlannerTaskStatusArg::New => Self::New,
            PlannerTaskStatusArg::Blocked => Self::Blocked,
            PlannerTaskStatusArg::InProgress => Self::InProgress,
            PlannerTaskStatusArg::InQa => Self::InQa,
            PlannerTaskStatusArg::Done => Self::Done,
        }
    }
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum FutureSessionPolicyArg {
    Cancel,
    Keep,
}

impl From<FutureSessionPolicyArg> for FutureSessionPolicy {
    fn from(value: FutureSessionPolicyArg) -> Self {
        match value {
            FutureSessionPolicyArg::Cancel => Self::Cancel,
            FutureSessionPolicyArg::Keep => Self::Keep,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct PlannerListArgs {
    /// Include archived items (default false).
    #[serde(default)]
    include_archived: bool,
    /// Include items in Trash (default false).
    #[serde(default)]
    include_trashed: bool,
}

#[derive(Deserialize, JsonSchema)]
struct PlannerTaskIdArgs {
    /// Planner task UUID, obtained from list_planner_tasks.
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct CreatePlannerTaskArgs {
    /// Epic UUID from list_planner_epics, or null for Unassigned.
    #[serde(default)]
    epic_id: Option<String>,
    /// Parent task UUID for a subtask, or null for a top-level task.
    #[serde(default)]
    parent_id: Option<String>,
    title: String,
    #[serde(default)]
    description: String,
    /// Initial status; defaults to new. Completing an existing task uses complete_planner_task.
    #[serde(default)]
    status: Option<PlannerTaskStatusArg>,
    /// ISO date such as 2026-10-27.
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    estimate_minutes: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct UpdatePlannerTaskArgs {
    /// Planner task UUID.
    id: String,
    /// Revision returned by the latest read; stale revisions are refused.
    expected_revision: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// ISO date such as 2026-10-27. Use clear_due_date to remove it.
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    clear_due_date: bool,
    #[serde(default)]
    estimate_minutes: Option<i64>,
    #[serde(default)]
    clear_estimate: bool,
}

#[derive(Deserialize, JsonSchema)]
struct MovePlannerTaskArgs {
    /// Planner task UUID.
    id: String,
    /// Revision returned by the latest read; stale revisions are refused.
    expected_revision: i64,
    /// Complete destination epic UUID, or null for Unassigned.
    #[serde(default)]
    epic_id: Option<String>,
    /// Complete destination parent UUID, or null for a top-level task.
    #[serde(default)]
    parent_id: Option<String>,
    /// Complete destination status. Use complete_planner_task/reopen_planner_task to cross Done.
    status: PlannerTaskStatusArg,
    /// Board position. Omit to append after the other tasks in the destination group.
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct CompletePlannerTaskArgs {
    id: String,
    /// Revision returned by the latest read; stale revisions are refused.
    expected_revision: i64,
    /// Confirm completion even when subtasks remain incomplete (default false).
    #[serde(default)]
    allow_incomplete_subtasks: bool,
    /// What to do with future scheduled work sessions; defaults to cancel.
    #[serde(default)]
    future_sessions: Option<FutureSessionPolicyArg>,
}

#[derive(Deserialize, JsonSchema)]
struct PlannerTaskRevisionArgs {
    id: String,
    /// Revision returned by the latest read; stale revisions are refused.
    expected_revision: i64,
}

/// The fixed source the app's iCalendar import uses, so an agent's import and the person's see each
/// other's events as duplicates.
const ICAL_SOURCE: &str = "ics-file";

#[derive(Deserialize, JsonSchema)]
struct PlannerEventIdArgs {
    /// Event UUID, from list_planner_events or get_planner_calendar (an occurrence's series_id).
    id: String,
    /// The event's revision from the latest read (get_planner_calendar's series_revision); stale
    /// revisions are refused with code conflict.
    expected_revision: i64,
}

#[derive(Deserialize, JsonSchema)]
struct CalendarArgs {
    /// First day, YYYY-MM-DD (default today).
    #[serde(default)]
    from: Option<String>,
    /// Last day, inclusive, YYYY-MM-DD (default 6 days after `from`). At most 371 days in all.
    #[serde(default)]
    to: Option<String>,
    /// Also return every open Board task that could be scheduled (not limited to the range;
    /// default false).
    #[serde(default)]
    include_unscheduled_tasks: bool,
}

#[derive(Deserialize, JsonSchema)]
struct CreatePlannerEventArgs {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    location: String,
    /// Video-call link.
    #[serde(default)]
    meeting_url: Option<String>,
    /// Names or email addresses.
    #[serde(default)]
    participants: Vec<String>,
    /// Epic UUID from list_planner_epics; the event takes the epic's color.
    #[serde(default)]
    epic_id: Option<String>,
    /// CSS color such as #3b82f6, overriding the epic's.
    #[serde(default)]
    color: Option<String>,
    /// All-day event (default false: timed).
    #[serde(default)]
    all_day: bool,
    /// Timed: RFC 3339 with offset, e.g. 2026-11-20T09:00:00+01:00 (stored in UTC). All-day:
    /// YYYY-MM-DD.
    start_value: String,
    /// Timed: RFC 3339 with offset. All-day: YYYY-MM-DD, exclusive (a one-day event on the 20th
    /// ends on the 21st).
    end_value: String,
    /// IANA timezone the event lives in, e.g. Europe/Paris. Recurrences repeat at the same local
    /// time in it.
    timezone: String,
    /// RFC 5545 RRULE without the `RRULE:` prefix, e.g. FREQ=WEEKLY;BYDAY=MO,WE or
    /// FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6. Omit for a one-off event.
    #[serde(default)]
    recurrence_rule: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct UpdatePlannerEventArgs {
    /// Event UUID (a series or one-off event, not a replaced occurrence).
    id: String,
    /// Revision from the latest read; stale revisions are refused with code conflict.
    expected_revision: i64,
    /// Fields left out keep their current value.
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    location: Option<String>,
    /// "" removes it.
    #[serde(default)]
    meeting_url: Option<String>,
    /// The complete new list.
    #[serde(default)]
    participants: Option<Vec<String>>,
    /// "" removes the epic.
    #[serde(default)]
    epic_id: Option<String>,
    /// "" removes the color override.
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    all_day: Option<bool>,
    /// Same formats as create_planner_event. When switching between timed and all-day, pass both
    /// start_value and end_value.
    #[serde(default)]
    start_value: Option<String>,
    #[serde(default)]
    end_value: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    /// "" makes the event a one-off.
    #[serde(default)]
    recurrence_rule: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct CancelOccurrenceArgs {
    /// The recurring event's UUID (series_id in get_planner_calendar).
    series_id: String,
    /// The series' revision (series_revision in get_planner_calendar).
    expected_revision: i64,
    /// The occurrence's local date, YYYY-MM-DD (occurrence_key in get_planner_calendar).
    occurrence_key: String,
}

#[derive(Deserialize, JsonSchema)]
struct ReplaceOccurrenceArgs {
    /// The recurring event's UUID (series_id in get_planner_calendar).
    series_id: String,
    /// The series' revision (series_revision in get_planner_calendar).
    expected_revision: i64,
    /// The occurrence's local date, YYYY-MM-DD (occurrence_key in get_planner_calendar).
    occurrence_key: String,
    /// New start, same formats as create_planner_event.
    start_value: String,
    /// New end, same formats as create_planner_event.
    end_value: String,
    /// Fields left out are taken from the series.
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    meeting_url: Option<String>,
    #[serde(default)]
    participants: Option<Vec<String>>,
    #[serde(default)]
    epic_id: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    all_day: Option<bool>,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct WorkSessionListArgs {
    /// Only this Board task's sessions (UUID from list_planner_tasks).
    #[serde(default)]
    task_id: Option<String>,
    /// Include cancelled sessions (default false).
    #[serde(default)]
    include_cancelled: bool,
}

#[derive(Deserialize, JsonSchema)]
struct CreateWorkSessionArgs {
    /// Board task UUID from list_planner_tasks.
    task_id: String,
    /// All-day session (default false: timed).
    #[serde(default)]
    all_day: bool,
    /// Timed: RFC 3339 with offset, e.g. 2026-11-20T14:00:00+01:00. All-day: YYYY-MM-DD.
    start_value: String,
    /// Timed: RFC 3339 with offset, after the start. All-day: YYYY-MM-DD, exclusive.
    end_value: String,
    /// IANA timezone, e.g. Europe/Paris.
    timezone: String,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateWorkSessionArgs {
    /// Work session UUID.
    id: String,
    /// Revision from the latest read; stale revisions are refused with code conflict.
    expected_revision: i64,
    /// Fields left out keep their current value.
    #[serde(default)]
    all_day: Option<bool>,
    #[serde(default)]
    start_value: Option<String>,
    #[serde(default)]
    end_value: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct IcalPreviewArgs {
    /// The iCalendar (.ics) text.
    content: String,
    /// IANA timezone for floating times (no TZID and no Z), default UTC.
    #[serde(default)]
    fallback_timezone: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct IcalImportArgs {
    /// The same iCalendar (.ics) text you previewed.
    content: String,
    /// The same fallback_timezone you previewed with (default UTC).
    #[serde(default)]
    fallback_timezone: Option<String>,
    /// What to import: candidate keys or source_uids from preview_ical_import. A source_uid selects
    /// every candidate with that UID (a recurring series and its overrides). Default: everything.
    /// An entry that matches no candidate refuses the whole import.
    #[serde(default)]
    select: Option<Vec<String>>,
    /// Import events already imported before again (default false: they're skipped).
    #[serde(default)]
    allow_duplicates: bool,
}

/// An event occurrence in `get_planner_calendar`, with the revision a change to its series needs.
#[derive(Serialize)]
struct CalendarOccurrence {
    #[serde(flatten)]
    occurrence: mosaic_core::planner::EventOccurrence,
    series_revision: Option<i64>,
}

#[derive(Serialize)]
struct CalendarView {
    from: String,
    to: String,
    events: Vec<CalendarOccurrence>,
    work_sessions: Vec<mosaic_core::planner::CalendarWorkSession>,
    due_markers: Vec<mosaic_core::planner::DueMarker>,
    workload: Vec<mosaic_core::planner::DayWorkload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unscheduled_tasks: Option<Vec<mosaic_core::planner::PlannerTask>>,
}

/// `Some("")` → `None`; otherwise the given value or the current one.
fn merged(given: Option<String>, current: Option<String>) -> Option<String> {
    match given {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(value),
        None => current,
    }
}

/// Notes listed as MCP resources at most (clients show them in a picker).
const MAX_RESOURCES: usize = 5000;

/// `Folder/My note.md` → `mosaic:///Folder/My%20note.md`.
fn resource_uri(path: &str) -> String {
    let mut out = String::from("mosaic:///");
    for c in path.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '%' => out.push_str("%25"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            c => out.push(c),
        }
    }
    out
}

/// The vault path in a `mosaic:///…` URI (percent-decoded).
fn resource_path(uri: &str) -> Option<String> {
    let rest = uri
        .strip_prefix("mosaic:///")
        .or_else(|| uri.strip_prefix("mosaic://"))?;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|&b| hex(b)),
                bytes.get(i + 2).and_then(|&b| hex(b)),
            )
        {
            out.push(hi * 16 + lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_uris_round_trip() {
        for p in ["Home.md", "Folder/My note #1?.md", "Ünïcode/100% done.md"] {
            assert_eq!(resource_path(&resource_uri(p)).as_deref(), Some(p));
        }
        assert_eq!(
            resource_path("mosaic:///a%2"),
            Some("a%2".into()),
            "a broken escape stays as text"
        );
        assert_eq!(resource_path("file:///x"), None);
    }
}

/// Largest file an agent can add in one `import_file` call.
const MAX_IMPORT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Deserialize, JsonSchema)]
struct RenderArgs {
    /// Vault-relative path of a .canvas (or .svg) file.
    path: String,
    /// Dark theme (default false).
    dark: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct CopyArgs {
    /// Vault-relative path of the file to copy.
    from: String,
    /// Vault-relative path of the new copy. Must not exist yet.
    to: String,
}

/// Which vault the server works on: one given on the command line, or whichever is open in the app.
#[derive(Clone, Copy, PartialEq)]
pub enum VaultMode {
    /// `--vault` or `$MOSAIC_VAULT`: always this folder.
    Pinned,
    /// No vault given: the vault open in the Mosaic app, switching when the human switches.
    FollowApp,
}

#[derive(Clone)]
pub struct MosaicMcp {
    /// `None` until a vault opens: the server still answers the MCP handshake and lists its tools,
    /// and tools explain what to do (see `no_vault`). It only ever moves from `None` to `Some`.
    ws: Arc<RwLock<Option<Arc<Workspace>>>>,
    mode: VaultMode,
    /// The pinned `--vault` folder, retried while it can't be opened. Never replaced by the app's.
    pinned: Option<PathBuf>,
    /// `--may-change`, re-applied when another vault opens.
    may_change: Option<Vec<String>>,
    /// Whether clients know about the vault's resources and prompts: true when a vault was open at
    /// startup, set once they're told it opened later.
    announced: Arc<std::sync::atomic::AtomicBool>,
    /// The MCP client's name, recorded with every change in the file history.
    actor: Arc<RwLock<Option<String>>>,
    tool_router: ToolRouter<Self>,
    /// The app's calendar subscriptions (see `subscriptions`); `None` without an app data folder.
    feeds: Option<Arc<dyn subscriptions::Feeds>>,
    /// When this server last walked the vault, and which vault (it can follow the app's).
    last_sync: Arc<Mutex<Option<(PathBuf, Instant)>>>,
}

/// The app's watcher marks the index every 2 s; older than this, it isn't running.
const APP_HEARTBEAT_AGE: Duration = Duration::from_secs(5);
/// Calls closer together than this share one walk of the vault.
const RESYNC_AFTER: Duration = Duration::from_millis(500);

/// The vault the app has open (the last one it opened), if it still exists.
fn app_vault() -> Option<PathBuf> {
    Settings::load().last_vault.filter(|p| p.is_dir())
}

#[tool_router(router = tool_router)]
impl MosaicMcp {
    pub fn new(
        ws: Option<Workspace>,
        mode: VaultMode,
        pinned: Option<PathBuf>,
        may_change: Option<Vec<String>>,
    ) -> Self {
        Self {
            announced: Arc::new(std::sync::atomic::AtomicBool::new(ws.is_some())),
            ws: Arc::new(RwLock::new(ws.map(Arc::new))),
            mode,
            pinned,
            may_change,
            actor: Arc::new(RwLock::new(None)),
            tool_router: Self::tool_router() + Self::subscription_router(),
            feeds: subscriptions::app_feeds(),
            last_sync: Default::default(),
        }
    }

    /// The workspace for this call, with the folder rules read once for the whole call (see
    /// `Workspace::freeze_rules`). Only reached after `call_tool` (or another entry point) has
    /// checked that a vault is open; the slot never goes back to `None`.
    fn ws(&self) -> mosaic_core::api::RulesFrozen<Arc<Workspace>> {
        Workspace::frozen(
            self.workspace()
                .expect("entry points check for an open vault first"),
        )
    }

    /// The current workspace, if any. In follow mode, switches first if the app opened another
    /// vault (or opens the app's vault when none was open yet). A pinned server only ever retries
    /// its own folder.
    fn workspace(&self) -> Option<Arc<Workspace>> {
        let current = self.ws.read().unwrap_or_else(|p| p.into_inner()).clone();
        let wanted = match self.mode {
            VaultMode::FollowApp => app_vault(),
            VaultMode::Pinned if current.is_none() => self.pinned.clone(),
            VaultMode::Pinned => None,
        };
        if let Some(root) = wanted
            && current.as_ref().is_none_or(|c| root != c.vault.root())
            && let Ok(next) = Workspace::open(&root)
        {
            let mut next = next
                .validating()
                .with_source(mosaic_core::history::Source::Agent);
            // Every open (the lazy first one and each follow-mode switch) builds the workspace
            // here, so the `--may-change` restriction is applied to each one.
            if let Some(only) = &self.may_change {
                next = next.with_change_allowlist(only.clone());
            }
            let next = Arc::new(next);
            if let Some(name) = self
                .actor
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .as_deref()
            {
                next.set_actor(name);
            }
            let _ = next.sync(|_, _| {});
            let mut slot = self.ws.write().unwrap_or_else(|p| p.into_inner());
            // Another call may have switched while this one synced: keep whichever came first.
            let unchanged = match (&*slot, &current) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            };
            if !unchanged {
                return slot.clone();
            }
            *slot = Some(next.clone());
            return Some(next);
        }
        current
    }

    /// Opens the vault if it can be opened now. When it opens during this request, tells the
    /// client (once) that resources and prompts changed: it listed them empty before.
    async fn open_vault(&self, peer: &rmcp::Peer<RoleServer>) -> Option<Arc<Workspace>> {
        let ws = self.workspace()?;
        if !self
            .announced
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let _ = peer.notify_resource_list_changed().await;
            let _ = peer.notify_prompt_list_changed().await;
        }
        Some(ws)
    }

    /// Why no vault is open, and what the human can do about it: returned by every tool but
    /// `vault_guide` until a vault opens.
    fn no_vault(&self) -> String {
        let message = match (&self.mode, &self.pinned) {
            (VaultMode::Pinned, Some(path)) => format!(
                "The Mosaic vault this server is pinned to ({}, from --vault or MOSAIC_VAULT) can't be opened: it was moved, renamed or isn't mounted. Ask the human to update the MCP registration: remove `--vault ...` so it follows the vault open in the Mosaic app (the command is in Mosaic › Settings › AI › Connections), or point it at the vault's current folder.",
                path.display()
            ),
            _ => "No Mosaic vault is open yet. Ask the human to open (or create) a vault in the Mosaic app; this server picks it up on the next call, without restarting.".to_string(),
        };
        serde_json::json!({ "code": "no_vault", "message": message }).to_string()
    }

    /// A warning when a pinned vault isn't the one the human is looking at in the app.
    fn mismatch_note(&self) -> Option<String> {
        if self.mode != VaultMode::Pinned {
            return None;
        }
        let root = self.workspace()?.vault.root().to_path_buf();
        let app = app_vault()?;
        (app != root).then(|| {
            format!(
                "Note: this server is pinned to the vault {} (--vault), but the Mosaic app has {} open. Files you write may not be where the human is looking; mention it to them.\n\n",
                root.display(),
                app.display()
            )
        })
    }

    /// Picks up changes made by the app or other tools before answering index-backed questions.
    /// Skipped while the app's watcher keeps this index current, and right after the last walk
    /// (an agent's burst of calls), so a call costs a walk of the vault only when it's needed.
    fn fresh(&self) {
        let ws = self.ws();
        if ws.index().watched_within(APP_HEARTBEAT_AGE) {
            return;
        }
        let mut last = self.last_sync.lock().unwrap_or_else(|p| p.into_inner());
        if last
            .as_ref()
            .is_some_and(|(root, at)| root == ws.vault.root() && at.elapsed() < RESYNC_AFTER)
        {
            return;
        }
        if ws.sync(|_, _| {}).is_ok() {
            *last = Some((ws.vault.root().to_path_buf(), Instant::now()));
        }
    }

    #[tool(
        description = "Explain the vault's conventions: link syntax, frontmatter, canvases, charts, diagrams and editing rules. Read this once before editing."
    )]
    async fn vault_guide(&self) -> String {
        format!(
            "{}{}",
            self.mismatch_note().unwrap_or_default(),
            crate::AGENT_GUIDE
        )
    }

    #[tool(
        description = "List files and folders (vault-relative paths, kind, size, modified time)."
    )]
    async fn list_files(&self, Parameters(a): Parameters<ListArgs>) -> ToolResult {
        self.ws()
            .files
            .list(&a.dir, a.recursive)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Read a file. Returns its content (null for binary files) and a hash to pass as expected_hash when editing."
    )]
    async fn read_file(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws().files.read(&a.path).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Cheap overview of a file: title, frontmatter, tags, headings, outgoing links (resolved) and backlinks. Use before reading large notes."
    )]
    async fn outline(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.fresh();
        self.ws().links.outline(&a.path).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Full-text search over file names, titles and contents. Returns paths, titles and snippets with matches in **bold**."
    )]
    async fn search(&self, Parameters(a): Parameters<SearchArgs>) -> ToolResult {
        self.fresh();
        self.ws()
            .search(&a.query, a.limit.unwrap_or(20))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Structured query over the vault's notes: by tag, folder, frontmatter field, date and links. More precise than search. Filters (prefix - to negate): tag:project (nested tags match; tag:a|b for either), folder:Projects, kind:markdown|canvas, links-to:Note (notes linking to it), linked-from:Note (notes it links to), has:field. Comparisons on frontmatter fields and on title, name, folder, tags, modified: status=active, status!=done, priority>2, due<=today+7, title~draft (contains); a|b matches either; list fields match if any item does; dates as 2026-10-02, today, today-7. Uppercase OR separates alternative AND groups, e.g. `tag:work status=active OR tag:idea priority>2`. Also sort:due or sort:-modified (descending), limit:N (default 100), show:a,b (columns), and plain words for full-text search. Quote values with spaces: status=\"in progress\". Returns matching notes with title, modified time, tags and frontmatter, the columns worth showing, and the total before limit. Tasks: task:open (or done, moved, cancelled, all; task:open|moved) returns Markdown checkbox tasks (`- [ ] text`) instead of notes, not the app-only planner's tasks. Each row has a `task` (line, status, mark, text, depth, parent line, due). Filters then apply per task: its own text, status, due (from 📅 2026-10-05 on its line, else the note's due) and line, then its note's fields; tag: matches #tags in the task or the note's frontmatter tags; plain words must appear in the task text. E.g. task:open folder:Daily, task:open due<=today sort:due. Tick one with patch_file on that line."
    )]
    async fn query(&self, Parameters(a): Parameters<QueryArgs>) -> ToolResult {
        self.fresh();
        self.ws().query(&a.query).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Markdown checkbox tasks by day, separate from the app-only planner: for each day from `from` to `to` (default: today and the 6 days after), its daily note (a note named after the date, e.g. `Daily/2026-10-04.md`) and its tasks — the daily note's checkboxes (daily: true) plus tasks in other notes due that day with `📅 2026-10-04` (daily: false). Each task has path, line, status (open, done, moved, cancelled), text, depth and parent (subtasks). Also `overdue`: dated tasks still open after their day. Use it to plan or summarise a week."
    )]
    async fn tasks_by_day(&self, Parameters(a): Parameters<DaysArgs>) -> ToolResult {
        self.fresh();
        let today = mosaic_core::days::today();
        let from = a.from.unwrap_or_else(|| today.clone());
        let to = match a.to {
            Some(t) => t,
            None => mosaic_core::days::plus_days(&from, 6).map_err(err)?,
        };
        self.ws().days(&from, &to, &today).map_err(err).and_then(ok)
    }

    #[tool(
        description = "The person's agents: files in the vault's `Agents/` folder (a note `Agents/Name.md`, or a skill folder `Agents/Name/SKILL.md`) that define how an agent acts. Each has name, title, description, path, schedule, on (event triggers such as `created in Daily/`), model, may_change (folders it may write without review, plus app-data scopes such as `planner:` it may change directly) and its instructions. When the person points you at one of these files (or names an agent), act as that agent: follow its instructions, don't treat it as an ordinary document. The same agents are slash commands (MCP prompts) in Claude Code."
    )]
    async fn list_agents(&self) -> ToolResult {
        self.fresh();
        self.ws().agents().map_err(err).and_then(ok)
    }

    #[tool(
        description = "Carry unfinished Markdown checkbox tasks over to a day (default today), without changing app-only planner tasks: the open tasks of the most recent daily note before that day move into the day's note (created beside it if missing), each with its open subtasks; the old note keeps them as `- [>] task`. Returns from, to, moved (count) and created. Running it again moves nothing more."
    )]
    async fn carry_over(&self, Parameters(a): Parameters<CarryOverArgs>) -> ToolResult {
        self.fresh();
        let day = a.day.unwrap_or_else(mosaic_core::days::today);
        self.ws()
            .carry_over(&day, None, None)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "List planner epics with their IDs, colors, positions, revisions and lifecycle state. Use an epic ID when assigning a planner task. These are app-owned planner items, separate from Markdown checkboxes."
    )]
    async fn list_planner_epics(&self, Parameters(a): Parameters<PlannerListArgs>) -> ToolResult {
        self.ws()
            .planner
            .epics(a.include_archived, a.include_trashed)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "List app-owned planner tasks, including IDs, hierarchy, epic, status, due date, estimate, board position and revision. Separate from Markdown checkbox tasks. Include archived or trashed tasks only when requested."
    )]
    async fn list_planner_tasks(&self, Parameters(a): Parameters<PlannerListArgs>) -> ToolResult {
        self.ws()
            .planner
            .tasks(a.include_archived, a.include_trashed)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Read one app-owned planner task by UUID. Returns its latest revision, which must be passed to every change so concurrent edits are refused instead of overwritten."
    )]
    async fn get_planner_task(&self, Parameters(a): Parameters<PlannerTaskIdArgs>) -> ToolResult {
        let task = self
            .ws()
            .planner
            .tasks(true, true)
            .map_err(err)?
            .into_iter()
            .find(|task| task.id == a.id)
            .ok_or_else(|| err(Error::NotFound(format!("planner task/{}", a.id))))?;
        ok(task)
    }

    #[tool(
        description = "Read the complete activity history of one app-owned planner task, oldest first. Each entry says when (occurred_at, UTC), who (source: app, cli, agent or external, plus actor: the agent name; both absent on old entries), what (action and a self-contained summary), exactly which fields changed (changes: field, from, to — status transitions appear as the status field), why when it was a consequence of another change (reason), and a one-line `text` rendering. The full before/after snapshots are included too."
    )]
    async fn planner_task_history(
        &self,
        Parameters(a): Parameters<PlannerTaskIdArgs>,
    ) -> ToolResult {
        // Refuse an unknown task rather than returning an ambiguous empty history.
        self.ws()
            .planner
            .tasks(true, true)
            .map_err(err)?
            .into_iter()
            .find(|task| task.id == a.id)
            .ok_or_else(|| err(Error::NotFound(format!("planner task/{}", a.id))))?;
        self.ws()
            .planner
            .activity("task", &a.id)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Create an app-owned planner task or subtask. Use list_planner_epics for epic IDs and list_planner_tasks for parent IDs. Returns the created task and revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn create_planner_task(
        &self,
        Parameters(a): Parameters<CreatePlannerTaskArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .create_task(CreateTask {
                epic_id: a.epic_id,
                parent_id: a.parent_id,
                title: a.title,
                description: a.description,
                status: a.status.unwrap_or(PlannerTaskStatusArg::New).into(),
                due_date: a.due_date,
                estimate_minutes: a.estimate_minutes,
            })
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Edit an app-owned planner task's title, description, due date or estimate. Pass the latest expected_revision from get/list; a stale revision returns conflict. This does not move, complete or archive the task. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn update_planner_task(
        &self,
        Parameters(a): Parameters<UpdatePlannerTaskArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .update_task(
                &a.id,
                UpdateTask {
                    expected_revision: a.expected_revision,
                    title: a.title,
                    description: a.description,
                    due_date: a.due_date,
                    clear_due_date: a.clear_due_date,
                    estimate_minutes: a.estimate_minutes,
                    clear_estimate: a.clear_estimate,
                },
            )
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move or reorder an app-owned planner task by supplying its complete destination epic, parent and non-Done status. Omit position to append in the destination. Use complete_planner_task or reopen_planner_task when crossing Done. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn move_planner_task(
        &self,
        Parameters(a): Parameters<MovePlannerTaskArgs>,
    ) -> ToolResult {
        let status: TaskStatus = a.status.into();
        let position = match a.position {
            Some(position) => position,
            None => {
                self.ws()
                    .planner
                    .tasks(true, true)
                    .map_err(err)?
                    .into_iter()
                    .filter(|task| {
                        task.id != a.id
                            && task.epic_id == a.epic_id
                            && task.parent_id == a.parent_id
                            && task.status == status
                    })
                    .map(|task| task.position)
                    .max()
                    .unwrap_or(0)
                    + 1024
            }
        };
        self.ws()
            .planner
            .move_task(
                &a.id,
                MoveTask {
                    expected_revision: a.expected_revision,
                    epic_id: a.epic_id,
                    parent_id: a.parent_id,
                    status,
                    position,
                },
            )
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Complete an app-owned planner task. By default this refuses incomplete subtasks and cancels future work sessions. Set the confirmation/policy fields deliberately when another outcome is intended. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn complete_planner_task(
        &self,
        Parameters(a): Parameters<CompletePlannerTaskArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .complete_task(
                &a.id,
                a.expected_revision,
                a.allow_incomplete_subtasks,
                a.future_sessions
                    .unwrap_or(FutureSessionPolicyArg::Cancel)
                    .into(),
            )
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Reopen a completed app-owned planner task as New. Pass its latest expected_revision. Move it afterward if another active status is wanted. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn reopen_planner_task(
        &self,
        Parameters(a): Parameters<PlannerTaskRevisionArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .reopen_task(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Archive an app-owned planner task while keeping it recoverable. Pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn archive_planner_task(
        &self,
        Parameters(a): Parameters<PlannerTaskRevisionArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .archive_task(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Restore an archived or trashed app-owned planner task. Pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn restore_planner_task(
        &self,
        Parameters(a): Parameters<PlannerTaskRevisionArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .restore_task(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move an archived app-owned planner task to Trash, where it remains recoverable. Archive it first and pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn trash_planner_task(
        &self,
        Parameters(a): Parameters<PlannerTaskRevisionArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .trash_task(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    /// A series or one-off event, archived and trashed included.
    fn planner_event(&self, id: &str) -> Result<PlannerEvent, String> {
        self.ws()
            .planner
            .events(true, true)
            .map_err(err)?
            .into_iter()
            .find(|event| event.id == id)
            .ok_or_else(|| err(Error::NotFound(format!("planner event/{id}"))))
    }

    #[tool(
        description = "List the planner calendar's events: one-off events and recurring series (one entry per series, with its recurrence_rule), with id, revision, title, start_value/end_value (timed: RFC 3339 in UTC; all-day: YYYY-MM-DD, end exclusive), timezone, epic and lifecycle state. To see what happens on given days, with each recurrence expanded, use get_planner_calendar. Include archived or trashed events only when requested."
    )]
    async fn list_planner_events(&self, Parameters(a): Parameters<PlannerListArgs>) -> ToolResult {
        self.ws()
            .planner
            .events(a.include_archived, a.include_trashed)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "The planner calendar for a range of days (from/to as YYYY-MM-DD, default today and the 6 days after; at most 371 days). Returns `events`: every occurrence in the range, recurring series expanded, cancelled occurrences left out and replaced ones shown as their replacement (replacement: event_id differs from series_id); each has series_id, series_revision and occurrence_key (its local date), which is what update_planner_event, cancel_planner_event_occurrence and replace_planner_event_occurrence take. Also `work_sessions` (Board tasks scheduled in the range: session id and revision, task_id, task title and status), `due_markers` (Board tasks due in the range) and `workload` (scheduled minutes per day). Times are RFC 3339 in UTC; all-day values are dates with an exclusive end. Separate from Markdown checkbox tasks (tasks_by_day)."
    )]
    async fn get_planner_calendar(&self, Parameters(a): Parameters<CalendarArgs>) -> ToolResult {
        let from = a.from.unwrap_or_else(mosaic_core::days::today);
        let to = match a.to {
            Some(to) => to,
            None => mosaic_core::days::plus_days(&from, 6).map_err(err)?,
        };
        let ws = self.ws();
        let range = ws.planner.calendar_range(&from, &to).map_err(err)?;
        let revisions: std::collections::HashMap<String, i64> = ws
            .planner
            .events(false, false)
            .map_err(err)?
            .into_iter()
            .map(|event| (event.id, event.revision))
            .collect();
        ok(CalendarView {
            from: range.from,
            to: range.to,
            events: range
                .events
                .into_iter()
                .map(|occurrence| CalendarOccurrence {
                    series_revision: revisions.get(&occurrence.series_id).copied(),
                    occurrence,
                })
                .collect(),
            work_sessions: range.work_sessions,
            due_markers: range.due_markers,
            workload: range.workload,
            unscheduled_tasks: a
                .include_unscheduled_tasks
                .then_some(range.unscheduled_tasks),
        })
    }

    #[tool(
        description = "Create a planner calendar event, one-off or recurring. Timed events take RFC 3339 times with an offset (2026-11-20T09:00:00+01:00); all-day events take YYYY-MM-DD with an exclusive end. timezone is an IANA name (Europe/Paris). recurrence_rule is an RRULE such as FREQ=WEEKLY;BYDAY=MO. Returns the event with its id and revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn create_planner_event(
        &self,
        Parameters(a): Parameters<CreatePlannerEventArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .create_event(CreateEvent {
                title: a.title,
                description: a.description,
                location: a.location,
                meeting_url: a.meeting_url,
                participants: a.participants,
                epic_id: a.epic_id,
                color: a.color,
                all_day: a.all_day,
                start_value: a.start_value,
                end_value: a.end_value,
                timezone: a.timezone,
                recurrence_rule: a.recurrence_rule,
            })
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Change a planner calendar event or a whole recurring series. Pass only the fields to change; \"\" removes meeting_url, epic_id, color or recurrence_rule. Pass the latest expected_revision; a stale one returns conflict. To change one occurrence of a series, use replace_planner_event_occurrence. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn update_planner_event(
        &self,
        Parameters(a): Parameters<UpdatePlannerEventArgs>,
    ) -> ToolResult {
        let current = self.planner_event(&a.id)?;
        self.ws()
            .planner
            .update_event(
                &a.id,
                UpdateEvent {
                    expected_revision: a.expected_revision,
                    title: a.title.unwrap_or(current.title),
                    description: a.description.unwrap_or(current.description),
                    location: a.location.unwrap_or(current.location),
                    meeting_url: merged(a.meeting_url, current.meeting_url),
                    participants: a.participants.unwrap_or(current.participants),
                    epic_id: merged(a.epic_id, current.epic_id),
                    color: merged(a.color, current.color),
                    all_day: a.all_day.unwrap_or(current.all_day),
                    start_value: a.start_value.unwrap_or(current.start_value),
                    end_value: a.end_value.unwrap_or(current.end_value),
                    timezone: a.timezone.unwrap_or(current.timezone),
                    recurrence_rule: merged(a.recurrence_rule, current.recurrence_rule),
                },
            )
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Archive a planner calendar event or recurring series: it leaves the calendar but stays recoverable. Pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn archive_planner_event(
        &self,
        Parameters(a): Parameters<PlannerEventIdArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .archive_event(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Restore an archived or trashed planner calendar event to the calendar. Pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn restore_planner_event(
        &self,
        Parameters(a): Parameters<PlannerEventIdArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .restore_event(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move an archived planner calendar event to Trash, where it remains recoverable. Archive it first and pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn trash_planner_event(
        &self,
        Parameters(a): Parameters<PlannerEventIdArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .trash_event(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Cancel one occurrence of a recurring planner event, leaving the rest of the series. Take series_id, series_revision (as expected_revision) and occurrence_key from get_planner_calendar. Returns the series with its new revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn cancel_planner_event_occurrence(
        &self,
        Parameters(a): Parameters<CancelOccurrenceArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .cancel_event_occurrence(&a.series_id, a.expected_revision, &a.occurrence_key)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move or change one occurrence of a recurring planner event, leaving the rest of the series. Take series_id, series_revision (as expected_revision) and occurrence_key from get_planner_calendar; give the occurrence's new start_value and end_value, and any field that differs from the series. Replacing it again later replaces the replacement. Returns the replacement event. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn replace_planner_event_occurrence(
        &self,
        Parameters(a): Parameters<ReplaceOccurrenceArgs>,
    ) -> ToolResult {
        let series = self.planner_event(&a.series_id)?;
        self.ws()
            .planner
            .replace_event_occurrence(
                &a.series_id,
                a.expected_revision,
                &a.occurrence_key,
                CreateEvent {
                    title: a.title.unwrap_or(series.title),
                    description: a.description.unwrap_or(series.description),
                    location: a.location.unwrap_or(series.location),
                    meeting_url: merged(a.meeting_url, series.meeting_url),
                    participants: a.participants.unwrap_or(series.participants),
                    epic_id: merged(a.epic_id, series.epic_id),
                    color: merged(a.color, series.color),
                    all_day: a.all_day.unwrap_or(series.all_day),
                    start_value: a.start_value,
                    end_value: a.end_value,
                    timezone: a.timezone.unwrap_or(series.timezone),
                    recurrence_rule: None,
                },
            )
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "List work sessions: blocks of time on the calendar for a Board task, optionally for one task. Each has id, task_id, all_day, start_value/end_value (timed: RFC 3339 in UTC; all-day: YYYY-MM-DD, end exclusive), timezone, state and revision. get_planner_calendar shows them by day with their task's title."
    )]
    async fn list_planner_work_sessions(
        &self,
        Parameters(a): Parameters<WorkSessionListArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .work_sessions(a.task_id.as_deref(), a.include_cancelled)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Schedule a Board task on the calendar as a work session. Timed sessions take RFC 3339 times with an offset; all-day sessions take YYYY-MM-DD with an exclusive end. Returns the session with its id and revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn create_planner_work_session(
        &self,
        Parameters(a): Parameters<CreateWorkSessionArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .create_work_session(CreateWorkSession {
                task_id: a.task_id,
                all_day: a.all_day,
                start_value: a.start_value,
                end_value: a.end_value,
                timezone: a.timezone,
            })
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move or resize a work session. Pass only the fields to change and its latest expected_revision; a stale one returns conflict. Cancelled sessions can't be changed. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn update_planner_work_session(
        &self,
        Parameters(a): Parameters<UpdateWorkSessionArgs>,
    ) -> ToolResult {
        let current = self
            .ws()
            .planner
            .work_sessions(None, true)
            .map_err(err)?
            .into_iter()
            .find(|session| session.id == a.id)
            .ok_or_else(|| err(Error::NotFound(format!("planner work_session/{}", a.id))))?;
        self.ws()
            .planner
            .update_work_session(
                &a.id,
                UpdateWorkSession {
                    expected_revision: a.expected_revision,
                    all_day: a.all_day.unwrap_or(current.all_day),
                    start_value: a.start_value.unwrap_or(current.start_value),
                    end_value: a.end_value.unwrap_or(current.end_value),
                    timezone: a.timezone.unwrap_or(current.timezone),
                },
            )
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Cancel a work session: it leaves the calendar (list_planner_work_sessions still shows it with include_cancelled). Pass its latest expected_revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn cancel_planner_work_session(
        &self,
        Parameters(a): Parameters<PlannerTaskRevisionArgs>,
    ) -> ToolResult {
        self.ws()
            .planner
            .cancel_work_session(&a.id, a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Read an iCalendar (.ics) text and show what importing it into the planner calendar would add, without changing anything. Returns candidates (key, source_uid, title, times, timezone, recurrence_rule, recurrence_key for an override of one occurrence, and duplicate: already imported before), the number of duplicates and warnings about skipped or adjusted data. Import with import_ical and the same content."
    )]
    async fn preview_ical_import(&self, Parameters(a): Parameters<IcalPreviewArgs>) -> ToolResult {
        let preview = self
            .ws()
            .planner
            .preview_ical_import(
                ICAL_SOURCE,
                &a.content,
                a.fallback_timezone.as_deref().unwrap_or("UTC"),
            )
            .map_err(err)?;
        ok(serde_json::json!({
            "planner_revision": preview.planner_revision,
            "duplicates": preview.duplicates,
            "warnings": preview.warnings,
            "candidates": preview.candidates.iter().map(|c| serde_json::json!({
                "key": c.key,
                "source_uid": c.source_uid,
                "recurrence_id": c.recurrence_id,
                "recurrence_key": c.recurrence_key,
                "title": c.title,
                "location": c.event.location,
                "all_day": c.all_day,
                "start_value": c.start_value,
                "end_value": c.end_value,
                "timezone": c.timezone,
                "recurrence_rule": c.recurrence_rule,
                "duplicate": c.duplicate,
            })).collect::<Vec<_>>(),
        }))
    }

    #[tool(
        description = "Import events from iCalendar (.ics) text into the planner calendar: all of them, or those named in `select` (keys or source_uids from preview_ical_import). Events imported before are skipped unless allow_duplicates. Returns imported_event_ids and skipped_duplicates. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `planner:`."
    )]
    async fn import_ical(&self, Parameters(a): Parameters<IcalImportArgs>) -> ToolResult {
        let ws = self.ws();
        let preview = ws
            .planner
            .preview_ical_import(
                ICAL_SOURCE,
                &a.content,
                a.fallback_timezone.as_deref().unwrap_or("UTC"),
            )
            .map_err(err)?;
        let keys: Vec<String> = match a.select {
            None => preview.candidates.iter().map(|c| c.key.clone()).collect(),
            Some(select) => {
                let mut keys = Vec::new();
                for wanted in select {
                    let matched: Vec<&String> = preview
                        .candidates
                        .iter()
                        .filter(|c| c.key == wanted || c.source_uid == wanted)
                        .map(|c| &c.key)
                        .collect();
                    if matched.is_empty() {
                        return Err(err(Error::Invalid(format!(
                            "{wanted:?} matches no event in this calendar; use a key or source_uid from preview_ical_import"
                        ))));
                    }
                    for key in matched {
                        if !keys.contains(key) {
                            keys.push(key.clone());
                        }
                    }
                }
                keys
            }
        };
        ws.planner
            .import_ical(&preview, &keys, a.allow_duplicates)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Export the planner calendar's events (series with their cancelled and replaced occurrences) as iCalendar text, returned as the tool result. Mosaic writes no file; save it with create_file if the person wants one in the vault."
    )]
    async fn export_ical(&self) -> ToolResult {
        self.ws().planner.export_ical().map_err(err)
    }

    #[tool(
        description = "Your changes waiting for the person's review (in folders where they review agents' changes), and their decisions on recent ones: status pending, accepted, rejected (with their reason), withdrawn, or undone (accepted, then undone by the person: the file no longer has your change). stale means the file changed since you proposed; overwrote means they accepted it anyway, replacing their own changes made since."
    )]
    async fn list_proposals(&self, Parameters(a): Parameters<ProposalsArgs>) -> ToolResult {
        self.ws()
            .review()
            .list(true, a.limit.unwrap_or(30))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(description = "Take back one of your pending proposals (the file stays as it is).")]
    async fn withdraw_proposal(&self, Parameters(a): Parameters<IdArg>) -> ToolResult {
        self.ws()
            .review()
            .withdraw(a.id)
            .map_err(err)
            .and_then(|_| ok(serde_json::json!({ "withdrawn": a.id })))
    }

    #[tool(
        description = "Create a new file (fails if it exists). Use .md for notes, .canvas for boards, .vl.json for charts, .dot for graphs."
    )]
    async fn create_file(&self, Parameters(a): Parameters<CreateArgs>) -> ToolResult {
        self.ws()
            .files
            .create(&a.path, &a.content)
            .map_err(err)
            .and_then(written)
    }

    #[tool(
        description = "Discover readable Markdown templates. Provide the destination note path to see its folder default and inherited rule. For a new report, render the chosen/default template, fill its sections using your investigation instructions, then create_file with the completed report."
    )]
    async fn list_templates(&self, Parameters(a): Parameters<TemplatesArgs>) -> ToolResult {
        self.fresh();
        self.ws()
            .list_templates(a.path.as_deref())
            .map_err(err)
            .and_then(ok)
    }
    #[tool(
        description = "Read vault-scoped preferences from Settings: agents and daily folders, daily filename format, where new notes and attachments go, generated link syntax, startup note and folder colors, plus the `revision` set_vault_preferences needs. Settings changes never move existing files. Settings naming a path hidden from you come back blank and are listed in `hidden`."
    )]
    async fn get_vault_preferences(&self) -> ToolResult {
        self.ws()
            .revised_vault_preferences()
            .map_err(err)
            .and_then(ok)
    }
    #[tool(
        description = "Change vault preferences, as the person would in Settings. Pass only the keys to change and the `revision` from get_vault_preferences; a stale revision returns conflict (read again). Settable: daily_notes_enabled, daily_folder, daily_template, daily_format (YYYY-MM-DD, DD-MM-YYYY, YYYYMMDD), new_note_location (current, root, folder), new_note_folder, attachment_location (next-to-note, folder), attachment_folder, show_attachments_in_tree, link_style (wiki, markdown), startup_note, and folder_colors: per folder a preset (red, orange, green, blue, purple) or null to remove it; other folders keep theirs. Paths are vault-relative. The agents folder and HTML preview permissions are the person's alone and are refused. Changes never move files. Returns the new preferences and revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `settings:`."
    )]
    async fn set_vault_preferences(
        &self,
        Parameters(a): Parameters<SetPreferencesArgs>,
    ) -> ToolResult {
        self.ws()
            .change_vault_preferences(serde_json::Value::Object(a.patch), &a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }
    #[tool(
        description = "Read the template defaults from Settings › Templates: the templates `folder` and per-folder `rules` (a folder's default template, or null for Blank; subfolders inherit, the longest match wins), plus the `revision` set_template_config needs. Rules for folders hidden from you are left out (`hidden` then lists `rules`)."
    )]
    async fn get_template_config(&self) -> ToolResult {
        self.ws()
            .revised_template_config()
            .map_err(err)
            .and_then(ok)
    }
    #[tool(
        description = "Replace the template defaults, as the person would in Settings › Templates: the templates folder and the full list of per-folder rules (send every rule you want to keep). Each template must be a .md file inside the templates folder, and each folder may have one rule. Pass the `revision` from get_template_config; a stale revision returns conflict (read again). Rules you can't see are kept. Template files themselves are ordinary notes: write them with create_file. Returns the new config and revision. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `settings:`."
    )]
    async fn set_template_config(
        &self,
        Parameters(a): Parameters<SetTemplateConfigArgs>,
    ) -> ToolResult {
        let config = mosaic_core::templates::TemplateConfig {
            version: 1,
            folder: a.folder,
            rules: a
                .rules
                .into_iter()
                .map(|r| mosaic_core::templates::TemplateRule {
                    folder: r.folder,
                    template: r.template,
                })
                .collect(),
        };
        self.ws()
            .change_template_config(config, &a.expected_revision)
            .map_err(err)
            .and_then(ok)
    }
    #[tool(
        description = "The starter templates Settings › Templates offers (meeting, retro, …): file name and Markdown with placeholders such as {{title}} and {{date}}. Writes nothing; to add one, create_file it in the templates folder from get_template_config."
    )]
    async fn list_template_starters(&self) -> ToolResult {
        ok(mosaic_core::templates::STARTERS
            .iter()
            .map(|&(name, content)| Starter { name, content })
            .collect::<Vec<_>>())
    }
    #[tool(
        description = "Read the vault's folder rules for agents (Settings › AI): which folders are read-only to you, and where your changes become proposals for review. Rules on or inside folders hidden from you are only counted (`hidden_rules`). Read only: the person sets these rules and no tool changes them."
    )]
    async fn get_agent_rules(&self) -> ToolResult {
        self.ws().agent_rules_view().map_err(err).and_then(ok)
    }
    #[tool(
        description = "Preview a new note using its folder default, an explicit template or Blank. Returns rendered Markdown, source hash, default provenance and title/date/time context; writes nothing. Use the same timestamp and expected_template_hash when creating a scaffold."
    )]
    async fn render_template(&self, Parameters(a): Parameters<NoteArgs>) -> ToolResult {
        self.fresh();
        self.ws()
            .render_template(&a.into())
            .map_err(err)
            .and_then(ok)
    }
    #[tool(
        description = "Create a new Markdown note scaffold using its folder default, explicit template or Blank. Never overwrites. Normal history, folder permissions and review apply. To save an AI report whose template sections you have filled, use create_file with the completed content instead."
    )]
    async fn create_note(&self, Parameters(a): Parameters<NoteArgs>) -> ToolResult {
        self.fresh();
        self.ws().create_note(&a.into()).map_err(err).and_then(|n| {
            let mut v = serde_json::to_value(&n).map_err(|e| e.to_string())?;
            if n.written.review.is_some() {
                v["note"] = REVIEW_NOTE.into();
            }
            ok(v)
        })
    }

    #[tool(
        description = "Replace the whole content of a file (creates it if missing). Prefer patch_file for small changes."
    )]
    async fn edit_file(&self, Parameters(a): Parameters<EditArgs>) -> ToolResult {
        self.ws()
            .files
            .write(&a.path, &a.content, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(written)
    }

    #[tool(
        description = "Replace one exact, unique snippet of a text file. The safest way to make a targeted edit."
    )]
    async fn patch_file(&self, Parameters(a): Parameters<PatchArgs>) -> ToolResult {
        self.ws()
            .files
            .patch(&a.path, &a.find, &a.replace, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(written)
    }

    #[tool(
        description = "Append text to the end of a file (created if missing). Good for logs and journals."
    )]
    async fn append_to_file(&self, Parameters(a): Parameters<AppendArgs>) -> ToolResult {
        self.ws()
            .files
            .append(&a.path, &a.content)
            .map_err(err)
            .and_then(written)
    }

    #[tool(
        description = "Move or rename a file or folder. Links in other notes are updated to follow it."
    )]
    async fn rename(&self, Parameters(a): Parameters<RenameArgs>) -> ToolResult {
        self.fresh();
        self.ws()
            .files
            .rename(&a.from, &a.to, a.update_links.unwrap_or(true))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move several files and folders into one folder in one call (created if missing). Links in other notes follow. Nothing moves if a destination is taken."
    )]
    async fn move_files(&self, Parameters(a): Parameters<MoveArgs>) -> ToolResult {
        self.fresh();
        self.ws()
            .files
            .move_into(&a.paths, &a.folder)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Add a binary file (image, PDF…) from base64 data. Never overwrites: a taken name gets \" 1\", \" 2\"… Returns the path used. Embed images in notes with ![[name.png]]."
    )]
    async fn import_file(&self, Parameters(a): Parameters<ImportArgs>) -> ToolResult {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(a.data.trim())
            .map_err(|e| err(Error::Invalid(format!("data isn't valid base64: {e}"))))?;
        if bytes.len() > MAX_IMPORT_BYTES {
            return Err(err(Error::Invalid(format!(
                "the file is {} MB; the limit is 20 MB",
                bytes.len() / 1_048_576
            ))));
        }
        self.ws()
            .files
            .import(&a.path, &bytes)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Duplicate a file (any kind, including binary). Never overwrites: fails if `to` exists."
    )]
    async fn copy_file(&self, Parameters(a): Parameters<CopyArgs>) -> ToolResult {
        self.ws()
            .files
            .copy(&a.from, &a.to)
            .map_err(err)
            .and_then(written)
    }

    #[tool(description = "Move a file or folder to the macOS Trash (recoverable).")]
    async fn delete_file(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        match self.ws().files.delete(&a.path).map_err(err)? {
            Some(id) => {
                ok(serde_json::json!({ "path": a.path, "review": id, "note": REVIEW_NOTE }))
            }
            None => ok(serde_json::json!({ "deleted": a.path })),
        }
    }

    #[tool(description = "Create a folder (and any missing parents).")]
    async fn create_folder(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws()
            .files
            .mkdir(&a.path)
            .map_err(err)
            .and_then(|_| ok(serde_json::json!({ "created": a.path })))
    }

    #[tool(description = "Notes and canvases that link to or embed a file, with the linking line.")]
    async fn get_backlinks(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.fresh();
        self.ws().links.backlinks(&a.path).map_err(err).and_then(ok)
    }

    #[tool(description = "All tags used in the vault with how many files carry each.")]
    async fn list_tags(&self) -> ToolResult {
        self.fresh();
        self.ws().tags().map_err(err).and_then(ok)
    }

    #[tool(
        description = "The human's bookmarked files, folders, searches (`search:…`) and structured queries (`query:…`), in their order. `exists` is false for a file bookmark whose file is gone."
    )]
    async fn list_bookmarks(&self) -> ToolResult {
        ok(self.ws().files.bookmarks())
    }

    #[tool(
        description = "Bookmark a file or folder, a full-text search as `search:<words>`, or a structured query as `query:<query>` so the human finds it in Bookmarks. Returns the new list. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `bookmarks:`."
    )]
    async fn add_bookmark(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws()
            .files
            .add_bookmark(&a.path)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Versions of a file that Mosaic kept (newest first): who changed it (app, cli, agent, external), when and how. Use restore_version to go back to one."
    )]
    async fn file_history(&self, Parameters(a): Parameters<HistoryArgs>) -> ToolResult {
        self.ws()
            .files
            .history(&a.path, a.limit.unwrap_or(20))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Put a file back to one of its versions from file_history (also brings back a deleted file). Use it to undo your own mistake."
    )]
    async fn restore_version(&self, Parameters(a): Parameters<RestoreArgs>) -> ToolResult {
        self.ws()
            .files
            .restore(&a.path, a.id, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(written)
    }

    #[tool(
        description = "Draw a canvas (.canvas, including diagrams) or an SVG file as a PNG image, to check what you wrote: layout, overlaps, labels, arrows. Fix the canvas and render again until it looks right."
    )]
    async fn render(
        &self,
        Parameters(a): Parameters<RenderArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ws = self.ws();
        let png = crate::render_file(&ws, &a.path, a.dark.unwrap_or(false))
            .and_then(|svg| crate::png::svg_to_png(&svg, 1.5));
        Ok(match png {
            Ok(bytes) => CallToolResult::success(vec![ContentBlock::image(
                base64::engine::general_purpose::STANDARD.encode(bytes),
                "image/png",
            )]),
            // Same error shape as the other tools: {"code", "message"} for core errors.
            Err(e) => {
                CallToolResult::error(vec![ContentBlock::text(match e.downcast::<Error>() {
                    Ok(core) => err(core),
                    Err(other) => {
                        serde_json::json!({ "code": "invalid", "message": other.to_string() })
                            .to_string()
                    }
                })])
            }
        })
    }

    #[tool(
        description = "Remove a bookmark (the file itself is untouched). Returns the new list. Applied directly, never reviewed; refused (code denied) when you are restricted to certain folders without `bookmarks:`."
    )]
    async fn remove_bookmark(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws()
            .files
            .remove_bookmark(&a.path)
            .map_err(err)
            .and_then(ok)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MosaicMcp {
    /// Every tool is listed even without a vault, so clients connect and the agent learns why
    /// calls fail (`no_vault`). `vault_guide` needs no vault.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name != "vault_guide" && self.open_vault(&context.peer).await.is_none() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(self.no_vault())]).into());
        }
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }

    /// Every note as an MCP resource (`mosaic:///Folder/Note.md`), so clients can attach notes as
    /// context without a tool call. Hidden folders (Settings › AI) are left out.
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        if self.open_vault(&context.peer).await.is_none() {
            return Ok(ListResourcesResult::with_all_items(vec![]));
        }
        let entries = self
            .ws()
            .files
            .list("", true)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let resources = entries
            .into_iter()
            .filter(|e| !e.is_dir && e.path.to_lowercase().ends_with(".md"))
            .take(MAX_RESOURCES)
            .map(|e| {
                let title = e.name.strip_suffix(".md").unwrap_or(&e.name).to_string();
                Resource::new(resource_uri(&e.path), e.path.clone())
                    .with_title(title)
                    .with_mime_type("text/markdown")
                    .with_size(e.size)
            })
            .collect();
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if self.open_vault(&context.peer).await.is_none() {
            return Err(ErrorData::resource_not_found(self.no_vault(), None));
        }
        let path = resource_path(&request.uri).ok_or_else(|| {
            ErrorData::invalid_params(format!("not a Mosaic note URI: {}", request.uri), None)
        })?;
        let file = self
            .ws()
            .files
            .read(&path)
            .map_err(|e| ErrorData::resource_not_found(e.to_string(), None))?;
        let text = file
            .content
            .ok_or_else(|| ErrorData::invalid_params(format!("{path} isn't a text file"), None))?;
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(text, request.uri).with_mime_type("text/markdown"),
        ])
        .into())
    }

    /// Every agent in `Agents/` as a prompt: in Claude Code, `/mosaic:<name>` starts it.
    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        if self.open_vault(&context.peer).await.is_none() {
            return Ok(ListPromptsResult::with_all_items(vec![]));
        }
        let agents = self
            .ws()
            .agents()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let prompts = agents
            .into_iter()
            .map(|a| {
                let mut arg = PromptArgument::new("request");
                arg.description = Some("Anything to add for this run (optional)".into());
                arg.required = Some(false);
                let mut p = Prompt::new(a.name, Some(a.description), Some(vec![arg]));
                p.title = Some(a.title);
                p
            })
            .collect();
        Ok(ListPromptsResult::with_all_items(prompts))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        if self.open_vault(&context.peer).await.is_none() {
            return Err(ErrorData::invalid_params(self.no_vault(), None));
        }
        let agent = self
            .ws()
            .agent(&request.name)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        let extra = request
            .arguments
            .as_ref()
            .and_then(|a| a.get("request"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let text = mosaic_core::agents::agent_prompt(&agent, extra.as_deref());
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description(agent.description)
                .into(),
        )
    }

    /// Remembers the client's name (e.g. "claude-code") for the file history and activity log.
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        let name = request.client_info.name.clone();
        // A vault opened later picks the name up in `workspace()`.
        if let Some(ws) = self.workspace() {
            ws.set_actor(&name);
        }
        *self.actor.write().unwrap_or_else(|p| p.into_inner()) = Some(name);
        context.peer.set_peer_info(request.clone());
        self.negotiate_initialize(&request)
    }

    fn get_info(&self) -> ServerConfig {
        let root = self
            .workspace()
            .map(|ws| ws.vault.root().display().to_string());
        let which = match (self.mode, root) {
            (VaultMode::FollowApp, Some(root)) => format!(
                "the vault open in the Mosaic app (now {root}; it follows when the human switches vaults)"
            ),
            (VaultMode::FollowApp, None) => "the vault open in the Mosaic app (none is open yet: until the human opens one, tools explain what to do)".to_string(),
            (VaultMode::Pinned, Some(root)) => format!("the Mosaic vault at {root}"),
            (VaultMode::Pinned, None) => format!(
                "the Mosaic vault at {} (it can't be opened now: tools explain what to do)",
                self.pinned.as_deref().unwrap_or(std::path::Path::new("?")).display()
            ),
        };
        ServerConfig::new(ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_list_changed()
                .enable_prompts()
                .enable_prompts_list_changed()
                .build())
            .with_server_info(Implementation::new("mosaic", env!("CARGO_PKG_VERSION")))
            .with_instructions(format!(
                "{}Tools for {which}: an Obsidian-compatible folder of Markdown notes, canvases, charts and diagrams that a human reads in the Mosaic app. Call vault_guide once for the conventions. Use vault-relative paths; read (or outline) before editing, prefer patch_file, and pass expected_hash to avoid overwriting the human's edits.",
                self.mismatch_note().unwrap_or_default()
            ))
    }
}

/// Serves even when no vault can be opened (`ws` is `None`): a client that can't complete the
/// handshake only reports "failed to connect", while tools can tell the agent what's wrong.
pub async fn serve(
    ws: Option<Workspace>,
    mode: VaultMode,
    pinned: Option<PathBuf>,
    may_change: Option<Vec<String>>,
) -> anyhow::Result<()> {
    let service = MosaicMcp::new(ws, mode, pinned, may_change)
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
