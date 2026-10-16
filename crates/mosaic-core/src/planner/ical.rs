use super::{
    CreateEvent, PlannerEvent, PlannerStore, bump_store_revision, now, record_activity, sql_error,
    store_revision,
};
use crate::api::Workspace;
use crate::error::{Error, Result};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IcalImportCandidate {
    pub key: String,
    pub source_uid: String,
    pub recurrence_id: String,
    pub title: String,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
    pub recurrence_rule: Option<String>,
    pub duplicate: bool,
    pub event: CreateEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IcalImportPreview {
    pub planner_revision: i64,
    pub source_kind: String,
    pub candidates: Vec<IcalImportCandidate>,
    pub duplicates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IcalImportResult {
    pub planner_revision: i64,
    pub imported_event_ids: Vec<String>,
    pub skipped_duplicates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct OverlayOccurrence {
    pub source_id: String,
    pub source_name: String,
    pub uid: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub meeting_url: Option<String>,
    pub all_day: bool,
    pub start_value: String,
    pub end_value: String,
    pub timezone: String,
    pub occurrence_key: String,
    pub color: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone)]
struct ParsedEvent {
    uid: String,
    recurrence_id: String,
    event: CreateEvent,
}

type IcalProperty<'a> = (&'a str, Vec<(&'a str, &'a str)>, &'a str);

fn unfolded(content: &str) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for raw in content.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !result.is_empty() {
            result.last_mut().unwrap().push_str(raw.trim_start());
        } else {
            result.push(raw.to_string());
        }
    }
    result
}

fn property(line: &str) -> Option<IcalProperty<'_>> {
    let (head, value) = line.split_once(':')?;
    let mut parts = head.split(';');
    let name = parts.next()?;
    let parameters = parts
        .filter_map(|part| part.split_once('='))
        .collect::<Vec<_>>();
    Some((name, parameters, value))
}

fn text(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

fn datetime(
    value: &str,
    params: &[(&str, &str)],
    fallback_timezone: &str,
) -> Result<(bool, String, String)> {
    let is_date = params.iter().any(|(key, value)| {
        key.eq_ignore_ascii_case("VALUE") && value.eq_ignore_ascii_case("DATE")
    }) || value.len() == 8;
    let timezone = params
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("TZID"))
        .map(|(_, value)| *value)
        .unwrap_or(fallback_timezone);
    if is_date {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d")
            .map_err(|_| Error::Invalid(format!("invalid iCalendar date {value:?}")))?;
        return Ok((true, date.to_string(), timezone.to_string()));
    }
    if value.ends_with('Z') {
        let time = NaiveDateTime::parse_from_str(value.trim_end_matches('Z'), "%Y%m%dT%H%M%S")
            .map_err(|_| Error::Invalid(format!("invalid iCalendar UTC time {value:?}")))?;
        return Ok((
            false,
            time.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
            timezone.to_string(),
        ));
    }
    let time = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .map_err(|_| Error::Invalid(format!("invalid iCalendar local time {value:?}")))?;
    let tz: Tz = timezone
        .parse()
        .map_err(|_| Error::Invalid(format!("unknown iCalendar timezone {timezone:?}")))?;
    let time = tz
        .from_local_datetime(&time)
        .earliest()
        .ok_or_else(|| Error::Invalid(format!("iCalendar time {value:?} does not exist")))?;
    Ok((
        false,
        time.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        timezone.to_string(),
    ))
}

fn parse(content: &str, fallback_timezone: &str) -> Result<Vec<ParsedEvent>> {
    if content.len() > 10 * 1024 * 1024 {
        return Err(Error::Invalid(
            "iCalendar input is larger than 10 MB".into(),
        ));
    }
    let lines = unfolded(content);
    if !lines
        .iter()
        .any(|line| line.eq_ignore_ascii_case("BEGIN:VCALENDAR"))
    {
        return Err(Error::Invalid("input is not an iCalendar document".into()));
    }
    let mut result = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut inside = false;
    for line in lines {
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            inside = true;
            current.clear();
        } else if line.eq_ignore_ascii_case("END:VEVENT") {
            if !inside {
                continue;
            }
            inside = false;
            let mut uid = None;
            let mut recurrence_id = String::new();
            let mut title = "Untitled event".to_string();
            let mut description = String::new();
            let mut location = String::new();
            let mut meeting_url = None;
            let mut participants = Vec::new();
            let mut start = None;
            let mut end = None;
            let mut recurrence_rule = None;
            for item in &current {
                let Some((name, parameters, value)) = property(item) else {
                    continue;
                };
                match name.to_ascii_uppercase().as_str() {
                    "UID" => uid = Some(value.trim().to_string()),
                    "RECURRENCE-ID" => recurrence_id = value.trim().to_string(),
                    "SUMMARY" => title = text(value),
                    "DESCRIPTION" => description = text(value),
                    "LOCATION" => location = text(value),
                    "URL" => meeting_url = Some(value.trim().to_string()),
                    "ATTENDEE" => {
                        participants.push(value.trim().trim_start_matches("mailto:").to_string())
                    }
                    "DTSTART" => {
                        start = Some(datetime(value.trim(), &parameters, fallback_timezone)?)
                    }
                    "DTEND" => end = Some(datetime(value.trim(), &parameters, fallback_timezone)?),
                    "RRULE" => recurrence_rule = Some(value.trim().to_string()),
                    _ => {}
                }
            }
            let uid = uid.ok_or_else(|| Error::Invalid("VEVENT is missing UID".into()))?;
            let (all_day, start_value, timezone) = start
                .ok_or_else(|| Error::Invalid(format!("VEVENT {uid:?} is missing DTSTART")))?;
            let end_value = if let Some((end_all_day, end, _)) = end {
                if end_all_day != all_day {
                    return Err(Error::Invalid(format!(
                        "VEVENT {uid:?} mixes date and date-time boundaries"
                    )));
                }
                end
            } else if all_day {
                (NaiveDate::parse_from_str(&start_value, "%Y-%m-%d").unwrap() + Duration::days(1))
                    .to_string()
            } else {
                (DateTime::parse_from_rfc3339(&start_value).unwrap() + Duration::hours(1))
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            };
            result.push(ParsedEvent {
                uid,
                recurrence_id,
                event: CreateEvent {
                    title,
                    description,
                    location,
                    meeting_url,
                    participants,
                    epic_id: None,
                    color: None,
                    all_day,
                    start_value,
                    end_value,
                    timezone,
                    recurrence_rule,
                },
            });
        } else if inside {
            current.push(line);
        }
    }
    if result.is_empty() {
        return Err(Error::Invalid("iCalendar document has no events".into()));
    }
    Ok(result)
}

pub fn validate_ical(content: &str, fallback_timezone: &str) -> Result<usize> {
    parse(content, fallback_timezone).map(|events| events.len())
}

fn candidate_key(uid: &str, recurrence_id: &str) -> String {
    format!("{uid}\u{0}{recurrence_id}")
}

impl PlannerStore {
    pub fn preview_ical_import(
        &self,
        source_kind: &str,
        content: &str,
        fallback_timezone: &str,
    ) -> Result<IcalImportPreview> {
        let parsed = parse(content, fallback_timezone)?;
        let mut candidates = Vec::with_capacity(parsed.len());
        for parsed in parsed {
            let duplicate: bool = self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM event_imports WHERE source_kind = ?1
                     AND source_uid = ?2 AND recurrence_id = ?3)",
                    params![source_kind, parsed.uid, parsed.recurrence_id],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            candidates.push(IcalImportCandidate {
                key: candidate_key(&parsed.uid, &parsed.recurrence_id),
                source_uid: parsed.uid,
                recurrence_id: parsed.recurrence_id,
                title: parsed.event.title.clone(),
                all_day: parsed.event.all_day,
                start_value: parsed.event.start_value.clone(),
                end_value: parsed.event.end_value.clone(),
                timezone: parsed.event.timezone.clone(),
                recurrence_rule: parsed.event.recurrence_rule.clone(),
                duplicate,
                event: parsed.event,
            });
        }
        let duplicates = candidates.iter().filter(|item| item.duplicate).count();
        Ok(IcalImportPreview {
            planner_revision: store_revision(&self.conn)?,
            source_kind: source_kind.to_string(),
            candidates,
            duplicates,
        })
    }

    pub fn import_ical(
        &mut self,
        preview: &IcalImportPreview,
        selected_keys: &[String],
        allow_duplicates: bool,
    ) -> Result<IcalImportResult> {
        let selected = selected_keys.iter().cloned().collect::<HashSet<_>>();
        let known = preview
            .candidates
            .iter()
            .map(|candidate| candidate.key.clone())
            .collect::<HashSet<_>>();
        if !selected.is_subset(&known) {
            return Err(Error::Invalid(
                "iCalendar selection contains an unknown event".into(),
            ));
        }
        let tx = self.conn.transaction().map_err(sql_error)?;
        let at = now();
        let mut imported_event_ids = Vec::new();
        let mut skipped_duplicates = Vec::new();
        for candidate in preview
            .candidates
            .iter()
            .filter(|candidate| selected.contains(&candidate.key))
        {
            let duplicate: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM event_imports WHERE source_kind = ?1
                     AND source_uid = ?2 AND recurrence_id = ?3)",
                    params![
                        preview.source_kind,
                        candidate.source_uid,
                        candidate.recurrence_id
                    ],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if duplicate && !allow_duplicates {
                skipped_duplicates.push(candidate.key.clone());
                continue;
            }
            let event = super::calendar::insert_event(&tx, candidate.event.clone(), None, &at)?;
            tx.execute(
                "INSERT INTO event_imports(source_kind, source_uid, recurrence_id, imported_event_id, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![preview.source_kind, candidate.source_uid, candidate.recurrence_id, event.id, at],
            )
            .map_err(sql_error)?;
            record_activity(
                &tx,
                ("event", &event.id),
                &at,
                "imported",
                "Imported iCalendar event",
                None,
                Some(serde_json::to_value(&event).unwrap()),
            )?;
            imported_event_ids.push(event.id);
        }
        if !imported_event_ids.is_empty() {
            bump_store_revision(&tx, &at)?;
        }
        let revision = store_revision(&tx)?;
        tx.commit().map_err(sql_error)?;
        Ok(IcalImportResult {
            planner_revision: revision,
            imported_event_ids,
            skipped_duplicates,
        })
    }

    pub fn export_ical(&self) -> Result<String> {
        let mut output = vec![
            "BEGIN:VCALENDAR".to_string(),
            "VERSION:2.0".to_string(),
            "PRODID:-//Mosaic//Planner//EN".to_string(),
            "CALSCALE:GREGORIAN".to_string(),
        ];
        for event in self.list_events(false, false)? {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT occurrence_key, action, replacement_event_id FROM event_exceptions
                     WHERE series_id = ?1 ORDER BY occurrence_key",
                )
                .map_err(sql_error)?;
            let exceptions = stmt
                .query_map([&event.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(sql_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(sql_error)?;
            let exclusions = exceptions
                .iter()
                .filter(|(_, action, _)| action == "cancelled")
                .map(|(key, _, _)| occurrence_property(&event, key, "EXDATE"))
                .collect::<Result<Vec<_>>>()?;
            let uid = format!("mosaic-{}@local", event.id);
            write_event(&mut output, &event, &uid, None, &exclusions)?;
            for (key, action, replacement) in exceptions {
                if action == "cancelled" {
                } else if let Some(replacement) = replacement {
                    let replacement = self
                        .conn
                        .query_row(
                            "SELECT id, series_id, title, description, location, meeting_url,
                             participants_json, epic_id, color, all_day, start_value, end_value,
                             timezone, recurrence_rule, revision, created_at, updated_at,
                             archived_at, trashed_at FROM events WHERE id = ?1",
                            [replacement],
                            super::calendar::row_to_event,
                        )
                        .optional()
                        .map_err(sql_error)?;
                    if let Some(replacement) = replacement {
                        let recurrence_id = occurrence_property(&event, &key, "RECURRENCE-ID")?;
                        write_event(&mut output, &replacement, &uid, Some(&recurrence_id), &[])?;
                    }
                }
            }
        }
        output.push("END:VCALENDAR".into());
        Ok(format!("{}\r\n", output.join("\r\n")))
    }
}

fn escaped(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace(',', "\\,")
        .replace(';', "\\;")
}

fn write_event(
    output: &mut Vec<String>,
    event: &PlannerEvent,
    uid: &str,
    recurrence_id: Option<&str>,
    extra_properties: &[String],
) -> Result<()> {
    output.push("BEGIN:VEVENT".into());
    output.push(format!("UID:{uid}"));
    output.push(format!(
        "DTSTAMP:{}",
        DateTime::parse_from_rfc3339(&event.updated_at)
            .unwrap_or_else(|_| Utc::now().into())
            .with_timezone(&Utc)
            .format("%Y%m%dT%H%M%SZ")
    ));
    if let Some(recurrence_id) = recurrence_id {
        output.push(recurrence_id.to_string());
    }
    if event.all_day {
        output.push(format!(
            "DTSTART;VALUE=DATE:{}",
            event.start_value.replace('-', "")
        ));
        output.push(format!(
            "DTEND;VALUE=DATE:{}",
            event.end_value.replace('-', "")
        ));
    } else {
        let tz: Tz = event
            .timezone
            .parse()
            .map_err(|_| Error::Invalid(format!("unknown timezone {:?}", event.timezone)))?;
        let start = DateTime::parse_from_rfc3339(&event.start_value)
            .map_err(|_| Error::Invalid("invalid event start".into()))?
            .with_timezone(&tz);
        let end = DateTime::parse_from_rfc3339(&event.end_value)
            .map_err(|_| Error::Invalid("invalid event end".into()))?
            .with_timezone(&tz);
        output.push(format!(
            "DTSTART;TZID={}:{}",
            event.timezone,
            start.format("%Y%m%dT%H%M%S")
        ));
        output.push(format!(
            "DTEND;TZID={}:{}",
            event.timezone,
            end.format("%Y%m%dT%H%M%S")
        ));
    }
    output.push(format!("SUMMARY:{}", escaped(&event.title)));
    if !event.description.is_empty() {
        output.push(format!("DESCRIPTION:{}", escaped(&event.description)));
    }
    if !event.location.is_empty() {
        output.push(format!("LOCATION:{}", escaped(&event.location)));
    }
    if let Some(url) = &event.meeting_url {
        output.push(format!("URL:{url}"));
    }
    for participant in &event.participants {
        output.push(format!("ATTENDEE:mailto:{participant}"));
    }
    if recurrence_id.is_none()
        && let Some(rule) = &event.recurrence_rule
    {
        output.push(format!("RRULE:{rule}"));
    }
    output.extend(extra_properties.iter().cloned());
    output.push("END:VEVENT".into());
    Ok(())
}

fn occurrence_property(event: &PlannerEvent, occurrence_key: &str, name: &str) -> Result<String> {
    let date = NaiveDate::parse_from_str(occurrence_key, "%Y-%m-%d")
        .map_err(|_| Error::Invalid("invalid event occurrence key".into()))?;
    if event.all_day {
        return Ok(format!("{name};VALUE=DATE:{}", date.format("%Y%m%d")));
    }
    let tz: Tz = event
        .timezone
        .parse()
        .map_err(|_| Error::Invalid(format!("unknown timezone {:?}", event.timezone)))?;
    let start = DateTime::parse_from_rfc3339(&event.start_value)
        .map_err(|_| Error::Invalid("invalid event start".into()))?
        .with_timezone(&tz);
    Ok(format!(
        "{name};TZID={}:{}",
        event.timezone,
        date.and_time(start.time()).format("%Y%m%dT%H%M%S")
    ))
}

pub fn overlay_occurrences(
    content: &str,
    source_id: &str,
    source_name: &str,
    color: Option<String>,
    from: &str,
    to: &str,
    fallback_timezone: &str,
) -> Result<Vec<OverlayOccurrence>> {
    let from_date = NaiveDate::parse_from_str(from, "%Y-%m-%d")
        .map_err(|_| Error::Invalid("overlay from must be an ISO date".into()))?;
    let to_date = NaiveDate::parse_from_str(to, "%Y-%m-%d")
        .map_err(|_| Error::Invalid("overlay to must be an ISO date".into()))?;
    let mut result = Vec::new();
    for parsed in parse(content, fallback_timezone)? {
        let at = now();
        let event = PlannerEvent {
            id: parsed.uid.clone(),
            series_id: None,
            title: parsed.event.title,
            description: parsed.event.description,
            location: parsed.event.location,
            meeting_url: parsed.event.meeting_url,
            participants: parsed.event.participants,
            epic_id: None,
            color: color.clone(),
            all_day: parsed.event.all_day,
            start_value: parsed.event.start_value,
            end_value: parsed.event.end_value,
            timezone: parsed.event.timezone,
            recurrence_rule: parsed.event.recurrence_rule,
            revision: 1,
            created_at: at.clone(),
            updated_at: at,
            archived_at: None,
            trashed_at: None,
        };
        for (key, start, end) in super::recurrence::expand(&event, from_date, to_date)? {
            result.push(OverlayOccurrence {
                source_id: source_id.to_string(),
                source_name: source_name.to_string(),
                uid: parsed.uid.clone(),
                title: event.title.clone(),
                description: event.description.clone(),
                location: event.location.clone(),
                meeting_url: event.meeting_url.clone(),
                all_day: event.all_day,
                start_value: start,
                end_value: end,
                timezone: event.timezone.clone(),
                occurrence_key: key,
                color: color.clone(),
                read_only: true,
            });
        }
    }
    result.sort_by(|a, b| {
        a.start_value
            .cmp(&b.start_value)
            .then_with(|| a.title.cmp(&b.title))
    });
    Ok(result)
}

impl Workspace {
    pub fn preview_planner_ical_import(
        &self,
        source_kind: &str,
        content: &str,
        fallback_timezone: &str,
    ) -> Result<IcalImportPreview> {
        self.planner()?
            .preview_ical_import(source_kind, content, fallback_timezone)
    }

    pub fn import_planner_ical(
        &self,
        preview: &IcalImportPreview,
        selected_keys: &[String],
        allow_duplicates: bool,
    ) -> Result<IcalImportResult> {
        self.planner()?
            .import_ical(preview, selected_keys, allow_duplicates)
    }

    pub fn export_planner_ical(&self) -> Result<String> {
        self.planner()?.export_ical()
    }
}
