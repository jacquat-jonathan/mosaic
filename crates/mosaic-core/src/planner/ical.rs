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
use sha2::{Digest, Sha256};
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
    #[serde(default)]
    pub warnings: Vec<String>,
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
    recurrence_key: Option<String>,
    excluded_occurrences: Vec<String>,
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
            result.push(raw.trim_start_matches('\u{feff}').to_string());
        }
    }
    result
}

fn split_unquoted(value: &str, delimiter: char) -> Vec<&str> {
    let mut quoted = false;
    let mut start = 0;
    let mut result = Vec::new();
    for (index, ch) in value.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == delimiter && !quoted {
            result.push(&value[start..index]);
            start = index + ch.len_utf8();
        }
    }
    result.push(&value[start..]);
    result
}

fn property(line: &str) -> Option<IcalProperty<'_>> {
    let mut quoted = false;
    let index = line.char_indices().find_map(|(index, ch)| {
        if ch == '"' {
            quoted = !quoted;
        }
        (ch == ':' && !quoted).then_some(index)
    })?;
    let parts = split_unquoted(&line[..index], ';');
    let parameters = parts
        .iter()
        .skip(1)
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key, value.trim_matches('"')))
        .collect();
    Some((parts[0], parameters, &line[index + 1..]))
}

fn text(value: &str) -> String {
    let mut output = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n' | 'N') => output.push('\n'),
                Some(ch @ ('\\' | ',' | ';')) => output.push(ch),
                Some(ch) => {
                    output.push('\\');
                    output.push(ch);
                }
                None => output.push('\\'),
            }
        } else {
            output.push(ch);
        }
    }
    output
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
    // Apple and Exchange sometimes prefix an IANA ID with a vendor namespace.
    let value = value
        .char_indices()
        .filter(|(_, ch)| *ch == '/')
        .map(|(index, _)| &value[index + 1..])
        .find(|suffix| suffix.parse::<Tz>().is_ok())
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
    let (tz, timezone) = canonical_timezone(if is_date || value.ends_with('Z') {
        fallback_timezone
    } else {
        timezone
    })?;
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

fn occurrence_date(value: &str, series_timezone: &str) -> Result<String> {
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Ok(date.to_string());
    }
    let (tz, _) = canonical_timezone(series_timezone)?;
    let instant = if let Ok(instant) = DateTime::parse_from_rfc3339(value) {
        Some(instant)
    } else if let Ok((_, parsed, _)) = datetime(value, &[], series_timezone) {
        DateTime::parse_from_rfc3339(&parsed).ok()
    } else {
        None
    };
    if let Some(instant) = instant {
        return Ok(instant.with_timezone(&tz).date_naive().to_string());
    }
    NaiveDate::parse_from_str(value, "%Y%m%d")
        .map(|date| date.to_string())
        .map_err(|_| Error::Invalid("invalid recurrence date-time".into()))
}

struct ParsedCalendar {
    events: Vec<ParsedEvent>,
    warnings: Vec<String>,
}

#[derive(Clone, Copy)]
struct IcalDuration {
    days: i64,
    seconds: i64,
}

fn ical_duration(value: &str) -> Result<IcalDuration> {
    let invalid = || Error::Invalid(format!("invalid iCalendar duration {value:?}"));
    let mut input = value
        .trim()
        .strip_prefix('+')
        .unwrap_or(value.trim())
        .chars();
    if input.next() != Some('P') {
        return Err(invalid());
    }
    let mut seconds = 0i64;
    let mut day_seconds = 0i64;
    let mut number = String::new();
    let mut time = false;
    let mut any = false;
    for ch in input {
        if ch.is_ascii_digit() {
            number.push(ch);
            continue;
        }
        if ch == 'T' && !time && number.is_empty() {
            time = true;
            continue;
        }
        let multiplier = match (ch, time) {
            ('W', false) => 604800,
            ('D', false) => 86400,
            ('H', true) => 3600,
            ('M', true) => 60,
            ('S', true) => 1,
            _ => return Err(invalid()),
        };
        let n = number.parse::<i64>().map_err(|_| invalid())?;
        let target = if time { &mut seconds } else { &mut day_seconds };
        *target = target
            .checked_add(n.checked_mul(multiplier).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        number.clear();
        any = true;
    }
    if !any || !number.is_empty() {
        return Err(invalid());
    }
    Duration::try_seconds(seconds.checked_add(day_seconds).ok_or_else(invalid)?)
        .ok_or_else(invalid)?;
    Ok(IcalDuration {
        days: day_seconds / 86400,
        seconds,
    })
}

fn end_after(start: &(bool, String, String), duration: IcalDuration) -> Result<String> {
    let invalid = || Error::Invalid("iCalendar event duration is out of range".into());
    if start.0 {
        if duration.seconds != 0 {
            return Err(invalid());
        }
        return NaiveDate::parse_from_str(&start.1, "%Y-%m-%d")
            .map_err(|_| invalid())?
            .checked_add_signed(Duration::days(duration.days))
            .map(|date| date.to_string())
            .ok_or_else(invalid);
    }
    let tz: Tz = start.2.parse().map_err(|_| invalid())?;
    let date = DateTime::parse_from_rfc3339(&start.1)
        .map_err(|_| invalid())?
        .with_timezone(&tz);
    // RFC durations add nominal days before exact hours, so P1D preserves wall time over DST.
    let days = duration.days;
    let local = date
        .naive_local()
        .checked_add_signed(Duration::days(days))
        .ok_or_else(invalid)?;
    let end = tz
        .from_local_datetime(&local)
        .earliest()
        .ok_or_else(invalid)?
        .checked_add_signed(Duration::seconds(duration.seconds))
        .ok_or_else(invalid)?;
    Ok(end
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn read_ical_date(
    field: &IcalProperty<'_>,
    fallback: &str,
    aliases: &HashMap<String, String>,
    warnings: &mut Vec<String>,
    title: &str,
) -> Result<(bool, String, String)> {
    let mut parameters = field.1.clone();
    for (key, value) in &mut parameters {
        if key.eq_ignore_ascii_case("TZID") {
            if let Some(alias) = aliases.get(*value) {
                *value = alias;
            }
            if canonical_timezone(value).is_err() && !field.2.ends_with('Z') {
                warnings.push(format!(
                    "{title}: unknown timezone {value:?}; using {fallback}."
                ));
                *value = fallback;
            }
        }
    }
    datetime(field.2.trim(), &parameters, fallback)
}

fn parse_event(
    lines: &[String],
    fallback: &str,
    aliases: &HashMap<String, String>,
    warnings: &mut Vec<String>,
    order: usize,
    calendar_cancelled: bool,
) -> Result<Vec<ParsedEvent>> {
    let fields = lines
        .iter()
        .filter_map(|line| property(line))
        .collect::<Vec<_>>();
    let get = |name: &str| {
        fields
            .iter()
            .find(|field| field.0.eq_ignore_ascii_case(name))
    };
    let uid = get("UID")
        .map(|field| field.2.trim().to_string())
        .filter(|uid| !uid.is_empty())
        .unwrap_or_else(|| {
            warnings.push(format!(
                "Event {} has no UID; generated a stable identifier.",
                order + 1
            ));
            format!(
                "mosaic-{}",
                Sha256::digest(lines.join("\n").as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )
        });
    let title = get("SUMMARY")
        .map(|field| text(field.2))
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Untitled event".into());
    if get("EXRULE").is_some() {
        warnings.push(format!(
            "{title}: legacy EXRULE is not supported; use EXDATE exclusions."
        ));
    }
    if fields
        .iter()
        .filter(|field| field.0.eq_ignore_ascii_case("RRULE"))
        .count()
        > 1
    {
        warnings.push(format!(
            "{title}: multiple recurrence rules; kept the first rule."
        ));
    }
    if get("RECURRENCE-ID").is_some_and(|field| {
        field.1.iter().any(|(key, value)| {
            key.eq_ignore_ascii_case("RANGE") && value.eq_ignore_ascii_case("THISANDFUTURE")
        })
    }) {
        warnings.push(format!(
            "{title}: THISANDFUTURE changes apply to this occurrence only."
        ));
    }
    let cancelled = calendar_cancelled
        || get("STATUS").is_some_and(|field| field.2.trim().eq_ignore_ascii_case("CANCELLED"))
        || title_marks_cancellation(&title);
    let recurrence = get("RECURRENCE-ID");
    let recurrence_id = recurrence
        .map(|field| field.2.trim().to_string())
        .unwrap_or_default();
    let recurrence_key = recurrence
        .map(|field| read_ical_date(field, fallback, aliases, warnings, &title))
        .transpose()?
        .map(|value| value.1);
    let cancellation_start = ("DTSTART", vec![], "19700101T000000Z");
    let start = get("DTSTART")
        .or(if cancelled {
            recurrence.or(Some(&cancellation_start))
        } else {
            None
        })
        .ok_or_else(|| Error::Invalid(format!("VEVENT {uid:?} is missing DTSTART")))?;
    let start = read_ical_date(start, fallback, aliases, warnings, &title)?;
    let mut excluded = Vec::new();
    for field in fields
        .iter()
        .filter(|field| field.0.eq_ignore_ascii_case("EXDATE"))
    {
        for value in field.2.split(',') {
            let field = (field.0, field.1.clone(), value);
            match read_ical_date(&field, fallback, aliases, warnings, &title) {
                Ok(value) => excluded.push(value.1),
                Err(error) => warnings.push(format!("{title}: ignored EXDATE: {error}")),
            }
        }
    }
    let end = if let Some(end) = get("DTEND") {
        let end = read_ical_date(end, fallback, aliases, warnings, &title)?;
        if end.0 != start.0 {
            return Err(Error::Invalid(format!(
                "VEVENT {uid:?} mixes date and date-time boundaries"
            )));
        }
        end.1
    } else {
        let duration = get("DURATION")
            .map(|field| ical_duration(field.2))
            .transpose()?
            .unwrap_or(IcalDuration {
                days: i64::from(start.0),
                seconds: 0,
            });
        end_after(&start, duration)?
    };
    if end < start.1 || (start.0 && end == start.1) {
        return Err(Error::Invalid(format!(
            "{title}: event end must be after its start"
        )));
    }
    let rule = get("RRULE").map(|field| field.2.trim().to_string());
    let recurrence_rule = match super::recurrence::normalize_rule(rule).and_then(|rule| {
        if let Some(rule) = &rule {
            let tz: rrule::Tz = start.2.parse::<Tz>().unwrap().into();
            let date = if start.0 {
                tz.from_local_datetime(
                    &NaiveDate::parse_from_str(&start.1, "%Y-%m-%d")
                        .unwrap()
                        .and_hms_opt(0, 0, 0)
                        .unwrap(),
                )
                .earliest()
                .ok_or_else(|| Error::Invalid("invalid recurring start".into()))?
            } else {
                DateTime::parse_from_rfc3339(&start.1)
                    .unwrap()
                    .with_timezone(&tz)
            };
            super::recurrence::validated_rfc_rule(rule, date)?;
        }
        Ok(rule)
    }) {
        Ok(rule) => rule,
        Err(error) => {
            warnings.push(format!(
                "{title}: recurrence could not be read; kept the first occurrence ({error})."
            ));
            None
        }
    };
    let parsed = ParsedEvent {
        uid,
        recurrence_id,
        recurrence_key,
        excluded_occurrences: excluded,
        key_timezone: start.2.clone(),
        cancelled,
        revision: ParsedRevision {
            sequence: get("SEQUENCE")
                .and_then(|field| field.2.parse().ok())
                .unwrap_or(0),
            last_modified: get("LAST-MODIFIED")
                .map(|field| field.2.to_string())
                .unwrap_or_default(),
            dtstamp: get("DTSTAMP")
                .map(|field| field.2.to_string())
                .unwrap_or_default(),
            source_order: order,
        },
        event: CreateEvent {
            title,
            description: get("DESCRIPTION")
                .map(|field| text(field.2))
                .unwrap_or_default(),
            location: get("LOCATION")
                .map(|field| text(field.2))
                .unwrap_or_default(),
            meeting_url: get("URL")
                .or_else(|| get("CONFERENCE"))
                .map(|field| field.2.trim().to_string()),
            participants: fields
                .iter()
                .filter(|field| field.0.eq_ignore_ascii_case("ATTENDEE"))
                .map(|field| field.2.trim())
                .map(|value| {
                    if value
                        .get(..7)
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
                    {
                        &value[7..]
                    } else {
                        value
                    }
                })
                .map(str::to_string)
                .collect(),
            epic_id: None,
            color: get("COLOR").map(|field| field.2.trim().to_string()),
            all_day: start.0,
            start_value: start.1,
            end_value: end,
            timezone: start.2,
            recurrence_rule,
        },
    };
    let mut result = vec![parsed];
    for field in fields
        .iter()
        .filter(|field| field.0.eq_ignore_ascii_case("RDATE"))
    {
        for value in field.2.split(',') {
            let added = (|| -> Result<ParsedEvent> {
                let (value, period) = value
                    .split_once('/')
                    .map_or((value, None), |(start, end)| (start, Some(end)));
                let date = read_ical_date(
                    &(field.0, field.1.clone(), value),
                    fallback,
                    aliases,
                    warnings,
                    &result[0].event.title,
                )?;
                if date.0 != result[0].event.all_day {
                    return Err(Error::Invalid("RDATE has a different date type".into()));
                }
                let mut event = result[0].clone();
                let duration = if event.event.all_day {
                    NaiveDate::parse_from_str(&event.event.end_value, "%Y-%m-%d").unwrap()
                        - NaiveDate::parse_from_str(&event.event.start_value, "%Y-%m-%d").unwrap()
                } else {
                    DateTime::parse_from_rfc3339(&event.event.end_value).unwrap()
                        - DateTime::parse_from_rfc3339(&event.event.start_value).unwrap()
                };
                event.event.end_value = match period {
                    Some(end) if end.starts_with('P') || end.starts_with('+') => {
                        end_after(&date, ical_duration(end)?)?
                    }
                    Some(end) => {
                        read_ical_date(
                            &(field.0, field.1.clone(), end),
                            fallback,
                            aliases,
                            warnings,
                            &result[0].event.title,
                        )?
                        .1
                    }
                    None => end_after(
                        &date,
                        if event.event.all_day {
                            IcalDuration {
                                days: duration.num_days(),
                                seconds: 0,
                            }
                        } else {
                            IcalDuration {
                                days: 0,
                                seconds: duration.num_seconds(),
                            }
                        },
                    )?,
                };
                if event.event.end_value <= date.1 {
                    return Err(Error::Invalid("RDATE end must follow its start".into()));
                }
                event.recurrence_id = format!("RDATE:{}", date.1);
                event.recurrence_key = Some(date.1.clone());
                event.event.start_value = date.1;
                event.event.recurrence_rule = None;
                event.excluded_occurrences.clear();
                Ok(event)
            })();
            match added {
                Ok(event) => result.push(event),
                Err(error) => warnings.push(format!("Ignored RDATE: {error}")),
            }
        }
    }
    Ok(result)
}

fn parse(content: &str, fallback_timezone: &str) -> Result<ParsedCalendar> {
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
        || !lines
            .iter()
            .any(|line| line.eq_ignore_ascii_case("END:VCALENDAR"))
    {
        return Err(Error::Invalid(
            "input is not a complete iCalendar document".into(),
        ));
    }
    let mut aliases = HashMap::new();
    let mut zone_id = None;
    let mut inside_zone = false;
    for line in &lines {
        if line.eq_ignore_ascii_case("BEGIN:VTIMEZONE") {
            inside_zone = true;
            zone_id = None;
        }
        if line.eq_ignore_ascii_case("END:VTIMEZONE") {
            inside_zone = false;
        }
        if !inside_zone {
            continue;
        }
        if let Some((name, _, value)) = property(line) {
            if name.eq_ignore_ascii_case("TZID") {
                zone_id = Some(value.to_string());
            }
            if name.eq_ignore_ascii_case("X-LIC-LOCATION")
                && canonical_timezone(value).is_ok()
                && let Some(id) = &zone_id
            {
                aliases.insert(id.clone(), value.to_string());
            }
        }
    }
    let fallback = lines
        .iter()
        .filter_map(|line| property(line))
        .find(|field| field.0.eq_ignore_ascii_case("X-WR-TIMEZONE"))
        .and_then(|field| canonical_timezone(field.2).ok())
        .or_else(|| canonical_timezone(fallback_timezone).ok())
        .map(|value| value.1)
        .unwrap_or_else(|| "UTC".into());
    let mut result = Vec::new();
    let mut warnings = Vec::new();
    let mut current = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut calendar_cancelled = false;
    let mut event_count = 0;
    for line in lines {
        let Some((name, _, value)) = property(&line) else {
            continue;
        };
        if name.eq_ignore_ascii_case("BEGIN") {
            if value.eq_ignore_ascii_case("VEVENT") {
                if stack.last().is_some_and(|component| component == "VEVENT") {
                    warnings.push("Skipped an unterminated event.".into());
                    stack.pop();
                }
                current.clear();
                event_count += 1;
            }
            if value.eq_ignore_ascii_case("VCALENDAR") {
                calendar_cancelled = false;
            }
            stack.push(value.to_ascii_uppercase());
        } else if name.eq_ignore_ascii_case("END") {
            if value.eq_ignore_ascii_case("VEVENT") {
                match parse_event(
                    &current,
                    &fallback,
                    &aliases,
                    &mut warnings,
                    event_count,
                    calendar_cancelled,
                ) {
                    Ok(events) => result.extend(events),
                    Err(error) => warnings.push(format!("Skipped event {event_count}: {error}")),
                }
                current.clear();
            }
            if let Some(index) = stack
                .iter()
                .rposition(|component| component.eq_ignore_ascii_case(value))
            {
                stack.truncate(index);
            }
        } else if stack.last().is_some_and(|component| component == "VEVENT") {
            current.push(line);
        } else if stack
            .last()
            .is_some_and(|component| component == "VCALENDAR")
            && name.eq_ignore_ascii_case("METHOD")
        {
            calendar_cancelled = value.eq_ignore_ascii_case("CANCEL");
        }
    }
    if !current.is_empty() {
        warnings.push("Skipped an unterminated event.".into());
    }
    if result.is_empty() && event_count > 0 {
        return Err(Error::Invalid(format!(
            "iCalendar document has no readable events. {}",
            warnings
                .first()
                .map(String::as_str)
                .unwrap_or("Events are incomplete.")
        )));
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
        event.key_timezone = timezone;
    }
    let mut excluded_dates = HashMap::<String, HashSet<String>>::new();
    for event in &result {
        let excluded = excluded_dates.entry(event.uid.clone()).or_default();
        excluded.extend(event.excluded_occurrences.iter().cloned());
        if !event.recurrence_id.starts_with("RDATE:")
            && let Some(key) = &event.recurrence_key
        {
            excluded.insert(key.clone());
        }
    }
    result.retain(|event| {
        !event.recurrence_id.starts_with("RDATE:")
            || !excluded_dates
                .get(&event.uid)
                .is_some_and(|dates| dates.contains(&event.event.start_value))
    });
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
    let events = result
        .into_iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (latest.get(&candidate_key(&event.uid, &event.recurrence_id)) == Some(&index))
                .then_some(event)
        })
        .collect();
    warnings.sort();
    warnings.dedup();
    Ok(ParsedCalendar { events, warnings })
}

pub fn validate_ical(content: &str, fallback_timezone: &str) -> Result<usize> {
    Ok(parse(content, fallback_timezone)?.events.len())
}

pub fn ical_warnings(content: &str, fallback_timezone: &str) -> Result<Vec<String>> {
    Ok(parse(content, fallback_timezone)?.warnings)
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
        let mut exclusions = HashMap::<String, Vec<String>>::new();
        for item in &parsed.events {
            let values = exclusions.entry(item.uid.clone()).or_default();
            values.extend(item.excluded_occurrences.iter().cloned());
            if let Some(key) = &item.recurrence_key {
                values.push(key.clone());
            }
        }
        let mut candidates = Vec::with_capacity(parsed.events.len());
        for parsed in parsed.events.into_iter().filter(|event| !event.cancelled) {
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
                source_uid: parsed.uid.clone(),
                recurrence_id: parsed.recurrence_id.clone(),
                title: parsed.event.title.clone(),
                all_day: parsed.event.all_day,
                start_value: parsed.event.start_value.clone(),
                end_value: parsed.event.end_value.clone(),
                timezone: parsed.event.timezone.clone(),
                recurrence_rule: parsed.event.recurrence_rule.clone(),
                duplicate,
                excluded_occurrences: if parsed.recurrence_id.is_empty() {
                    exclusions.get(&parsed.uid).cloned().unwrap_or_default()
                } else {
                    vec![]
                },
                event: parsed.event,
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
            warnings: parsed.warnings,
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
            let link_key = candidate.recurrence_key.clone();
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
                    let key = link_key.clone().unwrap_or_default();
                    let timezone = series
                        .as_ref()
                        .map(|item| item.timezone.as_str())
                        .unwrap_or("UTC");
                    let link_date = occurrence_date(&key, timezone)
                        .ok()
                        .and_then(|value| NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok());
                    let linkable = match (series, link_date) {
                        (Some(series), Some(date)) => {
                            series.recurrence_rule.is_some()
                                && series.trashed_at.is_none()
                                && series.archived_at.is_none()
                                && super::recurrence::expand(&series, date, date)?.iter().any(
                                    |(occurrence, start, _)| *occurrence == key || *start == key,
                                )
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
    if let Ok(instant) = DateTime::parse_from_rfc3339(occurrence_key) {
        return Ok(format!(
            "{name}:{}",
            instant.with_timezone(&Utc).format("%Y%m%dT%H%M%SZ")
        ));
    }
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
    let parsed_events = parse(content, fallback_timezone)?.events;
    let mut exclusions = HashMap::<String, HashSet<String>>::new();
    let mut explicit_exclusions = HashMap::<String, HashSet<String>>::new();
    for event in &parsed_events {
        explicit_exclusions
            .entry(event.uid.clone())
            .or_default()
            .extend(event.excluded_occurrences.iter().cloned());
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
        let is_rdate = parsed.recurrence_id.starts_with("RDATE:");
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
            if is_rdate
                && explicit_exclusions
                    .get(&parsed.uid)
                    .is_some_and(|excluded| excluded.contains(&start))
            {
                continue;
            }
            if !is_exception
                && exclusions
                    .get(&parsed.uid)
                    .is_some_and(|excluded| excluded.contains(&start))
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
                occurrence_key: if is_rdate && !event.all_day {
                    event.start_value.clone()
                } else {
                    key
                },
                color: color.clone(),
                read_only: true,
            });
        }
    }
    let mut seen = HashSet::new();
    result.retain(|event| seen.insert((event.uid.clone(), event.start_value.clone())));
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

#[cfg(test)]
mod compatibility_tests {
    use super::*;

    fn calendar(events: &str) -> String {
        format!("BEGIN:VCALENDAR\nVERSION:2.0\n{events}\nEND:VCALENDAR\n")
    }

    fn event(fields: &str) -> String {
        format!("BEGIN:VEVENT\n{fields}\nEND:VEVENT")
    }

    fn overlays(content: &str, from: &str, to: &str) -> Vec<OverlayOccurrence> {
        overlay_occurrences(content, "test", "Test", None, from, to, "UTC").unwrap()
    }

    #[test]
    fn rich_event_properties_and_nested_components_do_not_break_import() {
        let content = calendar(&event(concat!(
            "UID:rich\nDTSTART;TZID=Europe/Zurich:20261105T090000\nDURATION:PT90M\n",
            "SUMMARY;LANGUAGE=fr:Réunion\nDESCRIPTION:Line one\\nLine two\n  indented\n",
            "LOCATION:Room\\, A\\; floor 2\nURL:https://example.test/meeting\n",
            "ATTENDEE;CN=\"Person: One; Team\";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:MAILTO:one@example.test\n",
            "ORGANIZER;CN=Host:mailto:host@example.test\nATTACH;FMTTYPE=application/pdf:https://example.test/agenda\n",
            "CATEGORIES:Work,Planning\nCLASS:PRIVATE\nCOMMENT:Optional\nCONTACT:Host\nGEO:47.3;8.5\n",
            "PERCENT-COMPLETE:20\nPRIORITY:1\nRELATED-TO:parent\nRESOURCES:Projector\nTRANSP:OPAQUE\n",
            "CREATED:20261101T000000Z\nDTSTAMP:20261102T000000Z\nSEQUENCE:2\nX-PROVIDER-FIELD:anything\n",
            "BEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT15M\nSUMMARY:Alarm title\nDESCRIPTION:Alarm description\nDURATION:PT5M\nREPEAT:2\nEND:VALARM"
        )));
        let mut store = PlannerStore::in_memory().unwrap();
        let preview = store.preview_ical_import("rich", &content, "UTC").unwrap();
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);
        let candidate = &preview.candidates[0];
        assert_eq!(candidate.title, "Réunion");
        assert_eq!(candidate.event.description, "Line one\nLine two indented");
        assert_eq!(candidate.event.location, "Room, A; floor 2");
        assert_eq!(candidate.event.participants, ["one@example.test"]);
        assert_eq!(candidate.start_value, "2026-11-05T08:00:00.000Z");
        assert_eq!(candidate.end_value, "2026-11-05T09:30:00.000Z");
        store
            .import_ical(&preview, std::slice::from_ref(&candidate.key), false)
            .unwrap();
        assert_eq!(store.list_events(false, false).unwrap().len(), 1);
        assert_eq!(text(r"literal \\n; real \n"), "literal \\n; real \n");
    }

    #[test]
    fn broken_events_and_optional_fields_are_isolated_with_warnings() {
        let content = calendar(&[
            event("UID:broken\nDTSTART:not-a-date"),
            event("UID:optional\nDTSTART;TZID=Unknown/Zone:20261105T090000\nEXDATE:broken\nRRULE:FREQ=UNKNOWN"),
            event("DTSTART;VALUE=DATE:20261106\nSUMMARY:No ID"),
        ].join("\n"));
        let mut store = PlannerStore::in_memory().unwrap();
        let preview = store
            .preview_ical_import("mixed", &content, "Europe/Zurich")
            .unwrap();
        assert_eq!(preview.candidates.len(), 2);
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("Skipped event"))
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("unknown timezone"))
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("EXDATE"))
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("first occurrence"))
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("no UID"))
        );
        assert_eq!(preview.candidates[0].recurrence_rule, None);
        let selected = preview
            .candidates
            .iter()
            .map(|candidate| candidate.key.clone())
            .collect::<Vec<_>>();
        store.import_ical(&preview, &selected, false).unwrap();
        assert_eq!(
            store
                .preview_ical_import("mixed", &content, "Europe/Zurich")
                .unwrap()
                .duplicates,
            2
        );
        assert!(validate_ical(&calendar(&event("UID:bad\nDTSTART:bad")), "UTC").is_err());
        assert_eq!(validate_ical(&calendar(""), "UTC").unwrap(), 0);
        assert!(validate_ical("BEGIN:VCALENDAR\nBEGIN:VEVENT", "UTC").is_err());
    }

    #[test]
    fn common_advanced_recurrence_rules_expand_and_import() {
        for (rule, from, to, expected) in [
            (
                "FREQ=DAILY;COUNT=3",
                "2026-01-01",
                "2026-01-07",
                vec!["2026-01-01", "2026-01-02", "2026-01-03"],
            ),
            (
                "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1;COUNT=2",
                "2026-01-01",
                "2027-03-01",
                vec!["2026-02-01", "2027-02-01"],
            ),
            (
                "FREQ=MONTHLY;BYDAY=1MO;COUNT=2",
                "2026-01-01",
                "2026-03-01",
                vec!["2026-01-05", "2026-02-02"],
            ),
            (
                "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2",
                "2026-01-01",
                "2026-03-01",
                vec!["2026-01-30", "2026-02-27"],
            ),
            (
                "FREQ=YEARLY;BYYEARDAY=100;COUNT=1",
                "2026-01-01",
                "2026-12-31",
                vec!["2026-04-10"],
            ),
            (
                "FREQ=DAILY;UNTIL=20260102T085959Z",
                "2026-01-01",
                "2026-01-05",
                vec!["2026-01-01"],
            ),
            (
                "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1;UNTIL=20261231",
                "2026-01-01",
                "2026-12-31",
                vec!["2026-02-01"],
            ),
        ] {
            let content = calendar(&event(&format!(
                "UID:advanced\nDTSTART:20260101T090000Z\nDURATION:PT1H\nRRULE:{rule}"
            )));
            let preview = PlannerStore::in_memory()
                .unwrap()
                .preview_ical_import("advanced", &content, "UTC")
                .unwrap();
            assert!(
                preview.warnings.is_empty(),
                "{rule}: {:?}",
                preview.warnings
            );
            assert_eq!(
                overlays(&content, from, to)
                    .iter()
                    .map(|item| item.occurrence_key.as_str())
                    .collect::<Vec<_>>(),
                expected,
                "{rule}"
            );
            let mut store = PlannerStore::in_memory().unwrap();
            store
                .import_ical(&preview, &[preview.candidates[0].key.clone()], false)
                .unwrap();
        }
    }

    #[test]
    fn subdaily_exclusions_and_additional_periods_keep_exact_instants() {
        let content = calendar(&event(concat!(
            "UID:subdaily\nDTSTART:20261105T090000Z\nDURATION:PT30M\n",
            "RRULE:FREQ=HOURLY;COUNT=3\nEXDATE:20261105T100000Z,20261106T090000Z\n",
            "RDATE:20261105T120000Z\nRDATE;VALUE=PERIOD:20261106T090000Z/PT2H,20261106T120000Z/20261106T140000Z"
        )));
        let items = overlays(&content, "2026-11-05", "2026-11-06");
        assert_eq!(
            items
                .iter()
                .map(|item| item.start_value.as_str())
                .collect::<Vec<_>>(),
            [
                "2026-11-05T09:00:00.000Z",
                "2026-11-05T11:00:00.000Z",
                "2026-11-05T12:00:00.000Z",
                "2026-11-06T12:00:00.000Z"
            ]
        );
        assert_eq!(items.last().unwrap().end_value, "2026-11-06T14:00:00.000Z");
        let mut store = PlannerStore::in_memory().unwrap();
        let preview = store
            .preview_ical_import("periods", &content, "UTC")
            .unwrap();
        let selected = preview
            .candidates
            .iter()
            .map(|item| item.key.clone())
            .collect::<Vec<_>>();
        store.import_ical(&preview, &selected, false).unwrap();
        let range = store.calendar_range("2026-11-05", "2026-11-06").unwrap();
        assert_eq!(range.events.len(), 4);
        let recurring = store
            .list_events(false, false)
            .unwrap()
            .into_iter()
            .find(|event| event.recurrence_rule.is_some())
            .unwrap();
        let keys = range
            .events
            .iter()
            .filter(|event| event.event_id == recurring.id)
            .map(|event| event.occurrence_key.clone())
            .collect::<HashSet<_>>();
        assert_eq!(
            keys.len(),
            2,
            "subdaily occurrences must have independent UI identities"
        );
        let exported = store.export_ical().unwrap();
        assert_eq!(overlays(&exported, "2026-11-05", "2026-11-06").len(), 4);
    }

    #[test]
    fn imported_subdaily_occurrences_can_be_cancelled_independently() {
        let content = calendar(&event(
            "UID:hourly\nDTSTART:20261105T090000Z\nDURATION:PT30M\nRRULE:FREQ=HOURLY;COUNT=3",
        ));
        let mut store = PlannerStore::in_memory().unwrap();
        let preview = store
            .preview_ical_import("hourly", &content, "UTC")
            .unwrap();
        store
            .import_ical(&preview, &[preview.candidates[0].key.clone()], false)
            .unwrap();
        let range = store.calendar_range("2026-11-05", "2026-11-05").unwrap();
        let event = store.list_events(false, false).unwrap().remove(0);
        let second = &range.events[1];
        assert_ne!(range.events[0].occurrence_key, second.occurrence_key);
        store
            .cancel_event_occurrence(&event.id, event.revision, &second.occurrence_key)
            .unwrap();
        let remaining = store.calendar_range("2026-11-05", "2026-11-05").unwrap();
        assert_eq!(remaining.events.len(), 2);
        assert!(
            remaining
                .events
                .iter()
                .all(|event| event.start_value != second.start_value)
        );
        assert_eq!(
            overlays(&store.export_ical().unwrap(), "2026-11-05", "2026-11-05").len(),
            2
        );
    }

    #[test]
    fn timezone_aliases_bom_and_non_event_components_are_supported() {
        let content = format!(
            "\u{feff}BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Zurich\r\nBEGIN:VTIMEZONE\r\nTZID:custom-zone\r\nX-LIC-LOCATION:Europe/Zurich\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VTODO\r\nSUMMARY:Task\r\nDTSTART:invalid\r\nEND:VTODO\r\n{}\r\n{}\r\nEND:VCALENDAR",
            event("UID:alias\nDTSTART;TZID=custom-zone:20261105T090000"),
            event("UID:prefixed\nDTSTART;TZID=/vendor.example/Europe/Zurich:20261105T090000")
        );
        let parsed = parse(&content, "UTC").unwrap();
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(parsed.events.len(), 2);
        for event in parsed.events {
            assert_eq!(event.event.start_value, "2026-11-05T08:00:00.000Z");
        }
    }

    #[test]
    fn nominal_days_exact_hours_and_zero_duration_follow_calendar_semantics() {
        for (duration, expected) in [
            ("P1D", "2026-03-29T07:00:00.000Z"),
            ("PT24H", "2026-03-29T08:00:00.000Z"),
            ("PT0S", "2026-03-28T08:00:00.000Z"),
        ] {
            let content = calendar(&event(&format!(
                "UID:duration\nDTSTART;TZID=Europe/Zurich:20260328T090000\nDURATION:{duration}"
            )));
            let mut store = PlannerStore::in_memory().unwrap();
            let preview = store
                .preview_ical_import("duration", &content, "UTC")
                .unwrap();
            assert_eq!(preview.candidates[0].end_value, expected, "{duration}");
            store
                .import_ical(&preview, &[preview.candidates[0].key.clone()], false)
                .unwrap();
        }
        let content = calendar(&event("UID:instant\nDTSTART:20261105T090000Z"));
        let items = overlays(&content, "2026-11-05", "2026-11-05");
        assert_eq!(items[0].start_value, items[0].end_value);
        for duration in ["P999999999999999999999D", "-P1D", "PT", "P1Y"] {
            assert!(ical_duration(duration).is_err());
        }
    }

    #[test]
    fn cancellations_without_dtstart_suppress_previous_revisions() {
        let content = calendar(
            &[
                event("UID:series\nDTSTART:20261105T090000Z\nRRULE:FREQ=DAILY;COUNT=3\nSEQUENCE:1"),
                event("UID:series\nRECURRENCE-ID:20261106T090000Z\nSTATUS:CANCELLED\nSEQUENCE:2"),
                event("UID:deleted\nDTSTART:20261105T110000Z\nSEQUENCE:1"),
                event("UID:deleted\nSTATUS:CANCELLED\nSEQUENCE:2"),
            ]
            .join("\n"),
        );
        let items = overlays(&content, "2026-11-05", "2026-11-07");
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.uid == "series"));
        assert_eq!(items[1].start_value, "2026-11-07T09:00:00.000Z");
    }
}
