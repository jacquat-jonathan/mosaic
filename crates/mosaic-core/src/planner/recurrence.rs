use super::PlannerEvent;
use crate::error::{Error, Result};
use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};
use chrono_tz::Tz;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frequency {
    Daily,
    Weekly,
    Monthly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    frequency: Frequency,
    interval: u32,
    weekdays: Vec<Weekday>,
    until: Option<NaiveDate>,
}

fn parse_weekday(value: &str) -> Option<Weekday> {
    match value {
        "MO" => Some(Weekday::Mon),
        "TU" => Some(Weekday::Tue),
        "WE" => Some(Weekday::Wed),
        "TH" => Some(Weekday::Thu),
        "FR" => Some(Weekday::Fri),
        "SA" => Some(Weekday::Sat),
        "SU" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_rule(value: &str) -> Result<Rule> {
    let value = value.trim().strip_prefix("RRULE:").unwrap_or(value.trim());
    let mut frequency = None;
    let mut interval = 1;
    let mut weekdays = Vec::new();
    let mut until = None;
    for part in value.split(';') {
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| Error::Invalid(format!("invalid recurrence part {part:?}")))?;
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => {
                frequency = Some(match value.to_ascii_uppercase().as_str() {
                    "DAILY" => Frequency::Daily,
                    "WEEKLY" => Frequency::Weekly,
                    "MONTHLY" => Frequency::Monthly,
                    _ => {
                        return Err(Error::Invalid(
                            "recurrence frequency must be DAILY, WEEKLY or MONTHLY".into(),
                        ));
                    }
                });
            }
            "INTERVAL" => {
                interval = value
                    .parse::<u32>()
                    .ok()
                    .filter(|value| *value > 0 && *value <= 366)
                    .ok_or_else(|| Error::Invalid("recurrence interval must be 1–366".into()))?;
            }
            "BYDAY" => {
                weekdays = value
                    .split(',')
                    .map(|day| {
                        parse_weekday(&day.to_ascii_uppercase()).ok_or_else(|| {
                            Error::Invalid(format!("unsupported recurrence weekday {day:?}"))
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
            }
            "UNTIL" => {
                let value = value.trim_end_matches('Z');
                let value = &value[..value.len().min(8)];
                until = Some(NaiveDate::parse_from_str(value, "%Y%m%d").map_err(|_| {
                    Error::Invalid("recurrence UNTIL must start with YYYYMMDD".into())
                })?);
            }
            other => {
                return Err(Error::Invalid(format!(
                    "unsupported recurrence field {other:?}"
                )));
            }
        }
    }
    Ok(Rule {
        frequency: frequency.ok_or_else(|| Error::Invalid("recurrence rule needs FREQ".into()))?,
        interval,
        weekdays,
        until,
    })
}

pub(super) fn normalize_rule(value: Option<String>) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    if value.trim().is_empty() {
        return Ok(None);
    }
    let rule = parse_rule(&value)?;
    let frequency = match rule.frequency {
        Frequency::Daily => "DAILY",
        Frequency::Weekly => "WEEKLY",
        Frequency::Monthly => "MONTHLY",
    };
    let mut parts = vec![format!("FREQ={frequency}")];
    if rule.interval != 1 {
        parts.push(format!("INTERVAL={}", rule.interval));
    }
    if !rule.weekdays.is_empty() {
        let weekdays = rule
            .weekdays
            .iter()
            .map(|day| match day {
                Weekday::Mon => "MO",
                Weekday::Tue => "TU",
                Weekday::Wed => "WE",
                Weekday::Thu => "TH",
                Weekday::Fri => "FR",
                Weekday::Sat => "SA",
                Weekday::Sun => "SU",
            })
            .collect::<Vec<_>>()
            .join(",");
        parts.push(format!("BYDAY={weekdays}"));
    }
    if let Some(until) = rule.until {
        parts.push(format!("UNTIL={}", until.format("%Y%m%d")));
    }
    Ok(Some(parts.join(";")))
}

fn occurs(rule: &Rule, base: NaiveDate, date: NaiveDate) -> bool {
    if date < base || rule.until.is_some_and(|until| date > until) {
        return false;
    }
    match rule.frequency {
        Frequency::Daily => {
            let days = (date - base).num_days();
            days % i64::from(rule.interval) == 0
                && (rule.weekdays.is_empty() || rule.weekdays.contains(&date.weekday()))
        }
        Frequency::Weekly => {
            let days = (date - base).num_days();
            let weekdays = if rule.weekdays.is_empty() {
                vec![base.weekday()]
            } else {
                rule.weekdays.clone()
            };
            (days / 7) % i64::from(rule.interval) == 0 && weekdays.contains(&date.weekday())
        }
        Frequency::Monthly => {
            let months = (date.year() - base.year()) * 12
                + i32::try_from(date.month()).unwrap_or(0)
                - i32::try_from(base.month()).unwrap_or(0);
            months >= 0
                && months % i32::try_from(rule.interval).unwrap_or(1) == 0
                && date.day() == base.day()
        }
    }
}

fn local_datetime(tz: Tz, value: NaiveDateTime) -> Result<DateTime<Tz>> {
    tz.from_local_datetime(&value)
        .earliest()
        .ok_or_else(|| Error::Invalid(format!("{value} does not exist in {tz}")))
}

/// Returns occurrence key, normalized start and normalized end. Recurring timed events are rebuilt
/// from their local wall clock, which keeps (for example) 09:00 stable across DST transitions.
pub(super) fn expand(
    event: &PlannerEvent,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<(String, String, String)>> {
    let tz: Tz = event
        .timezone
        .parse()
        .map_err(|_| Error::Invalid(format!("unknown IANA timezone {:?}", event.timezone)))?;
    if event.all_day {
        let start = NaiveDate::parse_from_str(&event.start_value, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid all-day event start".into()))?;
        let end = NaiveDate::parse_from_str(&event.end_value, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid all-day event end".into()))?;
        let duration = (end - start).num_days();
        if event.recurrence_rule.is_none() {
            return Ok(if end > from && start <= to {
                vec![(start.to_string(), start.to_string(), end.to_string())]
            } else {
                vec![]
            });
        }
        let rule = event
            .recurrence_rule
            .as_deref()
            .map(parse_rule)
            .transpose()?;
        let mut result = Vec::new();
        let mut date = start.max(
            from.checked_sub_days(Days::new(duration.max(0) as u64))
                .unwrap_or(from),
        );
        while date <= to {
            if rule
                .as_ref()
                .map_or(date == start, |rule| occurs(rule, start, date))
            {
                let occurrence_end = date + chrono::Duration::days(duration);
                if occurrence_end > from && date <= to {
                    result.push((
                        date.to_string(),
                        date.to_string(),
                        occurrence_end.to_string(),
                    ));
                }
            }
            date = date
                .succ_opt()
                .ok_or_else(|| Error::Invalid("calendar range overflow".into()))?;
        }
        return Ok(result);
    }

    let start_utc = DateTime::parse_from_rfc3339(&event.start_value)
        .map_err(|_| Error::Invalid("invalid timed event start".into()))?
        .with_timezone(&Utc);
    let end_utc = DateTime::parse_from_rfc3339(&event.end_value)
        .map_err(|_| Error::Invalid("invalid timed event end".into()))?
        .with_timezone(&Utc);
    let duration = end_utc - start_utc;
    let local_start = start_utc.with_timezone(&tz);
    if event.recurrence_rule.is_none() {
        return Ok(
            if end_utc.with_timezone(&tz).date_naive() >= from && local_start.date_naive() <= to {
                vec![(
                    local_start.date_naive().to_string(),
                    start_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    end_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )]
            } else {
                vec![]
            },
        );
    }
    let base_date = local_start.date_naive();
    let time = local_start.time();
    let rule = event
        .recurrence_rule
        .as_deref()
        .map(parse_rule)
        .transpose()?;
    let mut result = Vec::new();
    let mut date = base_date.max(from.pred_opt().unwrap_or(from));
    while date <= to {
        if rule
            .as_ref()
            .map_or(date == base_date, |rule| occurs(rule, base_date, date))
        {
            let start = local_datetime(tz, date.and_time(time))?.with_timezone(&Utc);
            let end = start + duration;
            let local_end_date = end.with_timezone(&tz).date_naive();
            if local_end_date >= from && date <= to {
                result.push((
                    date.to_string(),
                    start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    end.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ));
            }
        }
        date = date
            .succ_opt()
            .ok_or_else(|| Error::Invalid("calendar range overflow".into()))?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> PlannerEvent {
        PlannerEvent {
            id: "event".into(),
            series_id: None,
            title: "Standup".into(),
            description: String::new(),
            location: String::new(),
            meeting_url: None,
            participants: vec![],
            epic_id: None,
            color: None,
            all_day: false,
            start_value: "2026-03-23T08:00:00.000Z".into(),
            end_value: "2026-03-23T09:00:00.000Z".into(),
            timezone: "Europe/Zurich".into(),
            recurrence_rule: Some("FREQ=DAILY;UNTIL=20260331".into()),
            revision: 1,
            created_at: String::new(),
            updated_at: String::new(),
            archived_at: None,
            trashed_at: None,
        }
    }

    #[test]
    fn recurring_wall_clock_survives_dst() {
        let occurrences = expand(
            &event(),
            NaiveDate::from_ymd_opt(2026, 3, 27).unwrap(),
            NaiveDate::from_ymd_opt(2026, 3, 30).unwrap(),
        )
        .unwrap();
        assert_eq!(occurrences[0].1, "2026-03-27T08:00:00.000Z");
        assert_eq!(occurrences[2].1, "2026-03-29T07:00:00.000Z");
    }

    #[test]
    fn supported_rules_are_normalized_and_advanced_fields_rejected() {
        assert_eq!(
            normalize_rule(Some("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2".into())).unwrap(),
            Some("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE".into())
        );
        assert!(normalize_rule(Some("FREQ=YEARLY".into())).is_err());
        assert!(normalize_rule(Some("FREQ=DAILY;COUNT=3".into())).is_err());
    }
}
