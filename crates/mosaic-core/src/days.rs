//! Days: the tasks of each day for the calendar, and carrying unfinished tasks over to a new day.
//!
//! A *daily note* is any Markdown note named after its date (`2026-10-04.md`, in any folder). A day's
//! tasks are its daily note's checkboxes, plus tasks in other notes with a `📅 2026-10-04` due date.
//! Dated tasks still open after their day are *overdue*.
//!
//! *Carry-over* moves the open tasks of the most recent daily note before a day into that day's note
//! (created if needed): each open task moves with its open subtasks, the old note keeps it as
//! `- [>] task` (Obsidian's "moved"), and done subtasks stay behind under that trace. Tasks only ever
//! move from that one note, so a task left open for days travels along day by day instead of being
//! gathered from the whole history.

use crate::api::Workspace;
use crate::error::{Error, Result};
use crate::index::TaskMeta;
use crate::query::task_status;
use chrono::NaiveDate;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

static DAY_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4}-\d{2}-\d{2})\.md$").expect("valid"));

/// The date a note is the daily note of, from its file name.
pub fn daily_date(path: &str) -> Option<NaiveDate> {
    let name = crate::links::file_name(path);
    let c = DAY_NAME.captures(name)?;
    NaiveDate::parse_from_str(&c[1], "%Y-%m-%d").ok()
}

/// Today's local date, `2026-10-04`.
pub fn today() -> String {
    chrono::Local::now().date_naive().to_string()
}

/// `day` plus `n` days.
pub fn plus_days(day: &str, n: i64) -> Result<String> {
    Ok((date(day)? + chrono::Duration::days(n)).to_string())
}

fn date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|_| Error::Invalid(format!("{s:?} isn't a date like 2026-10-04")))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayTask {
    /// The note it's in.
    pub path: String,
    /// 1-based line in that note.
    pub line: usize,
    /// "open", "done", "moved" or "cancelled".
    pub status: &'static str,
    pub mark: char,
    pub text: String,
    pub depth: usize,
    /// Line of the task it's nested under.
    pub parent: Option<usize>,
    pub due: Option<String>,
    /// True when it's in the day's daily note; false for a dated task from another note.
    pub daily: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Day {
    /// `2026-10-04`.
    pub date: String,
    /// The day's daily note, if there is one.
    pub note: Option<String>,
    pub tasks: Vec<DayTask>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Days {
    pub days: Vec<Day>,
    /// Open dated tasks whose day is before `today`.
    pub overdue: Vec<DayTask>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CarryOver {
    /// The daily note the tasks came from (`None`: there was none before this day).
    pub from: Option<String>,
    /// The day's note they went to.
    pub to: String,
    /// How many tasks moved (subtasks included).
    pub moved: usize,
    /// True when the day's note was created for them.
    pub created: bool,
}

fn day_task(t: TaskMeta, daily: bool) -> DayTask {
    DayTask {
        status: task_status(t.mark),
        path: t.path,
        line: t.line,
        mark: t.mark,
        text: t.text,
        depth: t.depth,
        parent: t.parent,
        due: t.due,
        daily,
    }
}

impl Workspace {
    /// Daily notes the caller may see, by date (the first path when two share a date).
    fn daily_notes(&self) -> Result<BTreeMap<NaiveDate, String>> {
        let rules = self.rules();
        let mut out = BTreeMap::new();
        for n in self.reading().notes_meta()? {
            if n.kind == "markdown"
                && Self::visible(&rules, &n.path)
                && let Some(d) = daily_date(&n.path)
            {
                out.entry(d).or_insert(n.path);
            }
        }
        Ok(out)
    }

    /// Each day from `from` to `to` (inclusive, at most 62 days) with its tasks, and the dated tasks
    /// overdue on `today`.
    pub fn days(&self, from: &str, to: &str, today: &str) -> Result<Days> {
        let (from, to, today) = (date(from)?, date(to)?, date(today)?);
        if to < from || (to - from).num_days() > 62 {
            return Err(Error::Invalid(
                "the range must run forward and span at most 62 days".into(),
            ));
        }
        let rules = self.rules();
        let notes = self.daily_notes()?;
        let mut days: BTreeMap<NaiveDate, Day> = BTreeMap::new();
        let mut d = from;
        while d <= to {
            days.insert(
                d,
                Day {
                    date: d.to_string(),
                    note: notes.get(&d).cloned(),
                    tasks: Vec::new(),
                },
            );
            match d.succ_opt() {
                Some(next) => d = next,
                None => break,
            }
        }
        let mut overdue = Vec::new();
        for t in self.reading().tasks()? {
            if !Self::visible(&rules, &t.path) {
                continue;
            }
            match daily_date(&t.path) {
                Some(day) => {
                    if let Some(entry) = days.get_mut(&day) {
                        entry.tasks.push(day_task(t, true));
                    }
                }
                None => {
                    let Some(due) = t.due.as_deref().and_then(|s| date(s).ok()) else {
                        continue;
                    };
                    let open = task_status(t.mark) == "open";
                    if open && due < today {
                        overdue.push(day_task(t.clone(), false));
                    }
                    if let Some(entry) = days.get_mut(&due) {
                        entry.tasks.push(day_task(t, false));
                    }
                }
            }
        }
        Ok(Days {
            days: days.into_values().collect(),
            overdue,
        })
    }

    /// Moves the open tasks of the last daily note before `day` into `day`'s note. `path` is where
    /// that note is or goes (default: the existing note named after the day, else beside the last
    /// daily note); `new_note` is its content if it has to be created (default: a `# date` title).
    pub fn carry_over(
        &self,
        day: &str,
        path: Option<&str>,
        new_note: Option<&str>,
    ) -> Result<CarryOver> {
        let day = date(day)?;
        let notes = self.daily_notes()?;
        let prev = notes.range(..day).next_back().map(|(_, p)| p.clone());
        let to = match (path, notes.get(&day), &prev) {
            (Some(p), ..) => crate::vault::normalize(p)?,
            (None, Some(existing), _) => existing.clone(),
            (None, None, Some(p)) => match p.rsplit_once('/') {
                Some((folder, _)) => format!("{folder}/{day}.md"),
                None => format!("{day}.md"),
            },
            (None, None, None) => format!("{day}.md"),
        };
        let nothing = |created| {
            Ok(CarryOver {
                from: prev.clone(),
                to: to.clone(),
                moved: 0,
                created,
            })
        };
        let Some(from) = prev.clone() else {
            return nothing(false);
        };
        if from == to {
            return nothing(false);
        }
        let old = self.read(&from)?;
        let old_text = old.content.unwrap_or_default();
        let tasks = crate::parse::parse(&old_text).tasks;
        // Open tasks move; each keeps its place under the open tasks it was nested in.
        let moving: HashSet<usize> = tasks
            .iter()
            .filter(|t| task_status(t.mark) == "open")
            .map(|t| t.line)
            .collect();
        if moving.is_empty() {
            return nothing(false);
        }
        let parent_of: BTreeMap<usize, Option<usize>> =
            tasks.iter().map(|t| (t.line, t.parent)).collect();
        let lines: Vec<&str> = old_text.split_inclusive('\n').collect();
        let tabs = tasks
            .iter()
            .any(|t| lines.get(t.line - 1).is_some_and(|l| l.starts_with('\t')));
        let unit = if tabs { "\t" } else { "    " };
        let mut moved_lines = Vec::new();
        for t in tasks.iter().filter(|t| moving.contains(&t.line)) {
            let mut depth = 0;
            let mut up = t.parent;
            while let Some(p) = up {
                if moving.contains(&p) {
                    depth += 1;
                }
                up = parent_of.get(&p).copied().flatten();
            }
            let text = if t.text.is_empty() {
                String::new()
            } else {
                format!(" {}", t.text)
            };
            moved_lines.push(format!("{}- [{}]{text}", unit.repeat(depth), t.mark));
        }

        // The new day first: if anything fails after, the tasks exist twice rather than nowhere.
        let block = moved_lines.join("\n");
        let created = match self.read(&to) {
            Ok(f) => {
                let mut text = f.content.unwrap_or_default();
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                if !text.is_empty() && !text.ends_with("\n\n") {
                    text.push('\n');
                }
                text.push_str(&block);
                text.push('\n');
                self.write(&to, &text, Some(&f.hash))?;
                false
            }
            Err(Error::NotFound(_)) => {
                let mut text = new_note.map_or_else(|| format!("# {day}\n\n"), str::to_string);
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&block);
                text.push('\n');
                self.create(&to, &text)?;
                true
            }
            Err(e) => return Err(e),
        };
        let mut old_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        for t in tasks.iter().filter(|t| moving.contains(&t.line)) {
            let raw = &old_lines[t.line - 1];
            let body = raw.trim_end_matches(['\n', '\r']);
            if let Some(marked) = crate::parse::with_task_mark(body, &t.text, '>') {
                let ending = raw[body.len()..].to_string();
                old_lines[t.line - 1] = format!("{marked}{ending}");
            }
        }
        self.write(&from, &old_lines.concat(), Some(&old.hash))?;
        Ok(CarryOver {
            from: Some(from),
            to,
            moved: moving.len(),
            created,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::Index;
    use crate::vault::Vault;

    fn ws(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let full = dir.path().join(p);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, c).unwrap();
        }
        let w = Workspace::with_history_file(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
            &dir.path().join(".history-test.db"),
        );
        w.sync(|_, _| {}).unwrap();
        (dir, w)
    }

    fn disk(d: &tempfile::TempDir, p: &str) -> String {
        std::fs::read_to_string(d.path().join(p)).unwrap()
    }

    #[test]
    fn days_hold_daily_tasks_dated_tasks_and_overdue_ones() {
        let (_d, w) = ws(&[
            (
                "Daily/2026-10-03.md",
                "# Sat\n- [x] Standup\n- [ ] Report\n",
            ),
            ("Daily/2026-10-04.md", "# Sun\n- [ ] Walk\n"),
            (
                "Projects/Site.md",
                "- [ ] Copy 📅 2026-10-04\n- [ ] Old 📅 2026-09-30\n- [x] Done 📅 2026-09-29\n- [ ] Undated\n",
            ),
            ("Notes/2026-10-04 meeting.md", "- [ ] Not a daily note\n"),
        ]);
        let r = w.days("2026-10-03", "2026-10-05", "2026-10-04").unwrap();
        let summary: Vec<(String, Option<String>, Vec<String>)> = r
            .days
            .iter()
            .map(|d| {
                (
                    d.date.clone(),
                    d.note.clone(),
                    d.tasks
                        .iter()
                        .map(|t| {
                            format!(
                                "{}{}",
                                if t.daily { "" } else { "📅" },
                                t.text.split(' ').next().unwrap()
                            )
                        })
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "2026-10-03".to_string(),
                    Some("Daily/2026-10-03.md".to_string()),
                    vec!["Standup".to_string(), "Report".to_string()]
                ),
                (
                    "2026-10-04".to_string(),
                    Some("Daily/2026-10-04.md".to_string()),
                    vec!["Walk".to_string(), "📅Copy".to_string()]
                ),
                ("2026-10-05".to_string(), None, vec![]),
            ]
        );
        let overdue: Vec<&str> = r.overdue.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(overdue, ["Old 📅 2026-09-30"]);
        assert!(w.days("2026-10-05", "2026-10-01", "2026-10-04").is_err());
        assert!(w.days("2026-01-01", "2026-12-31", "2026-10-04").is_err());
    }

    #[test]
    fn carry_over_moves_open_tasks_with_open_subtasks() {
        let (d, w) = ws(&[
            ("Daily/2026-10-01.md", "# Thu\n- [ ] Ancient\n"),
            (
                "Daily/2026-10-02.md",
                "# Fri\n- [x] Standup\n- [ ] Report\n    - [x] Outline\n    - [ ] Draft\n        - [ ] Intro\n- [x] Shipped\n    - [ ] Follow-up\n- [>] Already moved\n- [-] Gym\nSome text.\n",
            ),
        ]);
        let r = w.carry_over("2026-10-04", None, None).unwrap();
        assert_eq!(
            r,
            CarryOver {
                from: Some("Daily/2026-10-02.md".into()),
                to: "Daily/2026-10-04.md".into(),
                moved: 4,
                created: true,
            }
        );
        assert_eq!(
            disk(&d, "Daily/2026-10-04.md"),
            "# 2026-10-04\n\n- [ ] Report\n    - [ ] Draft\n        - [ ] Intro\n- [ ] Follow-up\n"
        );
        assert_eq!(
            disk(&d, "Daily/2026-10-02.md"),
            "# Fri\n- [x] Standup\n- [>] Report\n    - [x] Outline\n    - [>] Draft\n        - [>] Intro\n- [x] Shipped\n    - [>] Follow-up\n- [>] Already moved\n- [-] Gym\nSome text.\n"
        );
        // Only the last note before the day: older ones aren't gathered.
        assert!(disk(&d, "Daily/2026-10-01.md").contains("- [ ] Ancient"));
        // Running again moves nothing (and doesn't duplicate).
        assert_eq!(w.carry_over("2026-10-04", None, None).unwrap().moved, 0);
        assert_eq!(disk(&d, "Daily/2026-10-04.md").matches("Report").count(), 1);
    }

    #[test]
    fn carry_over_into_an_existing_note_and_a_given_path() {
        let (d, w) = ws(&[
            ("Daily/2026-10-02.md", "- [ ] Report\n"),
            ("Daily/2026-10-03.md", "# Sat\nPlan: rest."),
        ]);
        let r = w.carry_over("2026-10-03", None, None).unwrap();
        assert_eq!(
            (r.to.as_str(), r.moved, r.created),
            ("Daily/2026-10-03.md", 1, false)
        );
        assert_eq!(
            disk(&d, "Daily/2026-10-03.md"),
            "# Sat\nPlan: rest.\n\n- [ ] Report\n"
        );
        assert_eq!(disk(&d, "Daily/2026-10-02.md"), "- [>] Report\n");
        // A given path and starting content (the app's daily folder and template).
        let (d2, w2) = ws(&[("Journal/2026-10-02.md", "- [ ] Report\n")]);
        let r2 = w2
            .carry_over(
                "2026-10-03",
                Some("Days/2026-10-03.md"),
                Some("# {date} from template"),
            )
            .unwrap();
        assert_eq!(
            (r2.to.as_str(), r2.created, r2.moved),
            ("Days/2026-10-03.md", true, 1)
        );
        assert_eq!(
            disk(&d2, "Days/2026-10-03.md"),
            "# {date} from template\n- [ ] Report\n"
        );
    }
}
