//! The small, human-readable schedule language used by vault agents.

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike, Weekday};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Schedule {
    EveryMinutes(i64),
    At {
        weekdays: Vec<Weekday>,
        hour: u32,
        minute: u32,
    },
}

pub fn parse(text: &str) -> Result<Schedule, String> {
    let words: Vec<_> = text.split_whitespace().collect();
    if words.len() == 2 && words[0].eq_ignore_ascii_case("every") {
        let unit = words[1].chars().last().ok_or("missing interval")?;
        let n: i64 = words[1][..words[1].len() - 1]
            .parse()
            .map_err(|_| "interval must be like every 2h or every 30m")?;
        let minutes = match unit.to_ascii_lowercase() {
            'h' => n * 60,
            'm' => n,
            _ => return Err("interval must end in h or m".into()),
        };
        return (minutes > 0)
            .then_some(Schedule::EveryMinutes(minutes))
            .ok_or("interval must be positive".into());
    }
    let (days, time) = match words.as_slice() {
        [time] => (all_days(), *time),
        [kind, time] if kind.eq_ignore_ascii_case("daily") => (all_days(), *time),
        [kind, time] if kind.eq_ignore_ascii_case("weekdays") => (
            vec![
                Weekday::Mon,
                Weekday::Tue,
                Weekday::Wed,
                Weekday::Thu,
                Weekday::Fri,
            ],
            *time,
        ),
        [day, time] => (
            vec![weekday(day).ok_or("day must be mon, tue, wed, thu, fri, sat or sun")?],
            *time,
        ),
        _ => return Err("use daily 08:00, weekdays 08:00, fri 17:00, or every 2h".into()),
    };
    let (h, m) = time.split_once(':').ok_or("time must be HH:MM")?;
    let (hour, minute): (u32, u32) = (
        h.parse().map_err(|_| "invalid hour")?,
        m.parse().map_err(|_| "invalid minute")?,
    );
    if hour > 23 || minute > 59 {
        return Err("time must be HH:MM".into());
    }
    Ok(Schedule::At {
        weekdays: days,
        hour,
        minute,
    })
}

fn all_days() -> Vec<Weekday> {
    vec![
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ]
}

fn weekday(s: &str) -> Option<Weekday> {
    match s.to_ascii_lowercase().as_str() {
        "mon" | "monday" => Some(Weekday::Mon),
        "tue" | "tuesday" => Some(Weekday::Tue),
        "wed" | "wednesday" => Some(Weekday::Wed),
        "thu" | "thursday" => Some(Weekday::Thu),
        "fri" | "friday" => Some(Weekday::Fri),
        "sat" | "saturday" => Some(Weekday::Sat),
        "sun" | "sunday" => Some(Weekday::Sun),
        _ => None,
    }
}

/// Whether at least one occurrence falls in `(last, now]`.
pub fn due(schedule: &Schedule, last: DateTime<Local>, now: DateTime<Local>) -> bool {
    if now <= last {
        return false;
    }
    match schedule {
        Schedule::EveryMinutes(n) => now.timestamp() / (n * 60) > last.timestamp() / (n * 60),
        Schedule::At {
            weekdays,
            hour,
            minute,
        } => {
            let mut day = last.date_naive();
            while day <= now.date_naive() {
                if weekdays.contains(&day.weekday())
                    && let Some(at) = Local
                        .with_ymd_and_hms(day.year(), day.month(), day.day(), *hour, *minute, 0)
                        .single()
                    && at > last
                    && at <= now
                {
                    return true;
                }
                day = day.succ_opt().expect("next day");
            }
            false
        }
    }
}

pub fn minute_start(now: DateTime<Local>) -> DateTime<Local> {
    now.with_second(0)
        .and_then(|n| n.with_nanosecond(0))
        .unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn parses_short_forms() {
        assert_eq!(parse("every 2h"), Ok(Schedule::EveryMinutes(120)));
        assert_eq!(parse("every 30m"), Ok(Schedule::EveryMinutes(30)));
        assert!(
            matches!(parse("weekdays 08:00"), Ok(Schedule::At { weekdays, hour: 8, minute: 0 }) if weekdays.len() == 5)
        );
        assert!(
            matches!(parse("fri 17:00"), Ok(Schedule::At { weekdays, hour: 17, minute: 0 }) if weekdays == [Weekday::Fri])
        );
        assert!(parse("daily 25:00").is_err());
    }

    #[test]
    fn interval_crossing_is_due_once() {
        let now = minute_start(Local::now());
        assert!(due(
            &Schedule::EveryMinutes(60),
            now - Duration::minutes(61),
            now
        ));
        assert!(!due(
            &Schedule::EveryMinutes(60),
            now - Duration::seconds(20),
            now
        ));
    }
}
