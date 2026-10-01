//! MCP server over stdio: one typed tool per core operation. Tool errors are returned as tool results
//! (`is_error`) with a stable code, so the model can recover (e.g. re-read after a `conflict`).

use mosaic_core::{Error, Workspace};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
struct CopyArgs {
    /// Vault-relative path of the file to copy.
    from: String,
    /// Vault-relative path of the new copy. Must not exist yet.
    to: String,
}

#[derive(Clone)]
pub struct MosaicMcp {
    ws: Arc<Workspace>,
    tool_router: ToolRouter<Self>,
}

#[tool_router(router = tool_router)]
impl MosaicMcp {
    pub fn new(ws: Workspace) -> Self {
        Self {
            ws: Arc::new(ws),
            tool_router: Self::tool_router(),
        }
    }

    /// Picks up changes made by the app or other tools before answering index-backed questions.
    fn fresh(&self) {
        let _ = self.ws.sync(|_, _| {});
    }

    #[tool(
        description = "Explain the vault's conventions: link syntax, frontmatter, canvases, charts, diagrams and editing rules. Read this once before editing."
    )]
    async fn vault_guide(&self) -> String {
        crate::AGENT_GUIDE.to_string()
    }

    #[tool(
        description = "List files and folders (vault-relative paths, kind, size, modified time)."
    )]
    async fn list_files(&self, Parameters(a): Parameters<ListArgs>) -> ToolResult {
        self.ws.list(&a.dir, a.recursive).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Read a file. Returns its content (null for binary files) and a hash to pass as expected_hash when editing."
    )]
    async fn read_file(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws.read(&a.path).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Cheap overview of a file: title, frontmatter, tags, headings, outgoing links (resolved) and backlinks. Use before reading large notes."
    )]
    async fn outline(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.fresh();
        self.ws.outline(&a.path).map_err(err).and_then(ok)
    }

    #[tool(
        description = "Full-text search over file names, titles and contents. Returns paths, titles and snippets with matches in **bold**."
    )]
    async fn search(&self, Parameters(a): Parameters<SearchArgs>) -> ToolResult {
        self.fresh();
        self.ws
            .search(&a.query, a.limit.unwrap_or(20))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Create a new file (fails if it exists). Use .md for notes, .canvas for boards, .vl.json for charts, .dot for graphs."
    )]
    async fn create_file(&self, Parameters(a): Parameters<CreateArgs>) -> ToolResult {
        self.ws
            .create(&a.path, &a.content)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Replace the whole content of a file (creates it if missing). Prefer patch_file for small changes."
    )]
    async fn edit_file(&self, Parameters(a): Parameters<EditArgs>) -> ToolResult {
        self.ws
            .write(&a.path, &a.content, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Replace one exact, unique snippet of a text file. The safest way to make a targeted edit."
    )]
    async fn patch_file(&self, Parameters(a): Parameters<PatchArgs>) -> ToolResult {
        self.ws
            .patch(&a.path, &a.find, &a.replace, a.expected_hash.as_deref())
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Append text to the end of a file (created if missing). Good for logs and journals."
    )]
    async fn append_to_file(&self, Parameters(a): Parameters<AppendArgs>) -> ToolResult {
        self.ws
            .append(&a.path, &a.content)
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Move or rename a file or folder. Links in other notes are updated to follow it."
    )]
    async fn rename(&self, Parameters(a): Parameters<RenameArgs>) -> ToolResult {
        self.fresh();
        self.ws
            .rename(&a.from, &a.to, a.update_links.unwrap_or(true))
            .map_err(err)
            .and_then(ok)
    }

    #[tool(
        description = "Duplicate a file (any kind, including binary). Never overwrites: fails if `to` exists."
    )]
    async fn copy_file(&self, Parameters(a): Parameters<CopyArgs>) -> ToolResult {
        self.ws.copy(&a.from, &a.to).map_err(err).and_then(ok)
    }

    #[tool(description = "Move a file or folder to the macOS Trash (recoverable).")]
    async fn delete_file(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws
            .delete(&a.path)
            .map_err(err)
            .and_then(|_| ok(serde_json::json!({ "deleted": a.path })))
    }

    #[tool(description = "Create a folder (and any missing parents).")]
    async fn create_folder(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws
            .mkdir(&a.path)
            .map_err(err)
            .and_then(|_| ok(serde_json::json!({ "created": a.path })))
    }

    #[tool(description = "Notes and canvases that link to or embed a file, with the linking line.")]
    async fn get_backlinks(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.fresh();
        self.ws.backlinks(&a.path).map_err(err).and_then(ok)
    }

    #[tool(description = "All tags used in the vault with how many files carry each.")]
    async fn list_tags(&self) -> ToolResult {
        self.fresh();
        self.ws.tags().map_err(err).and_then(ok)
    }

    #[tool(
        description = "The human's bookmarked files and folders, in their order. `exists` is false for a bookmark whose file is gone."
    )]
    async fn list_bookmarks(&self) -> ToolResult {
        ok(self.ws.bookmarks())
    }

    #[tool(
        description = "Bookmark a file or folder so the human finds it in the app's Bookmarks panel (added at the end). Returns the new list."
    )]
    async fn add_bookmark(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws.add_bookmark(&a.path).map_err(err).and_then(ok)
    }

    #[tool(description = "Remove a bookmark (the file itself is untouched). Returns the new list.")]
    async fn remove_bookmark(&self, Parameters(a): Parameters<PathArg>) -> ToolResult {
        self.ws.remove_bookmark(&a.path).map_err(err).and_then(ok)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MosaicMcp {
    fn get_info(&self) -> ServerConfig {
        let root = self.ws.vault.root().display().to_string();
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("mosaic", env!("CARGO_PKG_VERSION")))
            .with_instructions(format!(
                "Tools for the Mosaic vault at {root}: an Obsidian-compatible folder of Markdown notes, canvases, charts and diagrams that a human reads in the Mosaic app. Call vault_guide once for the conventions. Use vault-relative paths; read (or outline) before editing, prefer patch_file, and pass expected_hash to avoid overwriting the human's edits."
            ))
    }
}

pub async fn serve(ws: Workspace) -> anyhow::Result<()> {
    let service = MosaicMcp::new(ws).serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
