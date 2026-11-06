use super::service::PlannerService;
use super::{
    CreateEvent, PlannerEvent, PlannerStore, bump_store_revision, now, record_activity, sql_error,
    store_revision,
};
use crate::error::{Error, Result};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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
    /// Occurrence keys of this series that EXDATE or a cancelled override removed.
    #[serde(default)]
    pub excluded_occurrences: Vec<String>,
    /// Occurrence this candidate overrides (RECURRENCE-ID), if it is an override.
    #[serde(default)]
    pub recurrence_key: Option<String>,
    /// Timezone `recurrence_key` was resolved in, so it can be redone for another series.
    #[serde(default)]
    pub recurrence_timezone: Option<String>,
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

type RawDate = (String, Vec<(String, String)>);

#[derive(Debug, Clone)]
struct ParsedEvent {
    uid: String,
    recurrence_id: String,
    recurrence_key: Option<String>,
    excluded_occurrences: Vec<String>,
    // RECURRENCE-ID and EXDATE as written; their occurrence keys are resolved in the
    // series' timezone once the whole feed is read.
    raw_recurrence: Option<RawDate>,
    raw_exdates: Vec<RawDate>,
    key_timezone: String,
    cancelled: bool,
    revision: ParsedRevision,
    event: CreateEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ParsedRevision {
    sequence: u32,
    last_modified: String,
    dtstamp: String,
    source_order: usize,
}

type IcalProperty<'a> = (&'a str, Vec<(&'a str, &'a str)>, &'a str);

fn unfolded(content: &str) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for raw in content.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !result.is_empty() {
            result.last_mut().unwrap().push_str(&raw[1..]);
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
    // One left-to-right pass so each backslash is consumed exactly once; sequential `replace`
    // calls would turn the `\n` inside an escaped `\\n` into a newline.
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            result.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => result.push('\n'),
            Some(escaped @ ('\\' | ',' | ';')) => result.push(escaped),
            Some(other) => {
                result.push('\\');
                result.push(other);
            }
            None => result.push('\\'),
        }
    }
    result
}

fn title_marks_cancellation(title: &str) -> bool {
    let title = title.trim_start();
    ["canceled:", "cancelled:"].iter().any(|prefix| {
        title
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
    })
}

fn canonical_timezone(value: &str) -> Result<(Tz, String)> {
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    let canonical = value.parse::<Tz>().ok().map(|_| value).or_else(|| {
        // Outlook writes Windows timezone IDs into otherwise standard iCalendar feeds. CLDR's
        // territory-independent mapping gives us the canonical IANA zone understood everywhere
        // else in the planner.
        localzone::win_zone_to_iana(value, None)
    });
    let canonical =
        canonical.ok_or_else(|| Error::Invalid(format!("unknown iCalendar timezone {value:?}")))?;
    let parsed = canonical
        .parse::<Tz>()
        .map_err(|_| Error::Invalid(format!("unknown iCalendar timezone {value:?}")))?;
    Ok((parsed, canonical.to_string()))
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
    let (tz, timezone) = canonical_timezone(timezone)?;
    if is_date {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d")
            .map_err(|_| Error::Invalid(format!("invalid iCalendar date {value:?}")))?;
        return Ok((true, date.to_string(), timezone));
    }
    if value.ends_with('Z') {
        let time = NaiveDateTime::parse_from_str(value.trim_end_matches('Z'), "%Y%m%dT%H%M%S")
            .map_err(|_| Error::Invalid(format!("invalid iCalendar UTC time {value:?}")))?;
        return Ok((
            false,
            time.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
            timezone,
        ));
    }
    let time = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .map_err(|_| Error::Invalid(format!("invalid iCalendar local time {value:?}")))?;
    let time = tz
        .from_local_datetime(&time)
        .earliest()
        .ok_or_else(|| Error::Invalid(format!("iCalendar time {value:?} does not exist")))?;
    Ok((
        false,
        time.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        timezone,
    ))
}

/// The occurrence date of `value` in `series_timezone`, which is how recurrence expansion keys
/// occurrences. A UTC value or one with its own TZID can fall on another date elsewhere.
fn occurrence_key(value: &str, params: &[(&str, &str)], series_timezone: &str) -> Result<String> {
    let (all_day, start, _) = datetime(value, params, series_timezone)?;
    if all_day {
        return Ok(start);
    }
    let (timezone, _) = canonical_timezone(series_timezone)?;
    Ok(DateTime::parse_from_rfc3339(&start)
        .map_err(|_| Error::Invalid("invalid recurrence date-time".into()))?
        .with_timezone(&timezone)
        .date_naive()
        .to_string())
}

fn owned_date(value: &str, params: &[(&str, &str)]) -> RawDate {
    (
        value.trim().to_string(),
        params
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

fn parse(content: &str, fallback_timezone: &str) -> Result<Vec<ParsedEvent>> {
    if content.len() > 10 * 1024 * 1024 {
        return Err(Error::Invalid(
            "iCalendar input is larger than 10 MB".into(),
        ));
    }
    // Outlook and Windows tools often prefix feeds with a UTF-8 BOM.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines = unfolded(content);
    if !lines
        .iter()
        .any(|line| line.eq_ignore_ascii_case("BEGIN:VCALENDAR"))
    {
        return Err(Error::Invalid("input is not an iCalendar document".into()));
    }
    let calendar_cancelled = lines.iter().any(|line| {
        property(line).is_some_and(|(name, _, value)| {
            name.eq_ignore_ascii_case("METHOD") && value.trim().eq_ignore_ascii_case("CANCEL")
        })
    });
    let mut result = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut inside = false;
    let mut nested = 0usize;
    for line in lines {
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            inside = true;
            nested = 0;
            current.clear();
        } else if line.eq_ignore_ascii_case("END:VEVENT") {
            if !inside {
                continue;
            }
            inside = false;
            nested = 0;
            let mut uid = None;
            let mut recurrence_id = String::new();
            let mut raw_recurrence = None;
            let mut raw_exdates = Vec::new();
            let mut cancelled = calendar_cancelled;
            let mut sequence = 0;
            let mut last_modified = String::new();
            let mut dtstamp = String::new();
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
                    "RECURRENCE-ID" => {
                        recurrence_id = value.trim().to_string();
                        raw_recurrence = Some(owned_date(value, &parameters));
                    }
                    "EXDATE" => {
                        for value in value.split(',') {
                            raw_exdates.push(owned_date(value, &parameters));
                        }
                    }
                    "STATUS" => cancelled |= value.trim().eq_ignore_ascii_case("CANCELLED"),
                    "SEQUENCE" => sequence = value.trim().parse().unwrap_or(0),
                    "LAST-MODIFIED" => last_modified = value.trim().to_string(),
                    "DTSTAMP" => dtstamp = value.trim().to_string(),
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
            cancelled |= title_marks_cancellation(&title);
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
                recurrence_key: None,
                excluded_occurrences: Vec::new(),
                raw_recurrence,
                raw_exdates,
                key_timezone: String::new(),
                cancelled,
                revision: ParsedRevision {
                    sequence,
                    last_modified,
                    dtstamp,
                    source_order: result.len(),
                },
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
            // Properties of nested components (e.g. VALARM) are not event properties.
            let upper = line.to_ascii_uppercase();
            if upper.starts_with("BEGIN:") {
                nested += 1;
            } else if upper.starts_with("END:") {
                nested = nested.saturating_sub(1);
            } else if nested == 0 {
                current.push(line);
            }
        }
    }
    if result.is_empty() {
        return Err(Error::Invalid("iCalendar document has no events".into()));
    }
    let series_timezones = result
        .iter()
        .filter(|event| event.recurrence_id.is_empty())
        .map(|event| (event.uid.clone(), event.event.timezone.clone()))
        .collect::<HashMap<_, _>>();
    for event in &mut result {
        let timezone = series_timezones
            .get(&event.uid)
            .unwrap_or(&event.event.timezone)
            .clone();
        let key = |(value, params): &RawDate| {
            let params = params
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect::<Vec<_>>();
            occurrence_key(value, &params, &timezone)
        };
        event.key_timezone = timezone.clone();
        event.recurrence_key = event.raw_recurrence.as_ref().map(key).transpose()?;
        event.excluded_occurrences = event
            .raw_exdates
            .iter()
            .map(key)
            .collect::<Result<Vec<_>>>()?;
    }
    let mut latest = HashMap::<String, usize>::new();
    for (index, event) in result.iter().enumerate() {
        let identity = candidate_key(&event.uid, &event.recurrence_id);
        if latest
            .get(&identity)
            .is_none_or(|current| event.revision > result[*current].revision)
        {
            latest.insert(identity, index);
        }
    }
    Ok(result
        .into_iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (latest.get(&candidate_key(&event.uid, &event.recurrence_id)) == Some(&index))
                .then_some(event)
        })
        // One event with a recurrence rule we cannot expand must not reject the whole feed.
        .filter(|event| {
            event.cancelled
                || super::recurrence::normalize_rule(event.event.recurrence_rule.clone()).is_ok()
        })
        .collect())
}

pub fn validate_ical(content: &str, fallback_timezone: &str) -> Result<usize> {
    let events = parse(content, fallback_timezone)?;
    // Validate recurrence before a subscription replaces its last working cache.
    for event in events.iter().filter(|event| !event.cancelled) {
        super::recurrence::normalize_rule(event.event.recurrence_rule.clone())?;
    }
    Ok(events.len())
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
        let mut cancelled_overrides = HashMap::<String, Vec<String>>::new();
        for event in parsed.iter().filter(|event| event.cancelled) {
            if let Some(key) = &event.recurrence_key {
                cancelled_overrides
                    .entry(event.uid.clone())
                    .or_default()
                    .push(key.clone());
            }
        }
        let mut candidates = Vec::with_capacity(parsed.len());
        for parsed in parsed.into_iter().filter(|event| !event.cancelled) {
            let mut excluded_occurrences = parsed.excluded_occurrences;
            if parsed.recurrence_key.is_none() {
                excluded_occurrences.extend(
                    cancelled_overrides
                        .get(&parsed.uid)
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
            }
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
                excluded_occurrences,
                recurrence_key: parsed.recurrence_key,
                recurrence_timezone: Some(parsed.key_timezone),
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
        let mut series_ids = HashMap::<String, String>::new();
        // Series first, so their overrides can link to them whatever the file order.
        let mut ordered = preview
            .candidates
            .iter()
            .filter(|candidate| selected.contains(&candidate.key))
            .collect::<Vec<_>>();
        ordered.sort_by_key(|candidate| candidate.recurrence_key.is_some());
        for candidate in ordered {
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
            let mut input = candidate.event.clone();
            let mut series_id = None;
            let mut link_key = candidate.recurrence_key.clone();
            if candidate.recurrence_key.is_some() {
                // An override replaces one occurrence of its imported series; without
                // the series it stays a standalone event.
                series_id = match series_ids.get(&candidate.source_uid) {
                    Some(id) => Some(id.clone()),
                    None => tx
                        .query_row(
                            "SELECT imported_event_id FROM event_imports WHERE source_kind = ?1
                             AND source_uid = ?2 AND recurrence_id = '' ORDER BY imported_at DESC LIMIT 1",
                            params![preview.source_kind, candidate.source_uid],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(sql_error)?,
                };
                // Link only when the series still recurs on that date; otherwise the
                // override would vanish from every listing, so keep it standalone.
                if let Some(id) = &series_id {
                    let series = match super::calendar::event_in(&tx, id) {
                        Ok(series) => Some(series),
                        Err(Error::NotFound(_)) => None,
                        Err(error) => return Err(error),
                    };
                    // Redo the key when it was resolved in another timezone than the series
                    // it links to; a value that needs its own TZID to be read is not linked.
                    if let Some(series) = &series
                        && candidate.recurrence_timezone.as_deref()
                            != Some(series.timezone.as_str())
                    {
                        let id = &candidate.recurrence_id;
                        link_key = (id.ends_with('Z') || id.len() == 8)
                            .then(|| occurrence_key(id, &[], &series.timezone).ok())
                            .flatten();
                    }
                    let key = link_key.clone().unwrap_or_default();
                    let linkable = match (series, NaiveDate::parse_from_str(&key, "%Y-%m-%d").ok())
                    {
                        (Some(series), Some(date)) => {
                            series.recurrence_rule.is_some()
                                && series.trashed_at.is_none()
                                && series.archived_at.is_none()
                                && super::recurrence::expand(&series, date, date)?
                                    .iter()
                                    .any(|(occurrence, _, _)| *occurrence == key)
                        }
                        _ => false,
                    };
                    if linkable {
                        input.recurrence_rule = None;
                    } else {
                        series_id = None;
                    }
                }
            }
            let event = super::calendar::insert_event(&tx, input, series_id.as_deref(), &at)?;
            if let Some(series_id) = &series_id {
                tx.execute(
                    "INSERT INTO event_exceptions(series_id, occurrence_key, action, replacement_event_id)
                     VALUES (?1, ?2, 'replaced', ?3)
                     ON CONFLICT(series_id, occurrence_key) DO UPDATE SET action = 'replaced', replacement_event_id = ?3",
                    params![series_id, link_key, event.id],
                )
                .map_err(sql_error)?;
            } else if candidate.recurrence_key.is_none() {
                series_ids.insert(candidate.source_uid.clone(), event.id.clone());
                for key in &candidate.excluded_occurrences {
                    tx.execute(
                        "INSERT INTO event_exceptions(series_id, occurrence_key, action, replacement_event_id)
                         VALUES (?1, ?2, 'cancelled', NULL)
                         ON CONFLICT(series_id, occurrence_key) DO NOTHING",
                        params![event.id, key],
                    )
                    .map_err(sql_error)?;
                }
            }
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
        let lines: Vec<String> = output.iter().map(|line| folded(line)).collect();
        Ok(format!("{}\r\n", lines.join("\r\n")))
    }
}

/// Fold one content line at 75 octets (RFC 5545 3.1) on char boundaries. Every entry in the
/// export is exactly one logical line, so any CR/LF left in an unescaped value (URL, ATTENDEE,
/// RRULE...) is dropped here instead of being allowed to inject extra properties.
/// A fold may split an escape sequence (folding is lexical), but avoids landing before a space
/// or tab when the segment has any other char, so importers that trim all leading whitespace of a continuation still unfold losslessly.
fn folded(line: &str) -> String {
    let chars: Vec<char> = line.chars().filter(|c| !matches!(c, '\r' | '\n')).collect();
    let mut result = String::with_capacity(chars.len() + chars.len() / 70 * 3);
    let (mut start, mut budget) = (0, 75);
    while start < chars.len() {
        let (mut end, mut used) = (start, 0);
        while end < chars.len() && used + chars[end].len_utf8() <= budget {
            used += chars[end].len_utf8();
            end += 1;
        }
        if end < chars.len() {
            let mut back = end;
            while back > start && matches!(chars[back], ' ' | '\t') {
                back -= 1;
            }
            if back > start {
                end = back;
            }
        }
        result.extend(&chars[start..end]);
        if end < chars.len() {
            result.push_str("\r\n ");
        }
        start = end;
        // A continuation line starts with one space that counts toward the 75 octets.
        budget = 74;
    }
    result
}

fn escaped(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
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
    let parsed_events = parse(content, fallback_timezone)?;
    let mut exclusions = HashMap::<String, HashSet<String>>::new();
    for event in &parsed_events {
        let excluded = exclusions.entry(event.uid.clone()).or_default();
        excluded.extend(event.excluded_occurrences.iter().cloned());
        if let Some(recurrence_key) = &event.recurrence_key {
            excluded.insert(recurrence_key.clone());
        }
    }
    let mut result = Vec::new();
    for parsed in parsed_events.into_iter().filter(|event| !event.cancelled) {
        let at = now();
        let is_exception = parsed.recurrence_key.is_some();
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
            recurrence_rule: if is_exception {
                None
            } else {
                parsed.event.recurrence_rule
            },
            revision: 1,
            created_at: at.clone(),
            updated_at: at,
            archived_at: None,
            trashed_at: None,
        };
        for (key, start, end) in super::recurrence::expand(&event, from_date, to_date)? {
            if !is_exception
                && exclusions
                    .get(&parsed.uid)
                    .is_some_and(|excluded| excluded.contains(&key))
            {
                continue;
            }
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

impl PlannerService {
    pub fn preview_ical_import(
        &self,
        source_kind: &str,
        content: &str,
        fallback_timezone: &str,
    ) -> Result<IcalImportPreview> {
        self.store()?
            .preview_ical_import(source_kind, content, fallback_timezone)
    }

    pub fn import_ical(
        &self,
        preview: &IcalImportPreview,
        selected_keys: &[String],
        allow_duplicates: bool,
    ) -> Result<IcalImportResult> {
        self.store()?
            .import_ical(preview, selected_keys, allow_duplicates)
    }

    pub fn export_ical(&self) -> Result<String> {
        self.store()?.export_ical()
    }
}
