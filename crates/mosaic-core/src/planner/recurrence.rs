use super::PlannerEvent;
use crate::error::{Error, Result};
use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};
use chrono_tz::Tz;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    frequency: Frequency,
    interval: u32,
    weekdays: Vec<Weekday>,
    month_days: Vec<i32>,
    week_start: Option<Weekday>,
    until: Option<NaiveDate>,
    count: Option<u32>,
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
    let mut month_days = Vec::new();
    let mut week_start = None;
    let mut until = None;
    let mut count = None;
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
                    "YEARLY" => Frequency::Yearly,
                    _ => {
                        return Err(Error::Invalid(
                            "recurrence frequency must be DAILY, WEEKLY, MONTHLY or YEARLY".into(),
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
            "BYMONTHDAY" => {
                month_days = value
                    .split(',')
                    .map(|day| {
                        day.parse::<i32>()
                            .ok()
                            .filter(|day| *day != 0 && (-31..=31).contains(day))
                            .ok_or_else(|| {
                                Error::Invalid("BYMONTHDAY must contain days 1–31 or -31–-1".into())
                            })
                    })
                    .collect::<Result<Vec<_>>>()?;
            }
            "WKST" => {
                week_start = Some(parse_weekday(&value.to_ascii_uppercase()).ok_or_else(|| {
                    Error::Invalid(format!("unsupported recurrence week start {value:?}"))
                })?);
            }
            "UNTIL" => {
                let value = value.trim_end_matches('Z');
                let value = value.get(..8).unwrap_or(value);
                until = Some(NaiveDate::parse_from_str(value, "%Y%m%d").map_err(|_| {
                    Error::Invalid("recurrence UNTIL must start with YYYYMMDD".into())
                })?);
            }
            "COUNT" => {
                count = Some(
                    value
                        .parse::<u32>()
                        .ok()
                        .filter(|value| *value > 0 && *value <= 100_000)
                        .ok_or_else(|| {
                            Error::Invalid("recurrence COUNT must be 1–100000".into())
                        })?,
                );
            }
            other => {
                return Err(Error::Invalid(format!(
                    "unsupported recurrence field {other:?}"
                )));
            }
        }
    }
    let frequency = frequency.ok_or_else(|| Error::Invalid("recurrence rule needs FREQ".into()))?;
    if frequency == Frequency::Weekly && !month_days.is_empty() {
        return Err(Error::Invalid(
            "BYMONTHDAY cannot be used with WEEKLY recurrence".into(),
        ));
    }
    if count.is_some() && until.is_some() {
        return Err(Error::Invalid(
            "recurrence rule cannot have both COUNT and UNTIL".into(),
        ));
    }
    if frequency == Frequency::Yearly && (!month_days.is_empty() || !weekdays.is_empty()) {
        return Err(Error::Invalid(
            "BYDAY and BYMONTHDAY are not supported with YEARLY recurrence".into(),
        ));
    }
    Ok(Rule {
        frequency,
        interval,
        weekdays,
        month_days,
        week_start,
        until,
        count,
    })
}

pub(super) fn normalize_rule(value: Option<String>) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    if value.trim().is_empty() {
        return Ok(None);
    }
    let value = value
        .trim()
        .strip_prefix("RRULE:")
        .unwrap_or(value.trim())
        .to_ascii_uppercase();
    if let Some(days) = value
        .split(';')
        .find_map(|part| part.strip_prefix("BYMONTHDAY="))
    {
        parse_rule(&format!("FREQ=MONTHLY;BYMONTHDAY={days}"))?;
    }
    // Keep the compact representation used by existing local events, while accepting the full
    // RFC recurrence grammar for imported calendars (COUNT, YEARLY, ordinal BYDAY, BYSETPOS, ...).
    let rule = match parse_rule(&value) {
        Ok(rule)
            if !value
                .split(';')
                .any(|part| part.starts_with("UNTIL=") && part[6..].contains('T')) =>
        {
            rule
        }
        _ => {
            let mut parsed = value
                .parse::<rrule::RRule<rrule::Unvalidated>>()
                .map_err(|error| Error::Invalid(format!("invalid recurrence rule: {error}")))?;
            let mut probe = rrule::Tz::UTC
                .with_ymd_and_hms(2000, 1, 1, 0, 0, 0)
                .unwrap();
            if let Some(until) = parsed.get_until() {
                probe = until.with_timezone(&rrule::Tz::UTC);
                parsed = parsed.until(probe);
            }
            parsed
                .validate(probe)
                .map_err(|error| Error::Invalid(format!("invalid recurrence rule: {error}")))?;
            return Ok(Some(value));
        }
    };
    let frequency = match rule.frequency {
        Frequency::Daily => "DAILY",
        Frequency::Weekly => "WEEKLY",
        Frequency::Monthly => "MONTHLY",
        Frequency::Yearly => "YEARLY",
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
    if !rule.month_days.is_empty() {
        parts.push(format!(
            "BYMONTHDAY={}",
            rule.month_days
                .iter()
                .map(i32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    if let Some(week_start) = rule.week_start {
        parts.push(format!("WKST={}", weekday_name(week_start)));
    }
    if let Some(until) = rule.until {
        parts.push(format!("UNTIL={}", until.format("%Y%m%d")));
    }
    if let Some(count) = rule.count {
        parts.push(format!("COUNT={count}"));
    }
    Ok(Some(parts.join(";")))
}

fn weekday_name(day: Weekday) -> &'static str {
    match day {
        Weekday::Mon => "MO",
        Weekday::Tue => "TU",
        Weekday::Wed => "WE",
        Weekday::Thu => "TH",
        Weekday::Fri => "FR",
        Weekday::Sat => "SA",
        Weekday::Sun => "SU",
    }
}

fn start_of_week(date: NaiveDate, week_start: Weekday) -> NaiveDate {
    let offset =
        (7 + date.weekday().num_days_from_monday() - week_start.num_days_from_monday()) % 7;
    date - chrono::Duration::days(i64::from(offset))
}

fn occurs(rule: &Rule, base: NaiveDate, date: NaiveDate) -> bool {
    if !matches_pattern(rule, base, date) {
        return false;
    }
    let Some(count) = rule.count else { return true };
    // COUNT limits the number of occurrences, so `date` must be among the first `count` matches.
    let mut seen = 0;
    let mut day = base;
    while day <= date {
        if matches_pattern(rule, base, day) {
            seen += 1;
            if seen > count {
                return false;
            }
        }
        let Some(next) = day.succ_opt() else { break };
        day = next;
    }
    true
}

fn matches_pattern(rule: &Rule, base: NaiveDate, date: NaiveDate) -> bool {
    if date < base || rule.until.is_some_and(|until| date > until) {
        return false;
    }
    // RFC 5545: negative days count back from the end of the month. Testing real dates
    // naturally skips impossible instances such as February 30 without shifting them.
    if !rule.month_days.is_empty() {
        let last_day = (28..=31)
            .rev()
            .find(|day| date.with_day(*day).is_some())
            .unwrap();
        if !rule.month_days.iter().any(|day| {
            let wanted = if *day > 0 {
                *day
            } else {
                last_day as i32 + day + 1
            };
            date.day() as i32 == wanted
        }) {
            return false;
        }
    }
    match rule.frequency {
        Frequency::Daily => {
            let days = (date - base).num_days();
            days % i64::from(rule.interval) == 0
                && (rule.weekdays.is_empty() || rule.weekdays.contains(&date.weekday()))
        }
        Frequency::Weekly => {
            let weekdays = if rule.weekdays.is_empty() {
                vec![base.weekday()]
            } else {
                rule.weekdays.clone()
            };
            let week_start = rule.week_start.unwrap_or(Weekday::Mon);
            let weeks =
                (start_of_week(date, week_start) - start_of_week(base, week_start)).num_days() / 7;
            weeks % i64::from(rule.interval) == 0 && weekdays.contains(&date.weekday())
        }
        Frequency::Monthly => {
            let months = (date.year() - base.year()) * 12
                + i32::try_from(date.month()).unwrap_or(0)
                - i32::try_from(base.month()).unwrap_or(0);
            months >= 0
                && months % i32::try_from(rule.interval).unwrap_or(1) == 0
                && (rule.weekdays.is_empty() || rule.weekdays.contains(&date.weekday()))
                && (!rule.month_days.is_empty()
                    || !rule.weekdays.is_empty()
                    || date.day() == base.day())
        }
        Frequency::Yearly => {
            let years = date.year() - base.year();
            years % i32::try_from(rule.interval).unwrap_or(1) == 0
                && date.month() == base.month()
                && date.day() == base.day()
        }
    }
}

fn local_datetime(tz: Tz, value: NaiveDateTime) -> Result<DateTime<Tz>> {
    // Ambiguous (fall-back) times resolve to the first occurrence. A time inside a spring-forward
    // gap is shifted forward by the gap length (02:30 -> 03:30), by applying the UTC offset that
    // was in force the day before (assumes no other offset change in between).
    if let Some(resolved) = tz.from_local_datetime(&value).earliest() {
        return Ok(resolved);
    }
    use chrono::Offset as _;
    let before = value - chrono::Duration::days(1);
    let offset = tz
        .from_local_datetime(&before)
        .earliest()
        .ok_or_else(|| Error::Invalid(format!("{value} does not exist in {tz}")))?
        .offset()
        .fix();
    Ok(
        (value - chrono::Duration::seconds(i64::from(offset.local_minus_utc())))
            .and_utc()
            .with_timezone(&tz),
    )
}

/// Last local date a timed occurrence touches. The end instant is exclusive, so a
/// non-empty event ending at exactly 00:00 belongs only to the previous day; a
/// zero-length event still belongs to its own day.
fn last_local_date(start: DateTime<Utc>, end: DateTime<Utc>, tz: Tz) -> NaiveDate {
    let last = if end > start {
        end - chrono::Duration::nanoseconds(1)
    } else {
        end
    };
    last.with_timezone(&tz).date_naive()
}

/// Returns occurrence key, normalized start and normalized end. Recurring timed events are rebuilt
/// from their local wall clock, which keeps (for example) 09:00 stable across DST transitions.
pub(super) fn expand(
    event: &PlannerEvent,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<(String, String, String)>> {
    if let Some(rule) = event.recurrence_rule.as_deref()
        && (parse_rule(rule).is_err()
            || rule
                .split(';')
                .any(|part| part.starts_with("UNTIL=") && part[6..].contains('T')))
    {
        return expand_rfc(event, rule, from, to);
    }
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
            if last_local_date(start_utc, end_utc, tz) >= from && local_start.date_naive() <= to {
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
            let local_end_date = last_local_date(start, end, tz);
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

fn expand_rfc(
    event: &PlannerEvent,
    rule: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<(String, String, String)>> {
    let tz: rrule::Tz = event
        .timezone
        .parse::<Tz>()
        .map_err(|_| Error::Invalid("invalid recurrence timezone".into()))?
        .into();
    let start = if event.all_day {
        let date = NaiveDate::parse_from_str(&event.start_value, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid recurring start".into()))?;
        tz.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .ok_or_else(|| Error::Invalid("invalid recurring start".into()))?
    } else {
        DateTime::parse_from_rfc3339(&event.start_value)
            .map_err(|_| Error::Invalid("invalid recurring start".into()))?
            .with_timezone(&tz)
    };
    let duration = if event.all_day {
        NaiveDate::parse_from_str(&event.end_value, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid recurring end".into()))?
            .signed_duration_since(start.date_naive())
    } else {
        DateTime::parse_from_rfc3339(&event.end_value)
            .map_err(|_| Error::Invalid("invalid recurring end".into()))?
            .signed_duration_since(start)
    };
    let precise_keys = rule.split(';').any(|part| {
        matches!(
            part.split('=').next(),
            Some("BYHOUR" | "BYMINUTE" | "BYSECOND")
        ) || matches!(part, "FREQ=HOURLY" | "FREQ=MINUTELY" | "FREQ=SECONDLY")
    });
    let rule = validated_rfc_rule(rule, start)?;
    let after_date = from
        .checked_sub_signed(duration.max(chrono::Duration::days(1)))
        .ok_or_else(|| Error::Invalid("calendar range overflow".into()))?;
    let after = tz
        .from_local_datetime(&after_date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or_else(|| Error::Invalid("invalid calendar range".into()))?;
    let before_date = to
        .succ_opt()
        .ok_or_else(|| Error::Invalid("calendar range overflow".into()))?;
    let before = tz
        .from_local_datetime(&before_date.and_hms_opt(0, 0, 0).unwrap())
        .latest()
        .ok_or_else(|| Error::Invalid("invalid calendar range".into()))?;
    // The library bounds both expansion work and output, including hostile/impossible rules.
    let generated = rrule::RRuleSet::new(start)
        .rrule(rule)
        .after(after)
        .before(before)
        .all(10_000);
    if generated.limited {
        return Err(Error::Invalid(
            "calendar recurrence exceeds the expansion limit".into(),
        ));
    }
    Ok(generated
        .dates
        .into_iter()
        .filter_map(|date| {
            let end = date.checked_add_signed(duration)?;
            if event.all_day {
                (end.date_naive() > from && date.date_naive() <= to).then(|| {
                    (
                        date.date_naive().to_string(),
                        date.date_naive().to_string(),
                        end.date_naive().to_string(),
                    )
                })
            } else {
                (end.date_naive() >= from && date.date_naive() <= to).then(|| {
                    (
                        if precise_keys {
                            date.with_timezone(&Utc)
                                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                        } else {
                            date.date_naive().to_string()
                        },
                        date.with_timezone(&Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        end.with_timezone(&Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    )
                })
            }
        })
        .collect())
}

/// Adapt date-only and floating UNTIL values to the event's timezone before validation.
pub(super) fn validated_rfc_rule(rule: &str, start: DateTime<rrule::Tz>) -> Result<rrule::RRule> {
    let mut parsed = rule
        .parse::<rrule::RRule<rrule::Unvalidated>>()
        .map_err(|error| Error::Invalid(format!("invalid recurrence rule: {error}")))?;
    if let Some(value) = rule.split(';').find_map(|part| part.strip_prefix("UNTIL="))
        && !value.ends_with('Z')
    {
        let local = if value.len() == 8 {
            NaiveDate::parse_from_str(value, "%Y%m%d")
                .ok()
                .and_then(|date| date.and_hms_opt(23, 59, 59))
        } else {
            NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()
        }
        .ok_or_else(|| Error::Invalid("invalid recurrence UNTIL".into()))?;
        let until = start
            .timezone()
            .from_local_datetime(&local)
            .latest()
            .ok_or_else(|| Error::Invalid("invalid recurrence UNTIL".into()))?;
        parsed = parsed.until(until.with_timezone(&rrule::Tz::UTC));
    }
    parsed
        .validate(start)
        .map_err(|error| Error::Invalid(format!("invalid recurrence rule: {error}")))
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

    fn daily_at(start: &str, end: &str) -> PlannerEvent {
        let mut e = event();
        e.start_value = start.into();
        e.end_value = end.into();
        e.recurrence_rule = Some("FREQ=DAILY".into());
        e
    }

    #[test]
    fn dst_gap_occurrence_is_shifted_forward_not_an_error() {
        // 02:30 Europe/Zurich does not exist on 2026-03-29.
        let e = daily_at("2026-03-27T01:30:00.000Z", "2026-03-27T02:00:00.000Z");
        let d = |day| NaiveDate::from_ymd_opt(2026, 3, day).unwrap();
        let o = expand(&e, d(28), d(30)).unwrap();
        assert_eq!(o.len(), 3);
        assert_eq!(o[0].1, "2026-03-28T01:30:00.000Z");
        assert_eq!(o[1].1, "2026-03-29T01:30:00.000Z"); // 03:30 CEST
        assert_eq!(o[1].2, "2026-03-29T02:00:00.000Z");
        assert_eq!(o[2].1, "2026-03-30T00:30:00.000Z");
    }

    #[test]
    fn dst_ambiguous_occurrence_uses_first_instant() {
        // 02:30 Europe/Zurich happens twice on 2026-10-25; the earlier (CEST) one wins.
        let e = daily_at("2026-10-23T00:30:00.000Z", "2026-10-23T01:00:00.000Z");
        let d = |day| NaiveDate::from_ymd_opt(2026, 10, day).unwrap();
        let o = expand(&e, d(25), d(25)).unwrap();
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].1, "2026-10-25T00:30:00.000Z");
    }

    #[test]
    fn dst_gap_shifts_by_the_gap_length_for_half_hour_and_midnight_gaps() {
        // Lord Howe: 02:00 -> 02:30 on 2026-10-04, so 02:15 becomes 02:45 (+11:00).
        let mut e = daily_at("2026-10-01T15:45:00.000Z", "2026-10-01T16:15:00.000Z");
        e.timezone = "Australia/Lord_Howe".into();
        let d = |day| NaiveDate::from_ymd_opt(2026, 10, day).unwrap();
        let o = expand(&e, d(4), d(4)).unwrap();
        assert_eq!(o[0].0, "2026-10-04");
        assert_eq!(o[0].1, "2026-10-03T15:45:00.000Z");
        assert_eq!(o[0].2, "2026-10-03T16:15:00.000Z");
        // Havana: 00:00 -> 01:00 on 2026-03-08, so 00:30 becomes 01:30 (-04:00).
        let mut e = daily_at("2026-03-05T05:30:00.000Z", "2026-03-05T06:30:00.000Z");
        e.timezone = "America/Havana".into();
        let d = |day| NaiveDate::from_ymd_opt(2026, 3, day).unwrap();
        let o = expand(&e, d(8), d(8)).unwrap();
        assert_eq!(o[0].0, "2026-03-08");
        assert_eq!(o[0].1, "2026-03-08T05:30:00.000Z");
        assert_eq!(o[0].2, "2026-03-08T06:30:00.000Z");
    }

    fn utc_timed(start: &str, end: &str, rule: Option<&str>) -> PlannerEvent {
        let mut event = event();
        event.timezone = "UTC".into();
        event.start_value = start.into();
        event.end_value = end.into();
        event.recurrence_rule = rule.map(Into::into);
        event
    }

    fn days(event: &PlannerEvent, from: (u32, u32), to: (u32, u32)) -> Vec<String> {
        expand(
            event,
            NaiveDate::from_ymd_opt(2026, from.0, from.1).unwrap(),
            NaiveDate::from_ymd_opt(2026, to.0, to.1).unwrap(),
        )
        .unwrap()
        .into_iter()
        .map(|occurrence| occurrence.0)
        .collect()
    }

    #[test]
    fn timed_event_ending_at_midnight_stays_on_its_start_day() {
        let event = utc_timed("2026-03-27T22:00:00.000Z", "2026-03-28T00:00:00.000Z", None);
        assert_eq!(days(&event, (3, 27), (3, 27)), vec!["2026-03-27"]);
        assert!(days(&event, (3, 28), (3, 28)).is_empty());
        // Ending one millisecond past midnight still reaches the next day.
        let event = utc_timed("2026-03-27T22:00:00.000Z", "2026-03-28T00:00:00.001Z", None);
        assert_eq!(days(&event, (3, 28), (3, 28)), vec!["2026-03-27"]);
    }

    #[test]
    fn recurring_timed_event_ending_at_midnight_stays_on_its_start_day() {
        let event = utc_timed(
            "2026-03-27T22:00:00.000Z",
            "2026-03-28T00:00:00.000Z",
            Some("FREQ=DAILY;UNTIL=20260330"),
        );
        assert_eq!(days(&event, (3, 28), (3, 28)), vec!["2026-03-28"]);
        assert_eq!(days(&event, (3, 29), (3, 29)), vec!["2026-03-29"]);
        let all = days(&event, (3, 27), (3, 30));
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn zero_length_timed_events_appear_on_their_day() {
        let midnight = utc_timed("2026-03-28T00:00:00.000Z", "2026-03-28T00:00:00.000Z", None);
        assert_eq!(days(&midnight, (3, 28), (3, 28)), vec!["2026-03-28"]);
        assert!(days(&midnight, (3, 27), (3, 27)).is_empty());
        let recurring = utc_timed(
            "2026-03-28T00:00:00.000Z",
            "2026-03-28T00:00:00.000Z",
            Some("FREQ=DAILY;UNTIL=20260330"),
        );
        assert_eq!(
            days(&recurring, (3, 28), (3, 29)),
            vec!["2026-03-28", "2026-03-29"]
        );
        assert!(days(&recurring, (3, 27), (3, 27)).is_empty());
    }

    #[test]
    fn all_day_end_stays_exclusive() {
        let mut event = utc_timed("2026-03-27", "2026-03-28", None);
        event.all_day = true;
        assert_eq!(days(&event, (3, 27), (3, 27)), vec!["2026-03-27"]);
        assert!(days(&event, (3, 28), (3, 28)).is_empty());
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
    fn supported_rules_are_normalized_and_invalid_fields_rejected() {
        assert_eq!(
            normalize_rule(Some(
                "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;WKST=SU".into()
            ))
            .unwrap(),
            Some("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU".into())
        );
        assert!(normalize_rule(Some("FREQ=YEARLY".into())).is_ok());
        assert!(normalize_rule(Some("FREQ=DAILY;COUNT=3".into())).is_ok());
        assert!(normalize_rule(Some("FREQ=WEEKLY;WKST=NO".into())).is_err());
        assert_eq!(
            normalize_rule(Some("FREQ=MONTHLY;BYMONTHDAY=1,15,-1;INTERVAL=2".into())).unwrap(),
            Some("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,15,-1".into())
        );
        for rule in [
            "FREQ=MONTHLY;BYMONTHDAY=0",
            "FREQ=MONTHLY;BYMONTHDAY=32",
            "FREQ=MONTHLY;BYMONTHDAY=-32",
            "FREQ=MONTHLY;BYMONTHDAY=",
            "FREQ=WEEKLY;BYMONTHDAY=1",
        ] {
            assert!(normalize_rule(Some(rule.into())).is_err(), "{rule}");
        }
    }

    #[test]
    fn yearly_and_count_rules_expand() {
        let mut event = event();
        event.all_day = true;
        event.start_value = "2024-02-29".into();
        event.end_value = "2024-03-01".into();
        event.recurrence_rule = Some("FREQ=YEARLY".into());
        let days = |event: &PlannerEvent| {
            expand(
                event,
                NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
                NaiveDate::from_ymd_opt(2033, 1, 1).unwrap(),
            )
            .unwrap()
            .into_iter()
            .map(|occurrence| occurrence.0)
            .collect::<Vec<_>>()
        };
        assert_eq!(days(&event), vec!["2024-02-29", "2028-02-29", "2032-02-29"]);
        event.start_value = "2026-11-03".into();
        event.end_value = "2026-11-04".into();
        event.recurrence_rule = Some("FREQ=YEARLY;INTERVAL=2".into());
        assert_eq!(
            days(&event),
            vec!["2026-11-03", "2028-11-03", "2030-11-03", "2032-11-03"]
        );
        event.recurrence_rule = Some("FREQ=DAILY;INTERVAL=2;COUNT=3".into());
        assert_eq!(days(&event), vec!["2026-11-03", "2026-11-05", "2026-11-07"]);
        event.recurrence_rule = Some("FREQ=WEEKLY;COUNT=2".into());
        assert_eq!(days(&event), vec!["2026-11-03", "2026-11-10"]);
    }

    #[test]
    fn month_days_skip_invalid_dates_and_support_negative_days_and_leap_years() {
        let mut event = event();
        event.all_day = true;
        event.start_value = "2028-01-31".into();
        event.end_value = "2028-02-01".into();
        event.recurrence_rule = Some("FREQ=MONTHLY;BYMONTHDAY=31,-1;UNTIL=20280430".into());
        let occurrences = expand(
            &event,
            NaiveDate::from_ymd_opt(2028, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2028, 5, 31).unwrap(),
        )
        .unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|occurrence| occurrence.0.as_str())
                .collect::<Vec<_>>(),
            vec!["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]
        );
        event.recurrence_rule = Some("FREQ=MONTHLY;BYMONTHDAY=31".into());
        assert_eq!(
            expand(
                &event,
                NaiveDate::from_ymd_opt(2028, 2, 1).unwrap(),
                NaiveDate::from_ymd_opt(2028, 4, 30).unwrap()
            )
            .unwrap()
            .iter()
            .map(|occurrence| occurrence.0.as_str())
            .collect::<Vec<_>>(),
            vec!["2028-03-31"]
        );
    }

    #[test]
    fn month_days_combine_with_weekdays_and_intervals() {
        let base = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let rule = parse_rule("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,2,3,4,5,6,7;BYDAY=MO").unwrap();
        assert!(occurs(
            &rule,
            base,
            NaiveDate::from_ymd_opt(2026, 3, 2).unwrap()
        ));
        assert!(!occurs(
            &rule,
            base,
            NaiveDate::from_ymd_opt(2026, 2, 2).unwrap()
        ));
        assert!(!occurs(
            &rule,
            base,
            NaiveDate::from_ymd_opt(2026, 3, 3).unwrap()
        ));
        let daily = parse_rule("FREQ=DAILY;BYMONTHDAY=-1").unwrap();
        assert!(occurs(
            &daily,
            base,
            NaiveDate::from_ymd_opt(2026, 2, 28).unwrap()
        ));
        assert!(!occurs(
            &daily,
            base,
            NaiveDate::from_ymd_opt(2026, 2, 27).unwrap()
        ));
    }

    #[test]
    fn week_start_controls_multi_week_intervals() {
        let mut event = event();
        event.start_value = "2026-03-25T08:00:00.000Z".into();
        event.end_value = "2026-03-25T09:00:00.000Z".into();
        event.recurrence_rule = Some("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;WKST=SU".into());

        let occurrences = expand(
            &event,
            NaiveDate::from_ymd_opt(2026, 3, 25).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 12).unwrap(),
        )
        .unwrap();

        assert_eq!(
            occurrences
                .iter()
                .map(|occurrence| occurrence.0.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-04-05"]
        );
    }

    #[test]
    fn non_ascii_until_is_an_error_not_a_panic() {
        for until in [
            "2026032é",           // 2-byte char straddles byte 8
            "202603€",            // 3-byte char straddles byte 8
            "202603😀",           // 4-byte char straddles byte 8
            "é2026032",           // multi-byte char first
            "２０２６０３２７",   // full-width digits
            "日本語日本語日本語", // long, all multi-byte
        ] {
            let error = parse_rule(&format!("FREQ=DAILY;UNTIL={until}")).unwrap_err();
            assert!(
                matches!(&error, Error::Invalid(m) if m == "recurrence UNTIL must start with YYYYMMDD"),
                "{until:?} gave {error:?}"
            );
        }
        assert!(parse_rule("FREQ=DAILY;UNTIL=20260331T235959Z").is_ok());
    }
}
