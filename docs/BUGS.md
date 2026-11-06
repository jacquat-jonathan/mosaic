# Suspected bugs (audit)

Audit of `crates/mosaic-core`, `crates/mosaic-cli` and `src-tauri` (plus the link-resolution mirror in
`ui/src/links.ts`) at commit `45ed838`. Nothing was fixed and no source or test file was changed.
This file is the only deliverable.

**Confidence labels**

- **Confirmed**: reproduced by running code in this audit.
- **Suspected**: inferred from reading only.

Every finding was reproduced by running code, except B-16, which is **Suspected**. B-14 and B-15 are
confirmed for the behaviour shown; their wider consequences are marked suspected inline.

**How reproductions were run.** Linux container, `cargo build -p mosaic-cli`, binary at
`target/debug/mosaic` (called `mosaic` below, always with `--vault <dir>`). Planner and iCalendar
cases use a small throwaway crate outside the repo with a path dependency on `mosaic-core`
(`PlannerStore::in_memory()`); the calls are shown inline so they can be rebuilt as a test. The UI
case ran with `node --experimental-strip-types`.

**Test-suite note (not a bug).** `cargo test -p mosaic-core` has one failure when run as root:
`api::tests::a_link_that_cant_be_rewritten_is_reported_and_can_be_fixed_later`. The test relies on a
`0o555` directory refusing writes, which root ignores. Everything else passed (137 + 7 + 15 + 1).

| ID | Severity | Title |
|----|----------|-------|
| B-01 | High | Case-only rename silently overwrites a different existing file on case-sensitive volumes |
| B-02 | Medium | iCalendar import drops `EXDATE` and `RECURRENCE-ID`, so cancelled or moved occurrences reappear |
| B-03 | Medium | One `COUNT=` or `FREQ=YEARLY` event makes a whole calendar feed or file unusable |
| B-04 | Medium | A `VALARM` description overwrites the event description on import |
| B-05 | Medium | A feed that starts with a UTF-8 BOM is rejected as "not an iCalendar document" |
| B-06 | Medium | A recurring event inside a DST gap makes the entire calendar range fail |
| B-07 | Medium | Non-ASCII `UNTIL` value panics instead of returning an error |
| B-08 | Medium | Renaming a note to a name containing `#` (or `(`/`)`) breaks every link to it |
| B-09 | Low | iCalendar text unescape corrupts `\\n` (backslash followed by `n`) |
| B-10 | Low | iCalendar unfolding drops spaces at fold points |
| B-11 | Low | Heading `# Learning C#` loses its trailing `#` (note title becomes "Learning C") |
| B-12 | Low | Timed event ending exactly at midnight also shows on the next day |
| B-13 | Low | Rust and TypeScript link resolution disagree on non-ASCII "shortest path" ties |
| B-14 | Low | Empty frontmatter (`---` / `---`) is not recognised |
| B-15 | Low | File names containing a backslash are listed but cannot be read (suspected broader effect) |
| B-16 | Low | ICS export has no line folding and does not escape `\r` (suspected) |

---

## B-01 — Case-only rename overwrites an existing file (data loss)

- **Severity:** High (data loss), conditional on a case-sensitive filesystem. Mosaic targets macOS,
  where APFS is usually case-insensitive, but case-sensitive APFS volumes and Linux builds are affected.
- **Location:** `crates/mosaic-core/src/vault.rs:528-535` (`Vault::rename`)
- **What goes wrong:** The "case-only rename" exemption is decided by comparing lower-cased path
  strings (`from_n.to_lowercase() == to_n.to_lowercase()`), not by asking whether the two paths are the
  same file. On a case-sensitive volume `a.md` and `A.md` are different files. `dst.exists()` is
  ignored for case-only renames and `fs::rename` then replaces the existing target.
- **Steps:**
  ```sh
  mkdir v && cd v
  printf AAA > a.md; printf BBB > A.md
  mosaic --vault . rename a.md A.md
  ls; cat A.md
  ```
- **Expected:** Refused with "already exists" (as for any other occupied target); both files intact.
- **Actual:** Prints `renamed to A.md`. Only `A.md` remains and it contains `AAA`; the original `A.md`
  (`BBB`) is gone. (`trash`/history are not involved, so there is no undo from the rename itself.)
- **Confidence:** Confirmed.

## B-02 — iCalendar import loses `EXDATE` and `RECURRENCE-ID`

- **Severity:** Medium
- **Location:** `crates/mosaic-core/src/planner/ical.rs:68-71` (`ParsedEvent.excluded_occurrences`,
  `recurrence_key` are parsed), `ical.rs:376-415` (`preview_ical_import`) and `ical.rs:417-485`
  (`import_ical`). Only `overlay_occurrences` (`ical.rs:~660-675`) honours the exclusions.
- **What goes wrong:** On import, `preview_ical_import` builds each candidate from `ParsedEvent.event`
  only. The `EXDATE` list and the `RECURRENCE-ID` link between a master event and its override are
  never stored. The master series imports with every occurrence, and each override imports as a
  separate standalone event.
- **Steps:** (probe crate)
  ```rust
  let mut p = PlannerStore::in_memory().unwrap();
  let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
  BEGIN:VEVENT\r\nUID:s1\r\nDTSTART:20260401T090000Z\r\nDTEND:20260401T100000Z\r\nSUMMARY:Daily\r\nRRULE:FREQ=DAILY\r\nEXDATE:20260402T090000Z\r\nEND:VEVENT\r\n\
  BEGIN:VEVENT\r\nUID:s1\r\nRECURRENCE-ID:20260403T090000Z\r\nDTSTART:20260403T110000Z\r\nDTEND:20260403T120000Z\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  let prev = p.preview_ical_import("file", ics, "UTC").unwrap();
  let keys: Vec<_> = prev.candidates.iter().map(|c| c.key.clone()).collect();
  p.import_ical(&prev, &keys, false).unwrap();
  p.calendar_range("2026-04-01", "2026-04-04")
  ```
- **Expected:** 04-02 absent (excluded); on 04-03 only "Moved" at 11:00.
- **Actual:** Occurrences: Daily 04-01, Daily **04-02**, Daily **04-03**, **Moved 04-03 11:00**, Daily 04-04.
  The excluded day is present and 04-03 is double-booked. (Subscriptions via `overlay_occurrences` are fine.)
- **Confidence:** Confirmed.

## B-03 — One unsupported `RRULE` rejects the whole feed or file

- **Severity:** Medium (feature unusable for many real calendars)
- **Location:** `crates/mosaic-core/src/planner/ical.rs:362-368` (`validate_ical`) and
  `crates/mosaic-core/src/planner/recurrence.rs:36-135` (`parse_rule` accepts only
  DAILY/WEEKLY/MONTHLY and no `COUNT`); caller `src-tauri/src/calendar_subscriptions.rs:275`
- **What goes wrong:** `validate_ical` runs `normalize_rule` on every non-cancelled event and returns
  the first error. A single `FREQ=YEARLY` (birthdays, holidays) or `COUNT=n` event makes the entire
  subscription refresh fail ("unsupported recurrence field"), so the cache is never updated and every
  other event in the feed is also missing. `preview_ical_import` surfaces the same error at insert time.
- **Steps:**
  ```rust
  validate_ical(&wrap("RRULE:FREQ=YEARLY\r\n"), "UTC")        // Err("recurrence frequency must be DAILY, WEEKLY or MONTHLY")
  validate_ical(&wrap("RRULE:FREQ=WEEKLY;COUNT=3\r\n"), "UTC") // Err("unsupported recurrence field \"COUNT\"")
  ```
  UI: Calendar › subscribe to any public feed containing a yearly or `COUNT` event.
- **Expected:** Supported events load; the unsupported one is skipped (or approximated) and reported.
- **Actual:** Whole feed rejected; last working cache kept forever.
- **Confidence:** Confirmed at the `validate_ical` level (the UI path calls exactly this function).

## B-04 — `VALARM` description replaces the event description

- **Severity:** Medium
- **Location:** `crates/mosaic-core/src/planner/ical.rs:~218-330` (`parse` collects every line
  between `BEGIN:VEVENT` and `END:VEVENT`, including nested components; `DESCRIPTION` handled at `:276`)
- **What goes wrong:** Properties of a nested `VALARM` (`DESCRIPTION`, `SUMMARY`, …) are processed as if
  they belonged to the event. Google and Apple exports put `DESCRIPTION:Reminder` inside `VALARM`, which
  comes after the event's own `DESCRIPTION`, so it wins.
- **Steps:**
  ```
  BEGIN:VEVENT … SUMMARY:S
  DESCRIPTION:Real description
  BEGIN:VALARM
  ACTION:DISPLAY
  DESCRIPTION:Reminder
  TRIGGER:-PT15M
  END:VALARM
  END:VEVENT
  ```
  `preview_ical_import(...).candidates[0].event.description`
- **Expected:** `"Real description"`.
- **Actual:** `"Reminder"`.
- **Confidence:** Confirmed.

## B-05 — UTF-8 BOM makes a valid feed unreadable

- **Severity:** Medium
- **Location:** `crates/mosaic-core/src/planner/ical.rs:209-212` (`parse`, the `BEGIN:VCALENDAR` check)
  and `src-tauri/src/calendar_subscriptions.rs:273` (`std::str::from_utf8`, BOM kept)
- **What goes wrong:** The first line is `"\u{feff}BEGIN:VCALENDAR"`, which does not equal
  `BEGIN:VCALENDAR`, so the document is rejected. BOM-prefixed `.ics` files are common (Outlook, Windows tools).
- **Steps:** `validate_ical(&format!("\u{feff}{valid_ics}"), "UTC")`
- **Expected:** `Ok(1)`.
- **Actual:** `Err("input is not an iCalendar document")`.
- **Confidence:** Confirmed.

## B-06 — Recurring event in a DST gap breaks the whole calendar range

- **Severity:** Medium
- **Location:** `crates/mosaic-core/src/planner/recurrence.rs:248-253` (`local_datetime`), used at `:344`
- **What goes wrong:** Occurrences are rebuilt from the local wall-clock time. On the spring-forward day
  that local time may not exist, `.earliest()` returns `None`, and `expand` returns `Err`. The error
  propagates through `calendar_range`, so the entire range query fails for every event, not just the
  one that fell in the gap.
- **Steps:** (probe crate)
  ```rust
  p.create_event(CreateEvent { all_day:false, timezone:"Europe/Zurich".into(),
      start_value:"2026-03-27T01:30:00.000Z".into(), end_value:"2026-03-27T02:00:00.000Z".into(),
      recurrence_rule:Some("FREQ=DAILY".into()), /* other fields empty */ .. });  // = 02:30 local
  p.calendar_range("2026-03-23", "2026-04-02")
  ```
- **Expected:** The 29 March occurrence is shifted (e.g. to 03:30) or skipped; other events still shown.
- **Actual:** `create_event` succeeds, `calendar_range` returns `Err("2026-03-29 02:30:00 does not exist in Europe/Zurich")`
  for any range containing 29 March 2026, i.e. the calendar view is empty/errors that week.
- **Confidence:** Confirmed.

## B-07 — Non-ASCII `UNTIL` panics

- **Severity:** Medium (panic in the app process or MCP server instead of a validation error)
- **Location:** `crates/mosaic-core/src/planner/recurrence.rs:97-98` (`&value[..value.len().min(8)]`)
- **What goes wrong:** Byte-index slicing at 8 lands inside a multi-byte character.
- **Steps:**
  ```rust
  p.create_event(CreateEvent { all_day:true, start_value:"2026-03-27".into(), end_value:"2026-03-28".into(),
      timezone:"UTC".into(), recurrence_rule:Some("FREQ=DAILY;UNTIL=2026032é".into()), .. });
  ```
  The same string can arrive through an imported `.ics` `RRULE`, which is user-supplied input.
- **Expected:** `Err(Invalid("recurrence UNTIL must start with YYYYMMDD"))`.
- **Actual:** `panicked at recurrence.rs:98:35: end byte index 8 is not a char boundary; it is inside 'é'`.
- **Confidence:** Confirmed.

## B-08 — Renaming to a name with `#` (or parentheses) breaks links to the note

- **Severity:** Medium (silent link loss during an automatic rewrite)
- **Location:** `crates/mosaic-core/src/links.rs:139-170` (`wiki_text_for`, `markdown_url_for`), applied at
  `crates/mosaic-core/src/api.rs:1655-1665`; parser side `parse.rs:75-77` (`MD_LINK` uses `[^\s()]+`)
- **What goes wrong:** The rewritten link text is not escaped for its syntax.
  - Wiki links: the new name is inserted raw, and `#`, `^`, `|` inside a file name are then parsed as
    heading/block/alias separators.
  - Markdown links: `markdown_url_for` only encodes `%` and space, so `(`, `)` and `#` are emitted raw;
    the `MD_LINK` regex then refuses to match the link at all, and the link disappears from the index.
- **Steps:**
  ```sh
  printf 'see [[Old]]\n[md](Old.md)\n' > src.md; printf x > Old.md
  mosaic --vault . rename Old.md "Notes (v2) #1.md"
  cat src.md
  mosaic --vault . backlinks "Notes (v2) #1.md"
  mosaic --vault . outline src.md
  ```
- **Expected:** Links still resolve to the renamed note; backlinks list `src.md`.
- **Actual:** `src.md` becomes `see [[Notes (v2) #1]]` / `[md](Notes%20(v2)%20#1.md)`. `outline` shows one
  link with target `Notes (v2)` and `resolved: null`; the Markdown link is not parsed at all; `backlinks`
  is empty.
- **Confidence:** Confirmed.

## B-09 — iCalendar unescape corrupts `\\n`

- **Severity:** Low
- **Location:** `crates/mosaic-core/src/planner/ical.rs:108-115` (`text`)
- **What goes wrong:** The unescape applies sequential `replace` calls, `\n` first. For the escaped
  sequence `\\n` (a literal backslash followed by `n`), the inner `\n` is turned into a newline before
  `\\` is collapsed.
- **Steps:** Import `SUMMARY:Path C:\\new\\table` (which means `C:\new\table`), then list the event.
- **Expected:** `Path C:\new\table`.
- **Actual:** `Path C:\` followed by a line break and `ew\` / `able` (`\n` sequences became newlines).
- **Confidence:** Confirmed.

## B-10 — iCalendar unfolding removes real spaces

- **Severity:** Low
- **Location:** `crates/mosaic-core/src/planner/ical.rs:86-96` (`unfolded`, `:90` `raw.trim_start()`)
- **What goes wrong:** RFC 5545 removes exactly one whitespace character (the fold marker) from a
  continuation line; `trim_start` removes all of them, so a space that belongs to the text at the fold
  point is lost.
- **Steps:** Import `DESCRIPTION:Hello` + CRLF + two spaces + `world and more`.
- **Expected:** `Hello world and more`.
- **Actual:** `Helloworld and more`.
- **Confidence:** Confirmed.

## B-11 — Heading ending in `#` is truncated

- **Severity:** Low (affects the note title, outline, heading links)
- **Location:** `crates/mosaic-core/src/parse.rs:81-82` (`HEADING`: `^(#{1,6})[ \t]+(.+?)[ \t#]*$`)
- **What goes wrong:** The trailing `[ \t#]*` strips `#` characters even when they are part of the text.
  CommonMark only strips a closing sequence that is preceded by a space.
- **Steps:**
  ```sh
  printf '# Learning C#\n' > c.md
  mosaic --vault . outline c.md   # "title": "Learning C"
  ```
- **Expected:** Title `Learning C#`.
- **Actual:** `Learning C`; `[[c#Learning C#]]` style heading links also do not match.
- **Confidence:** Confirmed.

## B-12 — Event ending exactly at midnight appears on the next day

- **Severity:** Low
- **Location:** `crates/mosaic-core/src/planner/recurrence.rs:319` (timed non-recurring: end date `>= from`)
  and `:347` (`local_end_date >= from`); the end instant is exclusive
- **Steps:** (UTC) event `22:00Z` → `00:00Z` on 27→28 March; `calendar_range("2026-03-28", "2026-03-28")`.
- **Expected:** 0 events on the 28th.
- **Actual:** 1 event (it is shown on both days). The same condition applies to recurring events.
- **Confidence:** Confirmed.

## B-13 — Rust and TypeScript link resolution disagree for non-ASCII paths

- **Severity:** Low (inconsistent targets between editor and backlinks/rename)
- **Location:** `crates/mosaic-core/src/links.rs:60` (sorts by byte length) vs `ui/src/links.ts:80`
  (sorts by UTF-16 `length`)
- **What goes wrong:** Both implementations are documented to match (shared `fixtures/links.json`) but
  the "shortest path" tie-break measures length differently, so with non-ASCII folder names they pick
  different notes.
- **Steps:**
  ```rust
  FileSet::new(["ab/Same.md", "é/Same.md"], []).resolve("Same", None, false)   // Some("ab/Same.md")
  ```
  ```ts
  resolveLink("Same", [{path:"ab/Same.md"},{path:"é/Same.md"}], null)           // "é/Same.md"
  ```
- **Expected:** Same answer in both.
- **Actual:** Rust `ab/Same.md`, UI `é/Same.md`. The fixture file has no non-ASCII case, so tests pass.
- **Confidence:** Confirmed.

## B-14 — Empty frontmatter is not recognised

- **Severity:** Low
- **Location:** `crates/mosaic-core/src/parse.rs:72-73` (`FRONTMATTER` requires a newline after the opening
  fence *and* before the closing fence)
- **Steps:** `printf -- '---\n---\n# Title\n' > e.md; mosaic --vault . outline e.md` → `"frontmatter": null`.
- **Expected:** Frontmatter present but empty (an empty property block).
- **Actual:** Treated as no frontmatter; the `---` lines are body text. Adding a property from the UI
  would then likely create a second block (not run through the UI).
- **Confidence:** Confirmed for the parser; the UI consequence is suspected.

## B-15 — Backslash in a file name: listed but unreadable

- **Severity:** Low
- **Location:** `crates/mosaic-core/src/vault.rs:94` (`normalize` replaces `\` with `/` for every path)
- **What goes wrong:** On macOS/Linux a backslash is a legal file-name character. `list` shows the file,
  but any path run through `normalize` turns it into a folder separator, so read/write/rename/delete of
  that file fail with "not found".
- **Steps:** `printf x > 'back\slash.md'; mosaic --vault . list; mosaic --vault . read 'back\slash.md'`
- **Expected:** File readable (or hidden from `list`).
- **Actual:** `list` shows `back\slash.md`; `read` fails with `not found: back/slash.md`.
- **Confidence:** Confirmed for `list`/`read`. Effects on write/rename/delete are suspected from the
  shared `normalize` use.

## B-16 — ICS export is not folded and does not escape `\r`

- **Severity:** Low
- **Location:** `crates/mosaic-core/src/planner/ical.rs:549-555` (`escaped`) and `557-635` (`write_event`)
- **What goes wrong:** RFC 5545 requires content lines to be folded at 75 octets; the exporter emits one
  line per property. `escaped` escapes `\n` but not a lone `\r` (e.g. text pasted with CRLF is stored
  as `\r\n`, giving a bare CR in the output) and `URL`/`ATTENDEE` values are written unescaped.
  Strict importers can truncate or reject such files.
- **Steps:** Create an event with a >75-character title or a description containing `\r\n`, run
  `export_ical`, and inspect the output.
- **Expected:** Folded lines; no bare CR.
- **Actual (from reading):** Long single lines; bare CR kept.
- **Confidence:** Suspected (not run against a third-party importer).

---

## Areas read but not found faulty

`Vault::resolve` symlink-escape checks, atomic writes, `query` operators (numeric compare, `!=`,
nested tags, `today+N`, `title~`, `sort:-field`), carry-over and `days`, calendar-subscription HTTPS-only
redirect policy and size cap, and MCP resource URI encoding all behaved as designed in the cases tried.
The UI (`ui/`) was only reviewed for the pure-logic modules (`links.ts`, `daily.ts`, `time.ts`,
`sanitizeSvg.ts`); no `node_modules` were installed, so UI tests and Playwright flows were not run.
