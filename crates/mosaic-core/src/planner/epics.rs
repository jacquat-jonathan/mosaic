use super::{
    CreateEpic, Epic, PlannerStore, UpdateEpic, bump_store_revision, expect_revision, now,
    record_activity, required_title, sql_error,
};
use crate::api::Workspace;
use crate::error::{Error, Result};
use rusqlite::{Row, Transaction, params};

fn row_to_epic(row: &Row<'_>) -> rusqlite::Result<Epic> {
    Ok(Epic {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        color: row.get(3)?,
        position: row.get(4)?,
        revision: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        archived_at: row.get(8)?,
        trashed_at: row.get(9)?,
    })
}

fn epic_in(tx: &Transaction<'_>, id: &str) -> Result<Epic> {
    tx.query_row(
        "SELECT id, title, description, color, position, revision, created_at, updated_at,
                archived_at, trashed_at FROM epics WHERE id = ?1",
        [id],
        row_to_epic,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Error::NotFound(format!("planner epic/{id}")),
        other => sql_error(other),
    })
}

fn valid_color(color: &str) -> Result<String> {
    let color = color.trim();
    if color.is_empty() || color.len() > 64 {
        Err(Error::Invalid("epic color must be 1–64 characters".into()))
    } else {
        Ok(color.to_string())
    }
}

impl PlannerStore {
    pub fn list_epics(&self, include_archived: bool, include_trashed: bool) -> Result<Vec<Epic>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, title, description, color, position, revision, created_at, updated_at,
                        archived_at, trashed_at
                 FROM epics
                 WHERE (?1 OR archived_at IS NULL) AND (?2 OR trashed_at IS NULL)
                 ORDER BY position, id",
            )
            .map_err(sql_error)?;
        stmt.query_map(params![include_archived, include_trashed], row_to_epic)
            .map_err(sql_error)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql_error)
    }

    pub fn create_epic(&mut self, input: CreateEpic) -> Result<Epic> {
        let title = required_title(&input.title, "epic")?;
        let color = valid_color(&input.color)?;
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        let tx = self.conn.transaction().map_err(sql_error)?;
        let position: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), 0) + 1024 FROM epics",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        tx.execute(
            "INSERT INTO epics(id, title, description, color, position, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
            params![id, title, input.description, color, position, at],
        )
        .map_err(sql_error)?;
        let epic = epic_in(&tx, &id)?;
        record_activity(
            &tx,
            ("epic", &id),
            &at,
            "created",
            "Created epic",
            None,
            Some(serde_json::to_value(&epic).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(epic)
    }

    pub fn update_epic(&mut self, id: &str, input: UpdateEpic) -> Result<Epic> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "epics", id, input.expected_revision)?;
        let before = epic_in(&tx, id)?;
        let title = match input.title {
            Some(title) => required_title(&title, "epic")?,
            None => before.title.clone(),
        };
        let color = match input.color {
            Some(color) => valid_color(&color)?,
            None => before.color.clone(),
        };
        let at = now();
        tx.execute(
            "UPDATE epics SET title = ?2, description = ?3, color = ?4, position = ?5,
                    revision = revision + 1, updated_at = ?6 WHERE id = ?1",
            params![
                id,
                title,
                input
                    .description
                    .unwrap_or_else(|| before.description.clone()),
                color,
                input.position.unwrap_or(before.position),
                at
            ],
        )
        .map_err(sql_error)?;
        let after = epic_in(&tx, id)?;
        record_activity(
            &tx,
            ("epic", id),
            &at,
            "updated",
            "Updated epic",
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }

    pub fn archive_epic(&mut self, id: &str, expected_revision: i64) -> Result<Epic> {
        self.set_epic_lifecycle(id, expected_revision, "archived")
    }

    pub fn restore_epic(&mut self, id: &str, expected_revision: i64) -> Result<Epic> {
        self.set_epic_lifecycle(id, expected_revision, "restored")
    }

    pub fn trash_epic(&mut self, id: &str, expected_revision: i64) -> Result<Epic> {
        self.set_epic_lifecycle(id, expected_revision, "trashed")
    }

    fn set_epic_lifecycle(
        &mut self,
        id: &str,
        expected_revision: i64,
        action: &str,
    ) -> Result<Epic> {
        let tx = self.conn.transaction().map_err(sql_error)?;
        expect_revision(&tx, "epics", id, expected_revision)?;
        let before = epic_in(&tx, id)?;
        if action == "trashed" && before.archived_at.is_none() {
            return Err(Error::Invalid(
                "archive an epic before moving it to Trash".into(),
            ));
        }
        let at = now();
        match action {
            "archived" => tx.execute(
                "UPDATE epics SET archived_at = COALESCE(archived_at, ?2), revision = revision + 1,
                        updated_at = ?2 WHERE id = ?1",
                params![id, at],
            ),
            "restored" => tx.execute(
                "UPDATE epics SET archived_at = NULL, trashed_at = NULL, revision = revision + 1,
                        updated_at = ?2 WHERE id = ?1",
                params![id, at],
            ),
            "trashed" => tx.execute(
                "UPDATE epics SET trashed_at = ?2, revision = revision + 1, updated_at = ?2
                        WHERE id = ?1",
                params![id, at],
            ),
            _ => return Err(Error::Invalid(format!("unknown epic action {action}"))),
        }
        .map_err(sql_error)?;
        let after = epic_in(&tx, id)?;
        record_activity(
            &tx,
            ("epic", id),
            &at,
            action,
            &format!("{} epic", uppercase_first(action)),
            Some(serde_json::to_value(&before).unwrap()),
            Some(serde_json::to_value(&after).unwrap()),
        )?;
        bump_store_revision(&tx, &at)?;
        tx.commit().map_err(sql_error)?;
        Ok(after)
    }
}

fn uppercase_first(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

impl Workspace {
    pub fn planner_epics(
        &self,
        include_archived: bool,
        include_trashed: bool,
    ) -> Result<Vec<Epic>> {
        self.planner()?
            .list_epics(include_archived, include_trashed)
    }

    pub fn create_planner_epic(&self, input: CreateEpic) -> Result<Epic> {
        self.planner()?.create_epic(input)
    }

    pub fn update_planner_epic(&self, id: &str, input: UpdateEpic) -> Result<Epic> {
        self.planner()?.update_epic(id, input)
    }

    pub fn archive_planner_epic(&self, id: &str, expected_revision: i64) -> Result<Epic> {
        self.planner()?.archive_epic(id, expected_revision)
    }

    pub fn restore_planner_epic(&self, id: &str, expected_revision: i64) -> Result<Epic> {
        self.planner()?.restore_epic(id, expected_revision)
    }

    pub fn trash_planner_epic(&self, id: &str, expected_revision: i64) -> Result<Epic> {
        self.planner()?.trash_epic(id, expected_revision)
    }
}
