//! `mosaic`: command-line access to a Mosaic vault for people, scripts and AI agents, and
//! `mosaic mcp` — the same operations as an MCP server over stdio.

mod mcp;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use mosaic_core::settings::Settings;
use mosaic_core::{Error, Workspace};
use serde::Serialize;
use std::io::{IsTerminal, Read};
use std::path::PathBuf;

pub const AGENT_GUIDE: &str = include_str!("../../../docs/AGENTS.md");

#[derive(Parser)]
#[command(
    name = "mosaic",
    version,
    about = "Read, search and edit a Mosaic (Obsidian-compatible) vault."
)]
struct Cli {
    /// Vault folder. Defaults to $MOSAIC_VAULT, then the vault last opened in the Mosaic app.
    #[arg(long, global = true, env = "MOSAIC_VAULT")]
    vault: Option<PathBuf>,
    /// Print machine-readable JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List files and folders.
    List {
        #[arg(default_value = "")]
        dir: String,
        /// Include everything below `dir`.
        #[arg(short, long)]
        recursive: bool,
    },
    /// Print a file's content.
    Read { path: String },
    /// Full-text search (supports "phrases", tag:name and path:folder).
    Search {
        query: Vec<String>,
        #[arg(short, long, default_value_t = 20)]
        limit: usize,
    },
    /// Create a new file; content from --content or stdin.
    Create {
        path: String,
        #[arg(short, long)]
        content: Option<String>,
    },
    /// Replace a file's content; content from --content or stdin.
    Write {
        path: String,
        #[arg(short, long)]
        content: Option<String>,
        /// Refuse if the file changed since you read this hash.
        #[arg(long)]
        expected_hash: Option<String>,
    },
    /// Append text to a file (created if missing).
    Append {
        path: String,
        #[arg(short, long)]
        content: Option<String>,
    },
    /// Replace one exact, unique occurrence of text.
    Patch {
        path: String,
        #[arg(long)]
        find: String,
        #[arg(long)]
        replace: String,
        #[arg(long)]
        expected_hash: Option<String>,
    },
    /// Move or rename a file or folder; links to it are updated.
    Rename {
        from: String,
        to: String,
        /// Don't rewrite links in other notes.
        #[arg(long)]
        no_update_links: bool,
    },
    /// List bookmarks, or add/remove one (bookmarks show in the app's Bookmarks panel).
    Bookmarks {
        #[command(subcommand)]
        action: Option<BookmarkCmd>,
    },
    /// Duplicate a file; never overwrites an existing one.
    Copy { from: String, to: String },
    /// Move a file or folder to the macOS Trash.
    Delete { path: String },
    /// Create a folder.
    Mkdir { path: String },
    /// Notes linking to a file.
    Backlinks { path: String },
    /// All tags with counts.
    Tags,
    /// Title, headings, frontmatter, links and backlinks of a file.
    Outline { path: String },
    /// Print the guide for AI agents working with this vault.
    Guide,
    /// Run as an MCP server over stdio (for Claude Code, Claude Desktop, …).
    Mcp,
}

#[derive(Subcommand)]
enum BookmarkCmd {
    /// Bookmark a file or folder (added at the end).
    Add { path: String },
    /// Remove a bookmark; the file itself is untouched.
    Remove { path: String },
}

fn vault_path(flag: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = flag {
        return Ok(p);
    }
    match Settings::load().last_vault {
        Some(p) if p.is_dir() => Ok(p),
        _ => bail!(
            "no vault given: pass --vault <folder>, set MOSAIC_VAULT, or open a vault in the Mosaic app once"
        ),
    }
}

fn content_arg(content: Option<String>) -> Result<String> {
    if let Some(c) = content {
        return Ok(c);
    }
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        bail!("pass --content or pipe the content on stdin");
    }
    let mut s = String::new();
    stdin.read_to_string(&mut s)?;
    Ok(s)
}

fn print<T: Serialize>(json: bool, value: &T, human: impl FnOnce(&T) -> String) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        let s = human(value);
        if !s.is_empty() {
            println!("{s}");
        }
    }
    Ok(())
}

fn main() {
    let cli = Cli::parse();
    let json = cli.json;
    if let Err(e) = run(cli) {
        if json {
            let body = match e.downcast_ref::<Error>() {
                Some(core) => serde_json::to_value(core).unwrap_or_default(),
                None => serde_json::json!({ "code": "error", "message": e.to_string() }),
            };
            eprintln!("{body}");
        } else {
            eprintln!("mosaic: {e:#}");
        }
        std::process::exit(match e.downcast_ref::<Error>() {
            Some(Error::NotFound(_)) => 2,
            Some(Error::Conflict { .. }) => 3,
            _ => 1,
        });
    }
}

fn run(cli: Cli) -> Result<()> {
    if matches!(cli.cmd, Cmd::Guide) {
        print!("{AGENT_GUIDE}");
        return Ok(());
    }
    let root = vault_path(cli.vault)?;
    let ws = Workspace::open(&root).with_context(|| format!("opening vault {}", root.display()))?;
    let json = cli.json;
    // The index is shared with the app (WAL); an incremental sync is fast and keeps results current.
    let needs_index = matches!(
        cli.cmd,
        Cmd::Search { .. }
            | Cmd::Backlinks { .. }
            | Cmd::Tags
            | Cmd::Outline { .. }
            | Cmd::Rename { .. }
            | Cmd::Mcp
    );
    if needs_index {
        ws.sync(|_, _| {})?;
    }
    match cli.cmd {
        Cmd::List { dir, recursive } => print(json, &ws.list(&dir, recursive)?, |entries| {
            entries
                .iter()
                .map(|e| {
                    if e.is_dir {
                        format!("{}/", e.path)
                    } else {
                        e.path.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        Cmd::Read { path } => {
            let f = ws.read(&path)?;
            print(json, &f, |f| match &f.content {
                Some(c) => c.trim_end_matches('\n').to_string(),
                None => format!(
                    "({:?} file, {} bytes — binary content not shown)",
                    f.kind, f.size
                ),
            })
        }
        Cmd::Search { query, limit } => print(json, &ws.search(&query.join(" "), limit)?, |hits| {
            hits.iter()
                .map(|h| format!("{}\n    {}", h.path, h.snippet.replace('\n', " ")))
                .collect::<Vec<_>>()
                .join("\n")
        }),
        Cmd::Create { path, content } => {
            let w = ws.create(&path, &content_arg(content)?)?;
            print(json, &w, |w| format!("created {}", w.path))
        }
        Cmd::Write {
            path,
            content,
            expected_hash,
        } => {
            let w = ws.write(&path, &content_arg(content)?, expected_hash.as_deref())?;
            print(json, &w, |w| format!("wrote {}", w.path))
        }
        Cmd::Append { path, content } => {
            let w = ws.append(&path, &content_arg(content)?)?;
            print(json, &w, |w| format!("appended to {}", w.path))
        }
        Cmd::Patch {
            path,
            find,
            replace,
            expected_hash,
        } => {
            let w = ws.patch(&path, &find, &replace, expected_hash.as_deref())?;
            print(json, &w, |w| format!("patched {}", w.path))
        }
        Cmd::Rename {
            from,
            to,
            no_update_links,
        } => {
            let r = ws.rename(&from, &to, !no_update_links)?;
            print(json, &r, |r| {
                let mut s = format!("renamed to {}", r.path);
                if !r.updated_links_in.is_empty() {
                    s.push_str(&format!(
                        "\nupdated links in: {}",
                        r.updated_links_in.join(", ")
                    ));
                }
                s
            })
        }
        Cmd::Bookmarks { action } => {
            let list = match action {
                None => ws.bookmarks(),
                Some(BookmarkCmd::Add { path }) => ws.add_bookmark(&path)?,
                Some(BookmarkCmd::Remove { path }) => ws.remove_bookmark(&path)?,
            };
            print(json, &list, |list| {
                list.iter()
                    .map(|b| {
                        if b.exists {
                            b.path.clone()
                        } else {
                            format!("{}  (missing)", b.path)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
        Cmd::Copy { from, to } => {
            let w = ws.copy(&from, &to)?;
            print(json, &w, |w| format!("copied to {}", w.path))
        }
        Cmd::Delete { path } => {
            ws.delete(&path)?;
            print(json, &serde_json::json!({ "deleted": path }), |_| {
                format!("moved {path} to the Trash")
            })
        }
        Cmd::Mkdir { path } => {
            ws.mkdir(&path)?;
            print(json, &serde_json::json!({ "created": path }), |_| {
                format!("created folder {path}")
            })
        }
        Cmd::Backlinks { path } => print(json, &ws.backlinks(&path)?, |bs| {
            bs.iter()
                .map(|b| {
                    if b.line == 0 {
                        format!("{}  (canvas)", b.source)
                    } else {
                        format!("{}:{}  {}", b.source, b.line, b.context)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        Cmd::Tags => print(json, &ws.tags()?, |tags| {
            tags.iter()
                .map(|t| format!("#{}  {}", t.tag, t.count))
                .collect::<Vec<_>>()
                .join("\n")
        }),
        Cmd::Outline { path } => print(json, &ws.outline(&path)?, |o| {
            serde_json::to_string_pretty(o).unwrap_or_default()
        }),
        Cmd::Guide => unreachable!(),
        Cmd::Mcp => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            rt.block_on(mcp::serve(ws))
        }
    }
}
