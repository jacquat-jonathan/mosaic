//! `mosaic`: command-line access to a Mosaic vault for people, scripts and AI agents, and
//! `mosaic mcp` — the same operations as an MCP server over stdio.

mod mcp;
mod png;

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
    /// Restrict direct writes to these vault paths; writes elsewhere become review proposals.
    /// Used by Mosaic for scheduled agents.
    #[arg(long, global = true, hide = true)]
    may_change: Vec<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Discover templates and the default for a destination note.
    Templates {
        #[arg(long = "for")]
        path: Option<String>,
    },
    /// Preview a note template without writing.
    Template {
        #[command(subcommand)]
        action: TemplateCmd,
    },
    /// Create a note using a folder default, chosen template or Blank.
    Note {
        #[command(subcommand)]
        action: NoteCmd,
    },
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
    /// Notes matching a structured query, e.g. `tag:project status=active due<today+7 sort:due`.
    /// Filters: tag:, folder:, kind:, links-to:, linked-from:, has: (prefix - to negate); field=value,
    /// != > >= < <= ~ (contains) on frontmatter fields, title, name, folder, tags, modified; a|b for
    /// either; today, today-7 as dates. Uppercase OR separates alternative groups. Also sort:field / sort:-field, limit:N, show:a,b, and words
    /// for full-text search. `task:open` (done, moved, cancelled, all) lists checkbox tasks instead,
    /// with their own fields text, status, due (📅 date) and line, e.g. `task:open folder:Daily`.
    Query { query: Vec<String> },
    /// Tasks by day, as the calendar shows them: each day's daily note tasks plus tasks due that
    /// day (📅 date), and overdue ones. Dates as 2026-10-04; default today and the next 6 days.
    Days {
        from: Option<String>,
        to: Option<String>,
    },
    /// Move the unfinished tasks of the last daily note before a day (default today) into that
    /// day's note; the old note keeps them as `- [>]`.
    CarryOver { day: Option<String> },
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
    /// Move files and folders into a folder (created if missing); links follow.
    Move {
        paths: Vec<String>,
        /// Destination folder ("" for the vault root).
        #[arg(long)]
        to: String,
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
    /// Draw a canvas as a picture: PNG (default) or SVG, chosen by the -o extension.
    Render {
        path: String,
        /// Output file (.png or .svg). Default: the canvas name with .png, in the current folder.
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Dark theme.
        #[arg(long)]
        dark: bool,
    },
    /// Changes waiting for the person's review (folders under review in Settings › AI), and the
    /// decisions on recent ones.
    Proposals {
        #[arg(short, long, default_value_t = 30)]
        limit: usize,
    },
    /// Take back one of your pending proposals (an id from `proposals`).
    Withdraw { id: i64 },
    /// Changes made by AI agents and the command line, newest first.
    Activity {
        #[arg(short, long, default_value_t = 30)]
        limit: usize,
    },
    /// Undo one change from `activity` (refused if the file changed again since).
    Undo { id: i64 },
    /// The vault's agents (files in `Agents/`). With --sync, also mirror them into the vault's
    /// `.claude/skills/` so Claude Code started in the vault knows them as skills.
    Agents {
        #[arg(long)]
        sync: bool,
    },
    /// Print the guide for AI agents working with this vault.
    Guide,
    /// Read this vault's shared preferences (configured by the person in Settings).
    Preferences,
    #[command(hide = true)]
    SwapApps { staged: PathBuf, installed: PathBuf },
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

/// A vault file drawn as SVG: canvases, or SVG images as they are.
pub fn render_file(ws: &Workspace, path: &str, dark: bool) -> Result<String> {
    let file = ws.read(path)?;
    let text = file
        .content
        .ok_or_else(|| anyhow::anyhow!("{path} isn't a text file"))?;
    let lower = path.to_lowercase();
    if lower.ends_with(".canvas") {
        Ok(mosaic_core::render::canvas_to_svg(&text, dark)?)
    } else if lower.ends_with(".svg") {
        Ok(text)
    } else {
        bail!("render draws canvases (.canvas) and SVG images for now; {path} is neither")
    }
}

#[derive(clap::Args)]
struct NoteArgs {
    path: String,
    #[arg(long, conflicts_with = "blank")]
    template: Option<String>,
    #[arg(long)]
    blank: bool,
    /// Reuse a preview's RFC3339 creation timestamp.
    #[arg(long)]
    timestamp: Option<String>,
    #[arg(long)]
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
#[derive(Subcommand)]
enum TemplateCmd {
    Render(NoteArgs),
}
#[derive(Subcommand)]
enum NoteCmd {
    Create(NoteArgs),
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

/// "wrote Notes/Plan.md", or, in a folder under review, that the change waits for the person.
fn done(w: &mosaic_core::Written, verb: &str) -> String {
    match w.review {
        Some(id) => format!(
            "proposed: {verb} {} is waiting for the person's review in the Mosaic app (proposal {id})",
            w.path
        ),
        None => format!("{verb} {}", w.path),
    }
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
    if let Cmd::SwapApps { staged, installed } = &cli.cmd {
        mosaic_core::app_install::swap_apps(staged, installed)?;
        return Ok(());
    }
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
    let mut ws = Workspace::open(&root)
        .with_context(|| format!("opening vault {}", root.display()))?
        .validating()
        .with_source(source);
    if !cli.may_change.is_empty() {
        ws = ws.with_change_allowlist(cli.may_change.clone());
    }
    let json = cli.json;
    // The index is shared with the app (WAL); an incremental sync is fast and keeps results current.
    let needs_index = matches!(
        cli.cmd,
        Cmd::Search { .. }
            | Cmd::Query { .. }
            | Cmd::Days { .. }
            | Cmd::CarryOver { .. }
            | Cmd::Backlinks { .. }
            | Cmd::Tags
            | Cmd::Outline { .. }
            | Cmd::Rename { .. }
            | Cmd::Move { .. }
            | Cmd::Mcp
    );
    if needs_index {
        ws.sync(|_, _| {})?;
    }
    match cli.cmd {
        Cmd::Templates { path } => print(json, &ws.list_templates(path.as_deref())?, |v| {
            let mut lines: Vec<String> = v.templates.iter().map(|t| t.path.clone()).collect();
            if path.is_some() {
                lines.push(format!(
                    "Default: {}",
                    v.default.template.as_deref().unwrap_or("Blank")
                ));
            }
            lines.join("\n")
        }),
        Cmd::Template {
            action: TemplateCmd::Render(a),
        } => print(json, &ws.render_template(&a.into())?, |p| p.content.clone()),
        Cmd::Note {
            action: NoteCmd::Create(a),
        } => print(json, &ws.create_note(&a.into())?, |n| {
            done(&n.written, "created")
        }),
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
        Cmd::Query { query } => print(json, &ws.query(&query.join(" "))?, |r| {
            let mut lines: Vec<String> = r
                .rows
                .iter()
                .map(|row| {
                    let cells: Vec<String> = r
                        .columns
                        .iter()
                        .map(|c| format!("{c}: {}", row.cell(c)))
                        .collect();
                    let head = match &row.task {
                        Some(t) => format!(
                            "{}- [{}] {}   ({}:{})",
                            "    ".repeat(t.depth),
                            t.mark,
                            t.text,
                            row.path,
                            t.line
                        ),
                        None => row.path.clone(),
                    };
                    if cells.is_empty() {
                        head
                    } else {
                        format!("{head}\n    {}", cells.join("   "))
                    }
                })
                .collect();
            if r.total > r.rows.len() {
                lines.push(format!(
                    "({} of {} shown; add limit:N for more)",
                    r.rows.len(),
                    r.total
                ));
            } else if r.rows.is_empty() {
                lines.push(
                    if r.rows.is_empty() && query.iter().any(|q| q.contains("task:")) {
                        "no matching tasks".into()
                    } else {
                        "no matching notes".into()
                    },
                );
            }
            lines.join("\n")
        }),
        Cmd::Agents { sync } => {
            let agents = ws.agents()?;
            if sync {
                let r = ws.mirror_agents()?;
                if !json {
                    for s in &r.skipped {
                        eprintln!(
                            "skipped {s}: .claude/skills/{s} exists and wasn't made by Mosaic"
                        );
                    }
                }
            }
            print(json, &agents, |list| {
                if list.is_empty() {
                    return format!(
                        "no agents (add notes to {}/)",
                        mosaic_core::agents::AGENTS_DIR
                    );
                }
                list.iter()
                    .map(|a| {
                        let when = a
                            .schedule
                            .as_deref()
                            .map_or(String::new(), |s| format!("   [{s}]"));
                        format!("{:<24} {}{when}\n    {}", a.name, a.description, a.path)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
        Cmd::Days { from, to } => {
            let today = mosaic_core::days::today();
            let from = from.unwrap_or_else(|| today.clone());
            let to = match to {
                Some(t) => t,
                None => mosaic_core::days::plus_days(&from, 6)?,
            };
            print(json, &ws.days(&from, &to, &today)?, |r| {
                let task = |t: &mosaic_core::days::DayTask| {
                    let place = if t.daily {
                        String::new()
                    } else {
                        format!("   ({})", t.path)
                    };
                    format!(
                        "  {}- [{}] {}{place}",
                        "    ".repeat(t.depth),
                        t.mark,
                        t.text
                    )
                };
                let mut out = Vec::new();
                if !r.overdue.is_empty() {
                    out.push("Overdue".to_string());
                    out.extend(r.overdue.iter().map(task));
                }
                for d in &r.days {
                    let note = d
                        .note
                        .as_deref()
                        .map_or(String::new(), |n| format!("   {n}"));
                    out.push(format!("{}{note}", d.date));
                    out.extend(d.tasks.iter().map(task));
                }
                out.join("\n")
            })
        }
        Cmd::CarryOver { day } => {
            let day = day.unwrap_or_else(mosaic_core::days::today);
            print(json, &ws.carry_over(&day, None, None)?, |c| {
                match (&c.from, c.moved) {
                    (Some(from), n) if n > 0 => format!(
                        "moved {n} task{} from {from} to {}{}",
                        if n == 1 { "" } else { "s" },
                        c.to,
                        if c.created { " (created)" } else { "" }
                    ),
                    _ => "nothing to carry over".into(),
                }
            })
        }
        Cmd::Create { path, content } => {
            let w = ws.create(&path, &content_arg(content)?)?;
            print(json, &w, |w| done(w, "created"))
        }
        Cmd::Write {
            path,
            content,
            expected_hash,
        } => {
            let w = ws.write(&path, &content_arg(content)?, expected_hash.as_deref())?;
            print(json, &w, |w| done(w, "wrote"))
        }
        Cmd::Append { path, content } => {
            let w = ws.append(&path, &content_arg(content)?)?;
            print(json, &w, |w| done(w, "appended to"))
        }
        Cmd::Patch {
            path,
            find,
            replace,
            expected_hash,
        } => {
            let w = ws.patch(&path, &find, &replace, expected_hash.as_deref())?;
            print(json, &w, |w| done(w, "patched"))
        }
        Cmd::Rename {
            from,
            to,
            no_update_links,
        } => {
            let r = ws.rename(&from, &to, !no_update_links)?;
            print(json, &r, |r| {
                if let Some(id) = r.review {
                    return format!(
                        "proposed renaming {from} to {}: waiting for review (proposal {id})",
                        r.path
                    );
                }
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
            print(json, &w, |w| done(w, "copied to"))
        }
        Cmd::Delete { path } => match ws.delete(&path)? {
            Some(id) => print(
                json,
                &serde_json::json!({ "path": path, "review": id }),
                |_| {
                    format!(
                        "proposed deleting {path}: waiting for the person's review (proposal {id})"
                    )
                },
            ),
            None => print(json, &serde_json::json!({ "deleted": path }), |_| {
                format!("moved {path} to the Trash")
            }),
        },
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
        Cmd::Move { paths, to } => print(json, &ws.move_into(&paths, &to)?, |moved| {
            moved
                .iter()
                .map(|r| format!("moved to {}", r.path))
                .collect::<Vec<_>>()
                .join("\n")
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
            print(json, &w, |w| match w.review {
                Some(_) => done(w, "restored"),
                None => format!("restored {} ({})", w.path, &w.hash[..12]),
            })
        }
        Cmd::Render { path, output, dark } => {
            let svg = render_file(&ws, &path, dark)?;
            let out = output.unwrap_or_else(|| {
                let stem = path.rsplit('/').next().unwrap_or(&path);
                PathBuf::from(format!(
                    "{}.png",
                    stem.strip_suffix(".canvas").unwrap_or(stem)
                ))
            });
            let svg_out = out
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("svg"));
            let bytes = if svg_out {
                svg.into_bytes()
            } else {
                png::svg_to_png(&svg, 2.0)?
            };
            std::fs::write(&out, bytes).with_context(|| format!("writing {}", out.display()))?;
            print(json, &out.display().to_string(), |p| format!("wrote {p}"))
        }
        Cmd::Activity { limit } => print(json, &ws.activity(limit)?, |vs| {
            vs.iter().map(version_line).collect::<Vec<_>>().join("\n")
        }),
        Cmd::Proposals { limit } => print(json, &ws.proposals(true, limit)?, |ps| {
            if ps.is_empty() {
                return "no proposals".into();
            }
            ps.iter()
                .map(|p| {
                    let who = p.actor.clone().unwrap_or_else(|| p.source.clone());
                    let mut line = format!(
                        "{:>6}  {:<9}  {:<8}  {who:<16}  {}",
                        p.id, p.status, p.action, p.path
                    );
                    if let Some(r) = &p.reason {
                        line.push_str(&format!("\n        reason: {r}"));
                    }
                    if p.overwrote {
                        line.push_str(
                            "\n        accepted over the person's own changes made since",
                        );
                    }
                    if p.stale {
                        line.push_str(
                            "\n        the file changed since; the person will see a conflict",
                        );
                    }
                    line
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        Cmd::Withdraw { id } => {
            ws.withdraw_proposal(id)?;
            print(json, &serde_json::json!({ "withdrawn": id }), |_| {
                format!("withdrew proposal {id}")
            })
        }
        Cmd::Undo { id } => {
            let path = ws.undo(id)?;
            print(json, &path, |p| format!("undone: {p}"))
        }
        Cmd::Preferences => print(json, &ws.vault_preferences()?, |p| {
            serde_json::to_string_pretty(p).expect("preferences")
        }),
        Cmd::Guide => unreachable!(),
        Cmd::SwapApps { .. } => unreachable!(),
        Cmd::Mcp => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            rt.block_on(mcp::serve(ws, mode))
        }
    }
}
