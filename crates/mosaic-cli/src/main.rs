//! `mosaic`: command-line access to a Mosaic vault for people, scripts and AI agents, and
//! `mosaic mcp` — the same operations as an MCP server over stdio.

mod mcp;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use mosaic_core::history::Source;
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
    /// Vault folder. Defaults to $MOSAIC_VAULT, then the vault open in the Mosaic app (which `mosaic mcp`
    /// keeps following when the app switches vaults).
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
    /// Versions of a file kept by Mosaic, newest first.
    History {
        path: String,
        #[arg(short, long, default_value_t = 20)]
        limit: usize,
    },
    /// Put a file back to one of its versions (an id from `history`).
    Restore {
        path: String,
        id: i64,
        #[arg(long)]
        expected_hash: Option<String>,
    },
    /// Changes made by AI agents and the command line, newest first.
    Activity {
        #[arg(short, long, default_value_t = 30)]
        limit: usize,
    },
    /// Undo one change from `activity` (refused if the file changed again since).
    Undo { id: i64 },
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

/// `12  2026-10-02 14:03  edited  agent (claude-code)  Notes/Plan.md`
fn version_line(v: &mosaic_core::history::Version) -> String {
    let time = chrono_like(v.time);
    let who = match &v.actor {
        Some(a) => format!("{} ({a})", v.source),
        None => v.source.clone(),
    };
    let what = match &v.from_path {
        Some(from) => format!("{from} → {}", v.path),
        None => v.path.clone(),
    };
    format!("{:>6}  {time}  {:<8}  {who:<22}  {what}", v.id, v.action)
}

/// "just now", "5 min ago", "3 h ago", then "2026-10-02 14:03 UTC" (no date crate needed).
fn chrono_like(ms: i64) -> String {
    let ago = (mosaic_core::history::now_ms() - ms) / 1000;
    match ago {
        i64::MIN..60 => "just now".into(),
        60..3600 => format!("{} min ago", ago / 60),
        3600..86400 => format!("{} h ago", ago / 3600),
        _ => {
            // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
            let secs = ms / 1000;
            let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = yoe + era * 400 + i64::from(m <= 2);
            format!(
                "{y}-{m:02}-{d:02} {:02}:{:02} UTC",
                rem / 3600,
                rem % 3600 / 60
            )
        }
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
    let mode = if cli.vault.is_some() {
        mcp::VaultMode::Pinned
    } else {
        mcp::VaultMode::FollowApp
    };
    let root = vault_path(cli.vault)?;
    let source = if matches!(cli.cmd, Cmd::Mcp) {
        Source::Agent
    } else {
        Source::Cli
    };
    let ws = Workspace::open(&root)
        .with_context(|| format!("opening vault {}", root.display()))?
        .validating()
        .with_source(source);
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
                        // Canvases and drawings have no line numbers.
                        format!("{}  {}", b.source, b.context)
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
        Cmd::History { path, limit } => print(json, &ws.history(&path, limit)?, |vs| {
            vs.iter().map(version_line).collect::<Vec<_>>().join("\n")
        }),
        Cmd::Restore {
            path,
            id,
            expected_hash,
        } => {
            let w = ws.restore(&path, id, expected_hash.as_deref())?;
            print(json, &w, |w| {
                format!("restored {} ({})", w.path, &w.hash[..12])
            })
        }
        Cmd::Activity { limit } => print(json, &ws.activity(limit)?, |vs| {
            vs.iter().map(version_line).collect::<Vec<_>>().join("\n")
        }),
        Cmd::Undo { id } => {
            let path = ws.undo(id)?;
            print(json, &path, |p| format!("undone: {p}"))
        }
        Cmd::Guide => unreachable!(),
        Cmd::Mcp => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            rt.block_on(mcp::serve(ws, mode))
        }
    }
}
