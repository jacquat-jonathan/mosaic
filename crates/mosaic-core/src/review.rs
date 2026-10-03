//! Review mode: in folders where the person reviews agents' changes (Settings › AI, access
//! "review"), an agent's create, edit, append, patch, restore or delete doesn't touch the file. It
//! becomes a *proposal*, stored in `history.db` next to the file history, that the person accepts
//! or rejects in the app. One proposal per file is pending at a time: the agent's next change to
//! that file builds on it (its reads see the proposed content), so a multi-step edit is reviewed
//! as one diff. Accepted changes are applied and logged as the agent's, so they can still be undone.

use crate::api::Workspace;
use crate::error::{Error, Result};
use crate::history::{Action, History, Source, now_ms};
use crate::kind::FileKind;
use crate::settings::{Access, access_for};
use crate::vault::{FileContent, Written, hash_bytes, normalize, replace_once};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::path::Path;

/// A change an agent proposed in a folder under review.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Proposal {
    pub id: i64,
    pub path: String,
    /// "created", "edited" or "deleted".
    pub action: String,
    /// "pending", "accepted", "rejected", "withdrawn", or "undone" (accepted, then undone by the person).
    pub status: String,
    pub source: String,
    /// The agent or client name (e.g. "claude-code"), when known.
    pub actor: Option<String>,
    /// Milliseconds since the Unix epoch: first proposed, last changed, decided.
    pub created: i64,
    pub updated: i64,
    pub decided: Option<i64>,
    /// Why the person rejected it, if they said.
    pub reason: Option<String>,
    /// Hash of the file when the proposal was first made (`None`: it didn't exist).
    pub base_hash: Option<String>,
    /// Hash of the proposed content (`None` for a deletion).
    pub hash: Option<String>,
    /// True when the file changed since the proposal was made (accepting would overwrite that).
    #[serde(default)]
    pub stale: bool,
    /// True when the person accepted it anyway after the file had changed: their changes made
    /// since the proposal were replaced (they're kept in the file's history).
    #[serde(default)]
    pub overwrote: bool,
}

const COLUMNS: &str = "id, path, action, status, source, actor, created, updated, decided, reason, base_hash, hash, overwrote";

fn sql_err(e: rusqlite::Error) -> Error {
    Error::Io {
        path: "history".into(),
        source: std::io::Error::other(e.to_string()),
    }
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Proposal> {
    Ok(Proposal {
        id: r.get(0)?,
        path: r.get(1)?,
        action: r.get(2)?,
        status: r.get(3)?,
        source: r.get(4)?,
        actor: r.get(5)?,
        created: r.get(6)?,
        updated: r.get(7)?,
        decided: r.get(8)?,
        reason: r.get(9)?,
        base_hash: r.get(10)?,
        hash: r.get(11)?,
        stale: false,
        overwrote: r.get(12)?,
    })
}

impl History {
    pub fn proposal(&self, id: i64) -> Result<Option<Proposal>> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM proposals WHERE id = ?1"),
                [id],
                row,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The pending proposal for `path` and its proposed content (`None` for a deletion).
    pub fn pending_for(&self, path: &str) -> Result<Option<(Proposal, Option<String>)>> {
        let found: Option<Proposal> = self
            .conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM proposals WHERE path = ?1 AND status = 'pending' ORDER BY id DESC LIMIT 1"),
                [path],
                row,
            )
            .optional()
            .map_err(sql_err)?;
        match found {
            Some(p) => {
                let content = self.proposal_content(p.id)?;
                Ok(Some((p, content)))
            }
            None => Ok(None),
        }
    }

    pub fn proposal_content(&self, id: i64) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT content FROM proposals WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql_err)
            .map(Option::flatten)
    }

    /// Records a proposal, or updates the pending one for the same file. Returns its id.
    #[allow(clippy::too_many_arguments)]
    fn propose(
        &self,
        path: &str,
        action: Action,
        base_hash: Option<&str>,
        content: Option<&str>,
        source: &Source,
        actor: Option<&str>,
    ) -> Result<i64> {
        let now = now_ms();
        let hash = content.map(|c| hash_bytes(c.as_bytes()));
        if let Some((p, _)) = self.pending_for(path)? {
            self.conn
                .execute(
                    "UPDATE proposals SET action = ?1, content = ?2, hash = ?3, actor = ?4, updated = ?5 WHERE id = ?6",
                    params![action_str(action), content, hash, actor, now, p.id],
                )
                .map_err(sql_err)?;
            return Ok(p.id);
        }
        self.conn
            .execute(
                "INSERT INTO proposals (path, action, base_hash, content, hash, source, actor, created, updated, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'pending')",
                params![path, action_str(action), base_hash, content, hash, source.as_str(), actor, now],
            )
            .map_err(sql_err)?;
        Ok(self.conn.last_insert_rowid())
    }

    fn decide(&self, id: i64, status: &str, reason: Option<&str>) -> Result<()> {
        self.conn
            .execute(
                "UPDATE proposals SET status = ?1, reason = ?2, decided = ?3 WHERE id = ?4",
                params![status, reason, now_ms(), id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn accepted(&self, id: i64, overwrote: bool, version_id: Option<i64>) -> Result<()> {
        self.conn
            .execute(
                "UPDATE proposals SET status = 'accepted', reason = NULL, decided = ?1, overwrote = ?2, version_id = ?3 WHERE id = ?4",
                params![now_ms(), overwrote, version_id, id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Marks the accepted proposal that made history entry `version_id` as undone.
    pub(crate) fn proposal_undone(&self, version_id: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE proposals SET status = 'undone' WHERE version_id = ?1 AND status = 'accepted'",
                [version_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Pending proposals (oldest first), then decided ones (newest first) up to `limit` in all.
    pub fn proposals(&self, include_decided: bool, limit: usize) -> Result<Vec<Proposal>> {
        let sql = if include_decided {
            format!(
                "SELECT {COLUMNS} FROM proposals ORDER BY status != 'pending', CASE WHEN status = 'pending' THEN id ELSE -id END LIMIT ?1"
            )
        } else {
            format!("SELECT {COLUMNS} FROM proposals WHERE status = 'pending' ORDER BY id LIMIT ?1")
        };
        let mut stmt = self.conn.prepare_cached(&sql).map_err(sql_err)?;
        stmt.query_map([limit as i64], row)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql_err)
    }
}

fn action_str(a: Action) -> &'static str {
    match a {
        Action::Created => "created",
        Action::Deleted => "deleted",
        _ => "edited",
    }
}

fn not_reviewable(path: &str, what: &str) -> Error {
    Error::Denied(format!(
        "{path} is in a folder where the person reviews your changes, and {what} can't be proposed for review; ask them to do it"
    ))
}

impl Workspace {
    /// Whether this workspace's changes to `norm` become proposals (agents and the CLI, in a
    /// folder under review).
    pub(crate) fn in_review(&self, norm: &str) -> bool {
        self.source() != Source::App && access_for(&self.rules(), norm) == Some(Access::Review)
    }

    /// Refuses an operation that can't be proposed (moves, binary files, folders) under review.
    pub(crate) fn refuse_in_review(&self, path: &str, what: &str) -> Result<()> {
        let norm = normalize(path)?;
        if self.in_review(&norm) {
            Err(not_reviewable(&norm, what))
        } else {
            Ok(())
        }
    }

    /// The file as the agent should see it: its pending proposal if there is one, else the disk.
    /// `None` when it doesn't exist (or its deletion is proposed).
    fn effective(&self, norm: &str) -> Result<Option<(String, String, Option<i64>)>> {
        if let Some((p, content)) = self.hist().pending_for(norm)? {
            return Ok(content.map(|c| {
                let h = hash_bytes(c.as_bytes());
                (c, h, Some(p.id))
            }));
        }
        Ok(self.text_of(norm).map(|(t, h)| (t, h, None)))
    }

    /// Reading under review: the pending proposal's content, when there is one.
    pub(crate) fn read_in_review(&self, norm: &str) -> Result<Option<FileContent>> {
        let Some((p, content)) = self.hist().pending_for(norm)? else {
            return Ok(None);
        };
        let content =
            content.ok_or_else(|| Error::NotFound(format!("{norm} (you proposed deleting it)")))?;
        Ok(Some(FileContent {
            path: norm.to_string(),
            kind: FileKind::of(Path::new(norm)),
            size: content.len() as u64,
            mtime: p.updated as u64,
            hash: hash_bytes(content.as_bytes()),
            content: Some(content),
            review: Some(p.id),
        }))
    }

    fn check_expected(&self, norm: &str, expected: Option<&str>) -> Result<()> {
        if let Some(expected) = expected {
            let current = self
                .effective(norm)?
                .map(|(_, h, _)| h)
                .ok_or_else(|| Error::NotFound(norm.to_string()))?;
            if current != expected {
                return Err(Error::Conflict {
                    path: norm.to_string(),
                    current_hash: current,
                });
            }
        }
        Ok(())
    }

    /// Proposes `content` as the file's new content.
    fn propose_content(&self, norm: &str, content: &str) -> Result<Written> {
        if !FileKind::of(Path::new(norm)).is_text() {
            return Err(not_reviewable(norm, "a binary file"));
        }
        if self.vault.stat(norm).is_ok_and(|e| e.is_dir) {
            return Err(Error::Invalid(format!("{norm} is a folder")));
        }
        crate::validate::check(norm, content)?;
        let disk = self.text_of(norm);
        let hash = hash_bytes(content.as_bytes());
        let pending = self.hist().pending_for(norm)?;
        // Back to what's on disk: nothing left to review.
        if disk.as_ref().is_some_and(|(_, h)| *h == hash) {
            if let Some((p, _)) = pending {
                self.hist().decide(p.id, "withdrawn", None)?;
            }
            return Ok(Written {
                path: norm.to_string(),
                hash,
                review: None,
            });
        }
        let base = match &pending {
            Some((p, _)) => p.base_hash.clone(),
            None => {
                // Keep the file as the agent saw it, so the review can show what the person
                // changed since, should they edit it before deciding.
                self.keep_before(norm);
                disk.as_ref().map(|(_, h)| h.clone())
            }
        };
        let action = if disk.is_some() {
            Action::Edited
        } else {
            Action::Created
        };
        let id = self.hist().propose(
            norm,
            action,
            base.as_deref(),
            Some(content),
            &self.source(),
            self.actor().as_deref(),
        )?;
        Ok(Written {
            path: norm.to_string(),
            hash,
            review: Some(id),
        })
    }

    pub(crate) fn propose_create(&self, norm: &str, content: &str) -> Result<Written> {
        if self.effective(norm)?.is_some() || self.vault.stat(norm).is_ok() {
            return Err(Error::AlreadyExists(norm.to_string()));
        }
        self.propose_content(norm, content)
    }

    pub(crate) fn propose_write(
        &self,
        norm: &str,
        content: &str,
        expected: Option<&str>,
    ) -> Result<Written> {
        self.check_expected(norm, expected)?;
        self.propose_content(norm, content)
    }

    pub(crate) fn propose_append(&self, norm: &str, content: &str) -> Result<Written> {
        let mut next = self.effective(norm)?.map(|(t, ..)| t).unwrap_or_default();
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(content);
        self.propose_content(norm, &next)
    }

    pub(crate) fn propose_patch(
        &self,
        norm: &str,
        find: &str,
        replace: &str,
        expected: Option<&str>,
    ) -> Result<Written> {
        let (text, ..) = self
            .effective(norm)?
            .ok_or_else(|| Error::NotFound(norm.to_string()))?;
        self.check_expected(norm, expected)?;
        let next = replace_once(norm, &text, find, replace)?;
        self.propose_content(norm, &next)
    }

    pub(crate) fn propose_delete(&self, norm: &str) -> Result<Option<i64>> {
        if self.vault.stat(norm).is_ok_and(|e| e.is_dir) {
            return Err(not_reviewable(norm, "deleting a folder"));
        }
        if self.effective(norm)?.is_none() {
            return Err(Error::NotFound(norm.to_string()));
        }
        let disk = self.text_of(norm);
        let pending = self.hist().pending_for(norm)?;
        match (&disk, pending) {
            // Deleting a file only proposed so far: drop the proposal.
            (None, Some((p, _))) => self.hist().decide(p.id, "withdrawn", None).map(|_| None),
            (_, pending) => {
                let base = match &pending {
                    Some((p, _)) => p.base_hash.clone(),
                    None => {
                        self.keep_before(norm);
                        disk.as_ref().map(|(_, h)| h.clone())
                    }
                };
                let id = self.hist().propose(
                    norm,
                    Action::Deleted,
                    base.as_deref(),
                    None,
                    &self.source(),
                    self.actor().as_deref(),
                )?;
                Ok(Some(id))
            }
        }
    }

    /// Proposals, with `stale` set when the file changed since. Agents see only paths they may see.
    pub fn proposals(&self, include_decided: bool, limit: usize) -> Result<Vec<Proposal>> {
        let rules = self.rules();
        let mut list = self.hist().proposals(include_decided, limit)?;
        list.retain(|p| access_for(&rules, &p.path) != Some(Access::Hidden));
        for p in &mut list {
            if p.status == "pending" {
                p.stale = self.vault.hash_of(&p.path).ok().flatten() != p.base_hash;
            }
        }
        Ok(list)
    }

    /// The file as it was when the proposal was made (`None`: it didn't exist, or that version
    /// wasn't kept). Diffed against the file now, it shows what the person changed since.
    pub fn proposal_base(&self, id: i64) -> Result<Option<String>> {
        let p = self
            .hist()
            .proposal(id)?
            .ok_or_else(|| Error::NotFound(format!("proposal {id}")))?;
        match &p.base_hash {
            Some(h) => self.hist().content_by_hash(&p.path, h),
            None => Ok(None),
        }
    }

    /// The proposed content (`None` for a deletion).
    pub fn proposal_content(&self, id: i64) -> Result<Option<String>> {
        self.hist()
            .proposal(id)?
            .ok_or_else(|| Error::NotFound(format!("proposal {id}")))?;
        self.hist().proposal_content(id)
    }

    fn pending(&self, id: i64) -> Result<Proposal> {
        let p = self
            .hist()
            .proposal(id)?
            .ok_or_else(|| Error::NotFound(format!("proposal {id}")))?;
        if p.status != "pending" {
            return Err(Error::Invalid(format!(
                "proposal {id} is already {}",
                p.status
            )));
        }
        Ok(p)
    }

    fn person_only(&self, what: &str) -> Result<()> {
        if self.source() == Source::App {
            Ok(())
        } else {
            Err(Error::Denied(format!(
                "only the person can {what} a proposal, in the Mosaic app"
            )))
        }
    }

    /// Applies a proposal (the person, in the app). Refused with `conflict` when the file changed
    /// since it was proposed, unless `force`. The change is logged as the agent's, so it shows in
    /// the AI activity and can be undone. Returns the file's path.
    pub fn accept_proposal(&self, id: i64, force: bool) -> Result<String> {
        self.person_only("accept")?;
        let p = self.pending(id)?;
        let current = self.vault.hash_of(&p.path)?;
        if current != p.base_hash && !force {
            return Err(Error::Conflict {
                path: p.path.clone(),
                current_hash: current.unwrap_or_default(),
            });
        }
        let source = Source::parse(&p.source);
        // Bound first: a guard in the match head would stay locked through the arms.
        let content = self.hist().proposal_content(id)?;
        match content {
            Some(content) => {
                let existed = self.keep_before(&p.path);
                let w = self.vault.write(&p.path, &content, None)?;
                let action = if existed {
                    Action::Edited
                } else {
                    Action::Created
                };
                let _ = self.hist().record(
                    &w.path,
                    Some(&content),
                    &w.hash,
                    &source,
                    p.actor.as_deref(),
                    action,
                    None,
                );
            }
            None => {
                if let Some((text, hash)) = self.text_of(&p.path) {
                    self.keep_before(&p.path);
                    self.vault.delete(&p.path)?;
                    let _ = self.hist().record(
                        &p.path,
                        Some(&text),
                        &hash,
                        &source,
                        p.actor.as_deref(),
                        Action::Deleted,
                        None,
                    );
                } else if self.vault.stat(&p.path).is_ok() {
                    self.vault.delete(&p.path)?;
                }
            }
        }
        // The entry just recorded is what Undo in AI activity reverts; link it so the agent sees that.
        let version_id = self.hist().latest(&p.path)?.map(|v| v.id);
        self.hist()
            .accepted(id, current != p.base_hash, version_id)?;
        self.reindex(&p.path);
        Ok(p.path)
    }

    /// Turns a proposal down (the person, in the app); `reason` is shown to the agent.
    pub fn reject_proposal(&self, id: i64, reason: Option<&str>) -> Result<()> {
        self.person_only("reject")?;
        self.pending(id)?;
        let reason = reason.map(str::trim).filter(|r| !r.is_empty());
        self.hist().decide(id, "rejected", reason)
    }

    /// The agent takes its own proposal back.
    pub fn withdraw_proposal(&self, id: i64) -> Result<()> {
        let p = self.pending(id)?;
        if access_for(&self.rules(), &p.path) == Some(Access::Hidden) {
            return Err(Error::NotFound(format!("proposal {id}")));
        }
        self.hist().decide(id, "withdrawn", None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;
    use crate::settings::AgentRule;
    use crate::vault::Vault;

    /// A vault whose `Reviewed/` folder is under review, and two workspaces on it: the app and an agent.
    fn setup() -> (tempfile::TempDir, Workspace, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Reviewed")).unwrap();
        std::fs::write(dir.path().join("Reviewed/Plan.md"), "# Plan\n- one\n").unwrap();
        std::fs::write(dir.path().join("Free.md"), "free\n").unwrap();
        let db = dir.path().join(".history-test.db");
        let open = || Vault::open(dir.path()).unwrap();
        let app = Workspace::with_history_file(open(), Index::in_memory().unwrap(), &db);
        let agent = Workspace::with_history_file(open(), Index::in_memory().unwrap(), &db)
            .with_source(Source::Agent)
            .with_agent_rules(vec![AgentRule {
                path: "Reviewed".into(),
                access: Access::Review,
                written_as: None,
            }]);
        agent.set_actor("claude-code");
        (dir, app, agent)
    }

    fn disk(dir: &tempfile::TempDir, p: &str) -> Option<String> {
        std::fs::read_to_string(dir.path().join(p)).ok()
    }

    #[test]
    fn agent_edits_become_one_proposal_until_accepted() {
        let (dir, app, agent) = setup();
        let r = agent.read("Reviewed/Plan.md").unwrap();
        let w = agent
            .patch("Reviewed/Plan.md", "- one", "- one\n- two", Some(&r.hash))
            .unwrap();
        let id = w.review.expect("proposed, not written");
        assert_eq!(disk(&dir, "Reviewed/Plan.md").unwrap(), "# Plan\n- one\n");
        // The agent keeps working on its proposal: reads see it, edits stack on it.
        let seen = agent.read("Reviewed/Plan.md").unwrap();
        assert_eq!(
            (seen.content.as_deref(), seen.review),
            (Some("# Plan\n- one\n- two\n"), Some(id))
        );
        let w2 = agent.append("Reviewed/Plan.md", "- three\n").unwrap();
        assert_eq!(w2.review, Some(id));
        // The app sees the file as it is, and one pending proposal.
        assert_eq!(app.read("Reviewed/Plan.md").unwrap().review, None);
        let list = app.proposals(false, 10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            (
                list[0].action.as_str(),
                list[0].actor.as_deref(),
                list[0].stale
            ),
            ("edited", Some("claude-code"), false)
        );
        // Only the person decides.
        assert!(matches!(
            agent.accept_proposal(id, false),
            Err(Error::Denied(_))
        ));
        app.accept_proposal(id, false).unwrap();
        assert_eq!(
            disk(&dir, "Reviewed/Plan.md").unwrap(),
            "# Plan\n- one\n- two\n- three\n"
        );
        // Logged as the agent's change, so it can be undone.
        let act = app.activity(5).unwrap();
        assert_eq!(
            (
                act[0].source.as_str(),
                act[0].actor.as_deref(),
                act[0].action.as_str()
            ),
            ("agent", Some("claude-code"), "edited")
        );
        let accepted = &agent.proposals(true, 10).unwrap()[0];
        assert_eq!(
            (accepted.status.as_str(), accepted.overwrote),
            ("accepted", false)
        );
        // The person undoes it in AI activity: the agent sees that its change is gone.
        app.undo(act[0].id).unwrap();
        assert_eq!(disk(&dir, "Reviewed/Plan.md").unwrap(), "# Plan\n- one\n");
        assert_eq!(agent.proposals(true, 10).unwrap()[0].status, "undone");
        // Outside the review folder, agents write directly.
        assert_eq!(
            agent.write("Free.md", "changed\n", None).unwrap().review,
            None
        );
    }

    #[test]
    fn creations_deletions_conflicts_and_rejections() {
        let (dir, app, agent) = setup();
        let w = agent.create("Reviewed/New.md", "hello\n").unwrap();
        assert!(w.review.is_some() && disk(&dir, "Reviewed/New.md").is_none());
        assert!(matches!(
            agent.create("Reviewed/New.md", "again"),
            Err(Error::AlreadyExists(_))
        ));
        // Deleting a file that was only proposed drops the proposal.
        agent.delete("Reviewed/New.md").unwrap();
        assert!(app.proposals(false, 10).unwrap().is_empty());
        // A proposed deletion, rejected with a reason the agent can read.
        agent.delete("Reviewed/Plan.md").unwrap();
        assert!(matches!(
            agent.read("Reviewed/Plan.md"),
            Err(Error::NotFound(_))
        ));
        let p = &app.proposals(false, 10).unwrap()[0];
        assert_eq!(p.action, "deleted");
        app.reject_proposal(p.id, Some("keep the plan")).unwrap();
        assert!(disk(&dir, "Reviewed/Plan.md").is_some());
        let decided = &agent.proposals(true, 10).unwrap()[0];
        assert_eq!(
            (decided.status.as_str(), decided.reason.as_deref()),
            ("rejected", Some("keep the plan"))
        );
        // The person edits the file after the proposal: accepting needs force.
        let w = agent
            .write("Reviewed/Plan.md", "# Plan v2\n", None)
            .unwrap();
        std::fs::write(
            dir.path().join("Reviewed/Plan.md"),
            "# Plan, edited by hand\n",
        )
        .unwrap();
        assert!(app.proposals(false, 10).unwrap()[0].stale);
        assert!(matches!(
            app.accept_proposal(w.review.unwrap(), false),
            Err(Error::Conflict { .. })
        ));
        app.accept_proposal(w.review.unwrap(), true).unwrap();
        assert_eq!(disk(&dir, "Reviewed/Plan.md").unwrap(), "# Plan v2\n");
        // The decision records that it replaced the person's edit (stale only means something
        // while pending).
        let forced = &agent.proposals(true, 10).unwrap()[0];
        assert_eq!(
            (forced.status.as_str(), forced.overwrote),
            ("accepted", true)
        );
        // Moves and binary files can't be reviewed.
        assert!(matches!(
            agent.rename("Reviewed/Plan.md", "Plan.md", true),
            Err(Error::Denied(_))
        ));
        assert!(matches!(
            agent.rename("Free.md", "Reviewed/Free.md", true),
            Err(Error::Denied(_))
        ));
        assert!(matches!(
            agent.import("Reviewed/pic.png", b"png"),
            Err(Error::Denied(_))
        ));
        assert!(matches!(agent.delete("Reviewed"), Err(Error::Denied(_))));
    }
}
