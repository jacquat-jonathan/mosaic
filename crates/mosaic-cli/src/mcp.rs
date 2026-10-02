//! MCP server over stdio: one typed tool per core operation. Tool errors are returned as tool results
//! (`is_error`) with a stable code, so the model can recover (e.g. re-read after a `conflict`).

use base64::Engine;
use mosaic_core::settings::Settings;
use mosaic_core::{Error, Workspace};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, InitializeRequestParams, InitializeResult,
    ListResourcesResult, PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse,
    ReadResourceResult, Resource, ResourceContents, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

type ToolResult = Result<String, String>;

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
struct CreateArgs {
    /// Vault-relative path of the new file, including its extension (`.md`, `.canvas`, …).
    path: String,
    /// Full content of the new file.
    #[serde(default)]
    content: String,
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
    ws: Arc<RwLock<Arc<Workspace>>>,
    mode: VaultMode,
    /// The MCP client's name, recorded with every change in the file history.
    actor: Arc<RwLock<Option<String>>>,
    tool_router: ToolRouter<Self>,
}

/// The vault the app has open (the last one it opened), if it still exists.
fn app_vault() -> Option<PathBuf> {
    Settings::load().last_vault.filter(|p| p.is_dir())
}

#[tool_router(router = tool_router)]
impl MosaicMcp {
    pub fn new(ws: Workspace, mode: VaultMode) -> Self {
        Self {
            ws: Arc::new(RwLock::new(Arc::new(ws))),
            mode,
            actor: Arc::new(RwLock::new(None)),
            tool_router: Self::tool_router(),
        }
    }

    /// The workspace for this call. In follow mode, switches first if the app opened another vault.
    fn ws(&self) -> Arc<Workspace> {
        let current = self.ws.read().unwrap_or_else(|p| p.into_inner()).clone();
        if self.mode == VaultMode::FollowApp
            && let Some(root) = app_vault()
            && root != current.vault.root()
            && let Ok(next) = Workspace::open(&root)
        {
            let next = Arc::new(
                next.validating()
                    .with_source(mosaic_core::history::Source::Agent),
            );
            if let Some(name) = self
                .actor
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .as_deref()
            {
                next.set_actor(name);
            }
            let _ = next.sync(|_, _| {});
            *self.ws.write().unwrap_or_else(|p| p.into_inner()) = next.clone();
            return next;
        }
        current
    }

    /// A warning when a pinned vault isn't the one the human is looking at in the app.
    fn mismatch_note(&self) -> Option<String> {
        if self.mode != VaultMode::Pinned {
            return None;
        }
        let root = self.ws().vault.root().to_path_buf();
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
    fn fresh(&self) {
        let _ = self.ws().sync(|_, _| {});
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
            .list(&a.dir, a.recursive)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Read a file. Returns its content (null for binary files) and a hash to pass as expected_hash when editing."
    )]
    async fn read_file(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws().read(&a.path).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Cheap overview of a file: title, frontmatter, tags, headings, outgoing links (resolved) and backlinks. Use before reading large notes."
    )]
    async fn outline(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.fresh();
        self.ws().outline(&a.path).map_err(err).and_then(ok)
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
        description = "Create a new file (fails if it exists). Use .md for notes, .canvas for boards, .vl.json for charts, .dot for graphs."
    )]
    async fn create_file(&self, Parameters(a): Parameters<CreateArgs>) -> ToolResult {
        self.ws()
            .create(&a.path, &a.content)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Replace the whole content of a file (creates it if missing). Prefer patch_file for small changes."
    )]
    async fn edit_file(&self, Parameters(a): Parameters<EditArgs>) -> ToolResult {
        self.ws()
            .write(&a.path, &a.content, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Replace one exact, unique snippet of a text file. The safest way to make a targeted edit."
    )]
    async fn patch_file(&self, Parameters(a): Parameters<PatchArgs>) -> ToolResult {
        self.ws()
            .patch(&a.path, &a.find, &a.replace, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Append text to the end of a file (created if missing). Good for logs and journals."
    )]
    async fn append_to_file(&self, Parameters(a): Parameters<AppendArgs>) -> ToolResult {
        self.ws()
            .append(&a.path, &a.content)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move or rename a file or folder. Links in other notes are updated to follow it."
    )]
    async fn rename(&self, Parameters(a): Parameters<RenameArgs>) -> ToolResult {
        self.fresh();
        self.ws()
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
        self.ws().import(&a.path, &bytes).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Duplicate a file (any kind, including binary). Never overwrites: fails if `to` exists."
    )]
    async fn copy_file(&self, Parameters(a): Parameters<CopyArgs>) -> ToolResult {
        self.ws().copy(&a.from, &a.to).map_err(err).and_then(ok)
    }

    #[tool(description = "Move a file or folder to the macOS Trash (recoverable).")]
    async fn delete_file(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws()
            .delete(&a.path)
            .map_err(err)
            .and_then(|_| ok(serde_json::json!({ "deleted": a.path })))
    }

    #[tool(description = "Create a folder (and any missing parents).")]
    async fn create_folder(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws()
            .mkdir(&a.path)
            .map_err(err)
            .and_then(|_| ok(serde_json::json!({ "created": a.path })))
    }

    #[tool(description = "Notes and canvases that link to or embed a file, with the linking line.")]
    async fn get_backlinks(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.fresh();
        self.ws().backlinks(&a.path).map_err(err).and_then(ok)
    }

    #[tool(description = "All tags used in the vault with how many files carry each.")]
    async fn list_tags(&self) -> ToolResult {
        self.fresh();
        self.ws().tags().map_err(err).and_then(ok)
    }

    #[tool(
        description = "The human's bookmarked files and folders, in their order. `exists` is false for a bookmark whose file is gone."
    )]
    async fn list_bookmarks(&self) -> ToolResult {
        ok(self.ws().bookmarks())
    }

    #[tool(
        description = "Bookmark a file or folder so the human finds it in the app's Bookmarks panel (added at the end). Returns the new list."
    )]
    async fn add_bookmark(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws().add_bookmark(&a.path).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Versions of a file that Mosaic kept (newest first): who changed it (app, cli, agent, external), when and how. Use restore_version to go back to one."
    )]
    async fn file_history(&self, Parameters(a): Parameters<HistoryArgs>) -> ToolResult {
        self.ws()
            .history(&a.path, a.limit.unwrap_or(20))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Put a file back to one of its versions from file_history (also brings back a deleted file). Use it to undo your own mistake."
    )]
    async fn restore_version(&self, Parameters(a): Parameters<RestoreArgs>) -> ToolResult {
        self.ws()
            .restore(&a.path, a.id, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(ok)
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

    #[tool(description = "Remove a bookmark (the file itself is untouched). Returns the new list.")]
    async fn remove_bookmark(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws().remove_bookmark(&a.path).map_err(err).and_then(ok)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MosaicMcp {
    /// Every note as an MCP resource (`mosaic:///Folder/Note.md`), so clients can attach notes as
    /// context without a tool call. Hidden folders (Settings › AI) are left out.
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let entries = self
            .ws()
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
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let path = resource_path(&request.uri).ok_or_else(|| {
            ErrorData::invalid_params(format!("not a Mosaic note URI: {}", request.uri), None)
        })?;
        let file = self
            .ws()
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

    /// Remembers the client's name (e.g. "claude-code") for the file history and activity log.
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        let name = request.client_info.name.clone();
        self.ws().set_actor(&name);
        *self.actor.write().unwrap_or_else(|p| p.into_inner()) = Some(name);
        context.peer.set_peer_info(request.clone());
        self.negotiate_initialize(&request)
    }

    fn get_info(&self) -> ServerConfig {
        let root = self.ws().vault.root().display().to_string();
        let which = match self.mode {
            VaultMode::FollowApp => format!(
                "the vault open in the Mosaic app (now {root}; it follows when the human switches vaults)"
            ),
            VaultMode::Pinned => format!("the Mosaic vault at {root}"),
        };
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new("mosaic", env!("CARGO_PKG_VERSION")))
            .with_instructions(format!(
                "{}Tools for {which}: an Obsidian-compatible folder of Markdown notes, canvases, charts and diagrams that a human reads in the Mosaic app. Call vault_guide once for the conventions. Use vault-relative paths; read (or outline) before editing, prefer patch_file, and pass expected_hash to avoid overwriting the human's edits.",
                self.mismatch_note().unwrap_or_default()
            ))
    }
}

pub async fn serve(ws: Workspace, mode: VaultMode) -> anyhow::Result<()> {
    let service = MosaicMcp::new(ws, mode)
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
