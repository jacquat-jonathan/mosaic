# Changelog

What changed in each version of Mosaic. Settings › About & updates shows the sections newer than the installed app, so write each line for someone using the app. New work goes under **Unreleased**; `scripts/release.sh <version>` turns that section into a release.

## Unreleased

- **HTML previews:** shared view/zoom controls, script choices and permission notices preserve per-page consent and source editing. Failed previews can be retried; pending or stale previews stay tied to their vault.

- **Images:** shared loading/error notices and retry actions handle unreadable or invalid images. Previews keep their original rendering, keyboard focus and fit behavior, with late reads guarded by vault and lifetime.

- **PDFs:** readable page metadata and shared loading/error notices add retries for failed files/pages. Pages fit resized panes, rendering exposes busy states, and late reads stay tied to their vault.

- **CSV tables:** shared view choices, metadata, and row/column actions preserve delimiter-aware editing. Cells have explicit labels, and Shift+F10 opens their context menu from the keyboard.

- **Charts:** shared Chart/Source choices, rendering/error notices, and keyboard-scrollable previews preserve local vault data, source edits, and theme redraws.

- **Drawings:** shared Drawing/Source choices and loading/error notices preserve the drawing engine. Returning from Source refreshes the scene, and invalid JSON remains editable for repair.

- **Diagrams:** shared Graph/Source choices, readable render errors, and a keyboard-scrollable preview preserve DOT editing and theme redraws.

- **Canvas:** shared toolbar/view choices, navigation controls, and a readable shape palette preserve card editing and palette dragging. Palette dismissal restores focus, scaled windows keep controls visible, and fit animations respect reduced motion.

- **Error toast:** shared notices and an accessible dismiss action wrap long messages. Automatic dismissal pauses during reading or keyboard focus, and manual dismissal returns focus.

- **Context menus:** shared colors, spacing, readable details and icons preserve nested menus and edge flipping. Arrow/Home/End/type-ahead navigation, submenu focus, Escape and focus return now work from the keyboard, including scaled windows.

- **Quick switcher:** shared search controls and readable note paths preserve recent/fuzzy ranking, keyboard opening, new-tab shortcuts, and note creation. Empty vaults explain how to create a note.

- **Pickers:** shared search dialogs, readable results and accessible keyboard selection preserve fuzzy ranking, commands, and folder choices, including empty results and focus return.

- **New note:** shared modal controls, template fields, previews, and notices retain exact-template creation. Pending creation blocks duplicate actions and dismissal; failures preserve the draft.

- **Confirmations:** shared dialogs provide labelled descriptions, consistent destructive actions, keyboard containment, cancellation, and focus return.

- **Prompts:** shared dialogs and labelled fields provide consistent keyboard dismissal, focus containment, and focus return while retaining Enter submission.

- **Markdown task import:** shared preview controls, readable groups/statuses, notices, and duplicate choices preserve task hierarchy and source notes. Pending imports disable duplicate actions, failures retain selections, and cancellation returns focus.

- **iCalendar import:** shared previews, duplicate choices, notices, and modal actions retain event selection. Importing disables duplicate actions, failures preserve selections, and late file previews cannot replace a newer choice.

- **Subscribed events:** shared detail controls, readable source information, notices, and meeting links retain read-only behavior. Copying disables duplicates, failures stay visible, and closing returns to the calendar.

- **Event archive:** shared Archive/Deleted choices, event rows, notices, and modal controls retain restore and delete actions. Failed reads can be retried; pending actions disable duplicates and restore focus when rows move.

- **Calendar subscriptions:** shared source rows and fields, readable cache/errors, and consistent modal controls retain adding, visibility, refresh, and removal. Pending changes disable duplicates; failed saves keep drafts and completed actions restore focus.

- **Calendar details:** shared daily-note actions, readable task rows, and loading/error notices retain overdue completion. Failed loads can be retried, saving disables duplicate updates, and completion restores focus.

- **Work sessions:** shared date/time fields, validation, conflict notices, and actions preserve exact minutes and all-day sessions. Failed writes retain drafts, background refreshes keep edited minutes, and closing returns to the calendar.

- **Event editor:** shared fields, actions, activity, and notices retain dates, recurrence, colors, and revision checks. Writes disable duplicate edits, failures keep drafts, and closing returns to the calendar.

- **Month calendar:** shared controls and readable date/event metadata preserve the grid, event dragging, and day navigation. Keyboard actions on event buttons now stay with the event.

- **Week calendar:** shared controls and larger event/task metadata preserve the five-day grid, keyboard view changes, and independent scrolling in narrow panes.

- **Today/day calendar:** shared navigation, view choices, notices, and readable event/task metadata preserve scheduling and layer filters. Keyboard users can create an event from an empty time slot.

- **Epics:** shared edit/history dialogs add consistent fields, notices, keyboard dismissal, and focus return. Saving disables duplicate actions and dismissal, and failures preserve the draft.

- **Task editor:** shared fields, actions, activity, and conflict notices retain task lifecycle decisions. Failed saves preserve drafts, failed archives keep the task open, and narrow panes give editing the full width.

- **Task board:** shared actions, labelled filters, readable cards, and retry notices preserve lane dragging, subtask completion, lifecycle views, and exports. Older loads and late task prompts stay tied to their vault.

- **Planning views:** saved titles and queries now use shared task/note results, notices, and completion controls. Missing saved views remain explicit.

- **Query views:** shared results preserve task and note queries, displayed expressions, metadata, and source actions, with readable wrapping in narrow panes.

- **Project tasks:** shared result rows and completion controls preserve the project-tag query and note links, including empty and failed loads.

- **Overdue:** shared task rows and notices retain the due-date filter, completion, and note links. Narrow layouts keep task metadata readable.

- **Tasks:** shared result rows, readable metadata, loading/error notices, and retry actions. Completion waits for saving and returns focus to the remaining results.

- **Note details:** shared attachments, backlink/mention rows, outline actions, and context controls. Failed loads can be retried, link actions disable while saving, and the context drawer fits scaled narrow windows.

- **Note properties:** shared fields, switches, chips, actions, and validation make the properties form consistent. Fields stack in narrow panels, duplicate names are explained, and cancelled additions restore focus.

- **Note formatting:** shared typography, focus rings, theme-aware selection controls, and a consistent read-only notice. Keyboard navigation and cancelled link prompts return to the note; late link choices leave closed notes and other vaults alone.

- **Workspace tabs:** shared controls and typography clarify active tabs and unsaved changes. Split dividers now support keyboard resizing and balancing while retaining tab dragging and saved layouts.

- **Search:** shared labelled fields, result rows, and bookmark controls improve readability. Failed searches can be retried, empty results are explicit, and stale results cannot open while a new query is loading.

- **Tags:** shared tag rows and readable counts keep tag searches one click away. Loading, empty, and failed loads are distinct, with a Retry action.

- **Bookmarks:** shared rows and actions add keyboard opening/reordering, visible missing-file states, focus return, and inline save errors while preserving saved searches, queries, and drag/drop.

- **Files:** shared toolbar controls, clearer file tree selection and typography, and a consistent inline rename field preserve file actions, folder colors, and drag/drop.

- **Sidebar navigation:** shared vault, area, and chat-section controls with clearer selected states and focus return. Side panels resize with the keyboard, account for interface scale while dragging, and stay within narrow windows.

- **Destination navigation:** shared controls, clearer selected states, readable attention counts, and keyboard focus that stays on the rail when moving between areas.

- **Window title:** shared theme and typography make the vault name and app version clearer while retaining the native drag area and narrow-window truncation.

- **Welcome:** consistent open/create controls, loading feedback, and persistent errors. Cancelled choices restore focus, pending actions disable duplicates, and stale choices leave an already-opened vault alone.

- **File history:** consistent version entries, keyboard selection, comparisons, and restore actions. Failed reads can be retried, restores disable while pending, and history closes when switching vaults.

- **Review dialog:** a wider, consistent diff view with partial acceptance, rejection feedback, stale-change comparison, and focus restoration. Decisions disable while saving, failed comparisons can be retried, and older WebKit versions use a focus-managed modal fallback.

- **Activity & review:** consistent change rows keep proposals first and History/Undo beside each applied change. Failed loads can be retried, undo actions disable while pending, and dialogs return focus to their opener.

- **Chat:** consistent messages, expandable tool activity, attachments, model choice, and send/stop controls. Connection failures can be retried, saved-note writes stay tied to the vault, and context details use readable metadata.

- **Chats list:** clearer saved-conversation rows, date groups, selection, and actions. Cancelled rename/delete dialogs restore focus, and pending decisions stay tied to their vault.

- **Run details:** consistent status, metadata, logs, and review outcomes. Expand a tool call to inspect its file, error, or review action; live output follows the log while you stay near the bottom.

- **Run history:** All runs and Recent runs now share the larger table, clear status icons, review counts, tool warnings, and errors. Narrow panes keep dates and durations readable beneath each row.

- **Workflow details:** the selected workflow and its context panel now share readable cards, metadata, statuses, and source actions. Editing receives focus, cancelled drafts stay intact, and returning to details restores the Edit button.

- **Workflow editor:** consistent fields, switches, folder choices, validation, and save actions. Failed saves keep drafts, saving disables edits, and manual-only workflows can be created without a YAML initialization error.

- **Workflow and Agent library cards:** clearer triggers, review policies, latest results, and expandable settings. Actions keep their existing behavior, with disabled saving states and guards against stale selections after switching vaults.

- **Connections & safety:** consistent setup commands, copy feedback, folder rules, and workflow-chain controls. Saves disable related controls, failures keep saved choices, and pending folder selections stay tied to their vault.

- **About & updates:** consistent version details, notices, release notes, progress logs, and update controls. Status failures can be retried, cancellation restores focus, and restart controls disable while drafts and notes are checked.

- **Shortcut settings:** labelled binding controls, clearer recording and conflict notices, and visible custom bindings. Escape cancels capture, Tab leaves it, and resetting shortcuts returns keyboard focus to the list.

- **Workspace settings:** consistent startup choices, sidebar switches, width sliders, and reset actions. The startup-note picker restores focus and keeps pending choices tied to their vault.

- **Calendar & links settings:** consistent date, week-start, and link controls, with clearer save errors. Resetting app preferences preserves the vault's file-name format and link syntax.

- **Templates settings:** consistent folder fields, default rules, notices, and starter previews. Failed saves keep your draft, starter installation preserves existing templates, and preview actions restore keyboard focus.

- **Vault folders settings:** consistent folder choices, attachment switches, color controls, and reset actions. Saving disables related controls, missing folders are created only when requested, and pending choices remain tied to the vault where they started.

- **Editor & files settings:** consistent labelled switches and reset controls for spellcheck, source line numbers, Trash confirmation, and HTML previews. The vault's HTML policy shows save errors and remains separate from the app-wide Editor reset.

- **Settings navigation:** labelled search, consistent section controls and headings, and clearer keyboard focus. Narrow panes keep the sections in a scrollable navigation area above their settings.

- **Appearance settings:** larger interface text, consistent fields and reset controls, and keyboard-friendly theme and note-width choices. Your saved appearance preferences and section reset behavior are preserved.

- **Focused AI workspace:** switch between Chats and Automations, keep older conversations collapsed, and find workflows, runs and reviews together. Run status and metadata use a compact header with expandable details and separate tool warnings.

- **Workflow run logs:** follow answers and tool calls as a workflow runs, open the notes it reads or changes, and revisit its saved log afterward. Markdown formatting and review links match chat; older runs still show their recorded result.
- **Visual table editing:** cells keep their formatting while you type and save immediately. Use row/column handles, insertion buttons, drag or keyboard reordering, rectangular selection, formatting controls and spreadsheet paste. Markdown source editing is an explicit option; undo/redo and existing links, formulas and alignment are preserved.
- **Readable update notes:** release descriptions wrap within the settings pane, including long links, instead of being clipped horizontally.

## 0.26.0 — 2026-10-27

- **HTML reports can be trusted per vault:** optionally allow scripts by default for every HTML file
  in a vault while keeping network access blocked, and override that choice for one page until Mosaic
  quits. Mermaid blocks embedded in HTML now render as diagrams even when page scripts stay blocked.
- **Long file trees keep moving while you drag:** holding a file or folder near the top or bottom of
  the tree scrolls it automatically, including while importing from Finder.
- **A plain new line from anywhere:** the editor's adjacent + action is available on every line and
  inserts the same blank line as pressing Enter; heading drag handles still reorder whole sections.
- **More flexible planning:** reorder epic swimlanes by dragging or with Move up/down, and open any
  work session in the right panel to enter exact start and end times instead of quarter-hour values.
  Calendar dragging and resizing continue to snap to 15-minute steps.
- **Agents can manage Board tasks:** MCP tools can list epics and tasks, read full task history, and
  create, edit, move, complete, reopen, archive, restore or trash tasks with revision conflict checks.
  Their changes refresh an open Board or Calendar automatically.

## 0.25.0 — 2026-10-21

- **Calendar cards focus on the event name:** cards now show only the title, keep its beginning
  anchored on the left, and wrap onto more lines when the card has enough height.
- **Updated meetings appear once and cancelled meetings stay hidden:** calendar subscriptions now
  replace an original recurring occurrence with its latest exception, honor excluded dates and
  cancellations (including Outlook's `Canceled:` titles), and keep only the newest revision when a
  feed contains several versions.
- **Calendar subscriptions with custom week starts stay visible:** recurring events that include the
  standard `WKST` setting now load correctly, including every-other-week schedules.
- **Note files and links kept in focused parts of Mosaic's engine:** reading and changing files now
  goes through `FileService`, while backlinks, mentions and outlines go through `LinkService`. They
  share the same vault rules, history and index, so app, CLI and agent behavior stays unchanged.

## 0.24.1 — 2026-10-19

- **Outlook calendar subscriptions load correctly:** published Outlook feeds that use Windows timezone names, such as `W. Europe Standard Time`, now refresh and display instead of failing with an unknown-timezone error.

## 0.24.0 — 2026-10-17

- **Reviewing agents' changes kept in one place inside Mosaic:** listing, accepting, rejecting and withdrawing agents' proposals now go through one part of Mosaic's engine instead of being spread across it. Nothing changes in how review behaves.

## 0.23.0 — 2026-10-17

- **Planner kept apart from notes inside Mosaic:** the planner and calendar now run as their own part of Mosaic's engine, with their own state, so work on notes and work on the planner can't interfere with each other. Nothing changes in how either behaves.

## 0.22.0 — 2026-10-17

- **Fewer mismatches between the app's window and its engine:** the interface now gets the exact shape of every command and result from the engine itself, so a change on one side that the other doesn't follow is caught before a release. Doing this fixed a few small mismatches, such as a review that could open without knowing whether the file had changed since the agent's proposal.
- **Main flows tested by clicking through them:** every change now also opens a note, renames one, edits a note while an agent changes it, and accepts an agent's proposal in a real browser before it can ship. The rename box in the file tree is now announced as "New name" to screen readers.

## 0.21.0 — 2026-10-16

- **Security fixes in bundled libraries:** the drawing editor, diagrams and math rendering now use patched versions of the small libraries they depend on (nanoid, lodash-es, source-map-js and KaTeX), closing the known security advisories against the older copies.
- **Notes and diagrams can't run code in the app:** Mosaic's window now only runs its own scripts. Graphviz diagrams and canvases are cleaned before they are shown, so a link or attribute in a diagram file can't carry a script, and odd canvas positions or colours are ignored. **Open in default app** now only opens files inside the vault and refuses programs, installers and scripts.
- **Folder rules and bookmarks follow your vault:** each vault's folder rules (Settings › AI), bookmarks and workflow schedule state are now kept per vault instead of in one shared settings file, so they stay with a vault you move or rename, and the scheduler's frequent bookkeeping can never damage the rules. Mosaic moves them over the first time you open each vault. Each agent request now checks one consistent set of rules, and if a vault's rules can't be read, agents are paused for that vault instead of seeing every folder.
- **Renames never leave broken links silently:** when moving or renaming a note can't update a link in another note (for example a locked folder), the move still completes and Mosaic says which notes it couldn't update instead of reporting the whole move as failed. If a move didn't finish, including when Mosaic was quit half-way, a banner offers **Fix links** to update the rest.
- **Simpler, quieter updates:** the developer-only option that pulled and rebuilt a source checkout is gone; updates are the signed downloads from GitHub Releases. Update downloads and calendar feeds now share one HTTPS connection policy. Agents' proposals appear the moment they're made, and Mosaic no longer asks for them every few seconds in the background.
- **When Mosaic goes online, spelled out:** the README now lists every case: update checks when you click, subscribed calendars while the Calendar is open, and Claude Code for chats and workflows.

## 0.20.0 — 2026-10-16

- **One manual download needed:** this version is signed with a new release key, so Mosaic 0.19 and earlier can't install it from About & updates (they report that the signature can't be verified). Download the DMG from the GitHub release page once; later updates install from within the app as before.
- **Safer update signing:** releases are signed in a separate, approved step that never runs third-party build code, and the app can trust a second, standby signing key, so a compromised key can be replaced without stranding installed copies.
- **Consistently formatted, linted UI code:** the interface code is formatted and checked by Biome on every change, which catches React hook dependency mistakes before they reach a release.
- **Undo history that lasts:** undo history and pending AI proposals move out of the Caches folder, which macOS and cleaning tools may empty, into Application Support. They now follow a vault you move or rename, a copied vault starts its own history, and if the history can't be saved Mosaic says so in a banner instead of quietly keeping it only until you quit. Existing history is moved over the first time you open each vault.
- **Faster AI tool calls on large vaults:** while Mosaic is open, agents' searches and queries use the index the app already keeps current instead of re-scanning every file first, and a quick run of calls shares one scan.
- **Notes don't depend on the planner:** `mosaic` commands and AI agents work on notes even when the planner's database is damaged, and no longer create a `.mosaic` folder in vaults that don't use the planner. The planner also waits briefly instead of failing when two windows use it at once.
- **No more freezes while a vault indexes:** file, search, history and planner work now runs off the window's thread, the index catches up in small batches so typing right after opening a large vault saves at once, and finding Claude Code no longer re-reads your shell profile for every chat.
- **Checked on every change:** the full test suite now runs on GitHub for each push to `main` and each pull request, not only when a release is cut.
- **Chats and workflows read only through Mosaic:** Claude no longer uses its own file tools, which could read hidden folders and files outside the vault; it reads with Mosaic's tools, so folder rules always apply. Workflows reach the web only when you tick **Can use the web** (`web: true`), and a run started by a new note treats that note as untrusted input.
- **Folder rules fail closed:** if Mosaic's settings file is damaged or can't be read, agents are refused with a clear message instead of briefly seeing every folder as if no rules existed.
- **Folder rules can't be sidestepped by spelling:** hidden, read-only and review folders now apply however an agent spells the path — `private/secret.md` is treated like `Private/Secret.md`, and accented names match in either Unicode form — and a link inside the vault is judged by where it points.

## 0.19.0 — 2026-10-15

- **Faster note shaping:** reorder sibling heading sections from the editor or Outline by dragging, or use ⌥↑/⌥↓ in the Outline; nested subsections move with their parent and numbered headings are renumbered. The adjacent + action creates a same-level section, while the compact slash menu groups its choices, adds callouts, math, links and embeds, and calls checklist items Checkboxes.
- **Formatting where you work:** selecting note text reveals compact Bold, Italic, web-link and Mosaic-note-link actions alongside their keyboard shortcuts. Heading add and drag controls stay out of the way until hover, and the taller slash menu uses the app surface without a bright frame.
- **Folder templates and quiet attachments:** a folder menu shows which template it inherits and links directly to editing or changing that default. Embedded images and PDFs stay out of the file tree by default, remain visible from Note details, and can be restored to the tree from Vault settings.
- **Zoomable HTML previews:** zoom local HTML reports and large diagrams from 50–200%, with a one-click 100% reset. Zoom affects only the current preview and does not change the file.
- **Navigation and local HTML:** the destination rail is grouped into Files, Plan, AI and Settings; changing tabs or focused splits reveals the active file in the tree; and HTML previews can load relative vault CSS, scripts, fonts, media and JSON data without gaining network access.
- **Responsive note editing:** tables stay inside their pane, keep stable column widths while typing, and can grow one column at a time up to the pane edge. `/table` opens as an editable table immediately, narrow notes wrap instead of disappearing off-screen, and closing a split restores the remaining pane to the full workspace.
- **Independent planning:** plan app-owned tasks in epic swimlanes, nest subtasks, track estimates and due dates, and review per-item activity without changing Markdown checkboxes. A previewed import can copy existing note tasks when wanted.
- **Calendar:** schedule multiple task sessions, create recurring timed or all-day events, edit occurrence exceptions, and work in accessible month, week and day views with workload and overlap layout.
- **Calendar exchange:** preview and import `.ics`, export local events, and subscribe to read-only iCalendar feeds whose URLs stay in Keychain and whose last successful cache remains available offline.
- **Recovery and portability:** archive, Trash and restore planner items; export complete JSON or flat CSV; explicitly restore the last valid planner backup while retaining the damaged database. Existing vault upgrades leave Markdown tasks byte-for-byte unchanged.

## 0.18.1 — 2026-10-08

- **Release builds:** clean checkouts now prepare the bundled command before compiling the app, so the GitHub release workflow can run without locally generated files.

## 0.18.0 — 2026-10-08

- **Downloadable Mac app:** universal Intel/Apple Silicon DMG installation, signed release packages and a download/verify/restart updater without development tools. Ad-hoc Apple signing remains free; first-launch approval and recovery are documented.
- **One-page workflows:** a focused create/edit workspace with simultaneous schedules and events, searchable folder chips, visible review safety, draft-discard prompts and source-preserving saves.
- **Personalization:** local fonts, typography, accents, interface scale/density, source line numbers, per-vault folders and attachment destinations, daily formats, link syntax, week start, startup choices, folder colors, settings search and scoped resets. Shared preferences preserve unknown settings and follow renames without moving files.

- **MCP setup:** the recommended Claude Code connection is available across all your projects and follows the vault selected in Mosaic. Setup uses the bundled absolute command path and explains vault switching and older project-specific registrations.

## 0.17.0 — 2026-10-08

- **Note templates:** configure a Templates folder and inherited folder defaults in Settings. Every ordinary New note action lets you choose a template or Blank, preview its structure, and fill title/date values before creating it. Add editable Meeting, Retro, Project, Analysis and Brainstorm starters when you want them.
- **Templates for AI:** agents and the CLI can discover folder defaults, render a report structure, or create a note scaffold with the same templates. Existing permissions, history and review still apply; imports and completed reports keep their content.

## 0.16.1 — 2026-10-08

- **Table resizing:** dragging a column boundary now redistributes width between its two neighboring columns, keeping the table's total width steady. Keyboard resizing works the same way, and the first resize preserves the table's natural width.

## 0.16.0 — 2026-10-08

- **What's new:** release notes in Settings render bold, emphasis, code and links as Markdown.
- **Editor helpers:** type `/` on an empty line to choose a heading, table, list, quote, code block, diagram or query. Resize table columns by dragging their boundaries or using the arrow keys; widths stay in app storage per vault, note and table.
- **Task board:** open Plan › Task board to drag cards between New, Blocked, In progress, In QA and Done. Subtasks are grouped under their parent, with progress, search, folder filtering and a keyboard-accessible state menu. Workflow states travel with the Markdown note; existing calendars, queries, history and conflict checks still apply.

## 0.15.0 — 2026-10-07

- **Event-triggered workflows:** run an agent when a Markdown note is created in a selected folder, including imports and copies. Event runs are queued, explain what triggered them, can be tested against an existing note, and may safely trigger other workflows within a configurable chain-depth limit.
- **Workflow controls:** choose Claude's default, Sonnet, Opus or Haiku per workflow; combine schedules with one or more folder events; pause all automatic runs or one workflow; transient failures retry up to twice before asking for attention.
- Run details now show their trigger, note, model, retry attempts and workflow-chain depth. Existing `may-change`, review, read-only and hidden-folder rules continue to govern every automatic run.

## 0.14.0 — 2026-10-07

- Markdown emphasis and other inline formatting now render inside editable table cells; focusing a cell reveals its Markdown source.
- Structured queries support uppercase `OR` between groups, and queries can be saved and run from Bookmarks.
- Review changes hunk by hunk, and review proposed file renames and binary additions. Mosaic requests attention when a proposal arrives while it is in the background.

## 0.13.1 — 2026-10-07

- **Workflow cleanup:** delete a workflow from its actions menu. Its agent file or skill folder moves to the macOS Trash, future scheduled runs stop, and existing run history stays available.
- **Cleaner note editing:** Properties now live only in the right context panel, while Edit as YAML remains available. Up/Down no longer skips blank lines or headings in live preview, and spellcheck no longer triggers macOS automatic corrections.
- **Faster daily notes:** double-click any calendar day to open or create its daily note; opening today keeps the existing task carry-over behavior.
- Search uses one clear focus indicator instead of overlapping outlines.

## 0.13.0 — 2026-10-07

- **Notes, Find, Plan and AI**: a new navigation rail keeps destinations separate from your open workspace. Notes, calendars, chats, workflows, runs and settings can share tabs and split panes, with context for the selected item on the right.
- **Saved conversations**: chats stay in their vault, with titles, drafts, attachments, model choices and session history. Rename or delete a conversation from AI.
- **Plan and workflows**: Today, Calendar, Tasks and saved task views live in Plan. Create manual or scheduled workflows, choose allowed folders, pause schedules and inspect run results and proposals in AI.
- The macOS title strip, window geometry, compact layouts and keyboard focus navigation now work across the workspace.

## 0.12.1 — 2026-10-06

- **Faster note-to-chat work**: attach the selected text from the open note to a message, and choose Claude's default, Sonnet, Opus or Haiku model before sending.
- **Sortable query tables**: click a query result header to sort ascending, descending, then return to the query's original order; the chosen sort is written into the query block.
- Fixed the editing cursor sometimes appearing to jump when clicking or moving with the arrow keys at the boundary between live-preview elements.

## 0.12.0 — 2026-10-06

- **Tessera scheduled agents**: add `schedule: daily 08:00`, `weekdays 08:00`, `fri 17:00`, `every 2h` or `every 30m` to an agent. It runs while Mosaic is open and catches up once after a missed run. The new Runs tab has Run now, pause controls, results, changed files, failures and proposals. A scheduled agent writes directly only inside its `may-change` folders; other changes wait in AI activity for review.

## 0.11.1 — 2026-10-06

- Chat: Claude now knows which note you have open, and a change you ask for without naming a note goes to that note (it edited another one before); if it means to change a different note, it says which first.
- Agents in Claude Code are `/mosaic:<name>` (shown with "(MCP)"); the docs said `/mcp__mosaic__<name>`, which Claude Code doesn't accept.

## 0.11.0 — 2026-10-06

- **Chat with Claude** (the chat icon in the left bar, ⇧⌘L, or the Chat tab of the right panel): ask about your notes or have Claude change them. It runs Claude Code in the vault with only Mosaic's tools for changes, so every change is in AI activity with Undo, and in folders you review it waits for you. The open note is attached (remove it, or attach more with the clip); answers link to notes; each step shows as a short line ("Edited Projects/Site"). Start an agent from the buttons of an empty chat or with `/name`. New chat, Stop, Save as note (in `Agents/Chats/`), and the cost so far. Needs Claude Code installed and logged in.
- **Agents in the vault**: a note in `Agents/` (or a Claude Code skill folder `Agents/Name/SKILL.md`) defines an agent: its properties give a `description` (and `schedule` and `may-change` for later), its body the instructions. Claude recognizes them as agents: each is an MCP prompt (in Claude Code, `/mosaic:<name>`), Mosaic mirrors them into the vault's `.claude/skills/` (never touching skills it didn't make), the vault guide explains them, and agents get `list_agents`; also `mosaic agents [--sync]`.

## 0.10.1 — 2026-10-05

- **Add a property** (⌘; or the command palette): opens the properties panel's "Add property" form, also on a note that has no properties yet.
- Numbered sublists: a nested item still written "3." (left by pressing Enter, then indenting) showed as 2.3 instead of 2.1.

## 0.10.0 — 2026-10-04

- **Calendar** (the calendar icon in the left bar, or "Open calendar" in the command palette): each day's tasks, from its daily note and from tasks anywhere with a `📅 2026-10-04` date. The week view lists every task, with subtasks and their progress (2/3), and you tick them right there; the month view shows each day's open and done counts and first tasks. Click a day to open its note (or create it). Dated tasks still open after their day show as overdue.
- **Carry-over**: when you open today's daily note, the unfinished tasks of your last daily note move into it, each with its unfinished subtasks; the old note keeps them as `- [>]` (moved), and finished subtasks stay there. Agents can do the same (`carry_over`) and see the calendar (`tasks_by_day`); also `mosaic days` and `mosaic carry-over`.
- **Tables you edit in place**: click a cell and type. Tab, ⇧Tab and Enter move between cells (past the last row adds one); right-click for inserting or deleting rows and columns and aligning a column; the + buttons beside and under a table add a column or a row. The Markdown is written back with aligned columns.
- **Note width**: Settings › Editor › Note width is now Narrow, Medium, Wide or Full (it was an on/off "readable line width").
- **Numbered sublists** show as 2.1, 2.2, 2.2.1 (the Markdown stays `1.` indented, as Obsidian expects).
- **Icon bar on the left**: Files, Search, Bookmarks, Tags and AI activity are always one click away, even with the sidebar hidden; clicking the open panel's icon hides the sidebar.
- **Splitting is easier to find**: a split button in each pane's tab bar, and you can drop a tab on the right or bottom edge of a pane to open it there.
- Errors in ```query blocks (and a few other places, like saving a pasted image) showed "[object Object]" instead of the message.

## 0.9.1 — 2026-10-03

- **Task queries**: `task:open` lists checkbox tasks across notes instead of notes, e.g. `task:open folder:Daily` or `task:open due<=today sort:due` (a task's own `📅 2026-10-05`, else its note's `due`). Subtasks stay nested under their task, and in a ```query block you tick tasks right in the table. Also `task:done`, `moved` (`[>]`), `cancelled` (`[-]`) and `all`, from the CLI and for agents too.
- Review: when you changed a file after an agent proposed a change to it, the review window says so in a clear banner and can show what you changed since. The agent now sees "undone" when you undo a change you accepted, and `overwrote` when you accepted it over your own edits.
- Folder rules for agents fail closed: a rule this version doesn't understand (written by a newer Mosaic) is enforced as read-only, and settings it doesn't know are kept when it saves. Before, an older Mosaic dropped every folder rule in that case.
- Settings › AI › Add a folder…: the folder picker opens in front of Settings, not behind it.
- Queries: comparing a date or number with a word that is neither (a typo like `due<=tomorow`) now matches nothing instead of every note.
- Settings › AI: the folder rules section is called "Folder rules for agents", and a folder you add starts as "Review changes".

## 0.9.0 — 2026-10-03

- **Review agents' changes** (Settings › AI › a folder › Review changes): in that folder, an agent's edits, new files and deletions don't touch your files. They wait under AI activity (with a count on its tab); open one to see the change as a diff, then accept or reject it, optionally saying why. Accepted changes show in AI activity with Undo. Agents see your decisions (`list_proposals`) and can take a proposal back.
- **Queries**: find notes by tag, folder, frontmatter field, date or links, e.g. `tag:project status!=done due<=today+7 sort:due`. Put one in a note as a ` ```query ` block to get a live table (a project dashboard), run `mosaic query …`, or let agents use the new `query` tool.

## 0.8.0 — 2026-10-02

- **Properties editor**: a note's frontmatter shows as a form (lists as chips, checkboxes, dates, numbers, text). Add, rename or remove properties; "Edit as YAML" shows the source. Comments and formatting in the YAML are kept.
- **Custom shortcuts**: in Settings › Shortcuts, click a shortcut and press new keys; any command can have one, and a taken shortcut moves over (Settings says from which command).
- **Export a note** as a standalone HTML file (diagrams, math, images and embedded canvases included) or as PDF through the print dialog (⇧⌘P, or right-click › Export).
- `==highlights==` now show in canvas cards, previews and exports too.
- **Connections that go around cards**: right-click a connection › Path › Around cards draws it with right angles, avoiding the cards in between (also Straight). When you zoom out on a busy diagram, connection labels hide until you hover them.
- **Timing diagrams** with real lanes: the new Timing shape draws each line `Door: Closed@0 Open@5 Closed@12` as a step line over a time axis (`time: 0..20 s`). The Timing template uses it.
- **Drag shapes** from the Shape menu onto the canvas: it opens a palette of every shape and icon.
- **Copy as Mermaid** writes a `sequenceDiagram` for canvases with lifelines (alt/loop frames included) and a `classDiagram` for class boxes (members, inheritance, composition, multiplicities).
- **Open as diagram** now works on Mermaid class diagrams too, keeping Mermaid's layout.

## 0.7.0 — 2026-10-02

- **Paste images** into a note: they're saved next to it and embedded.
- **Daily notes**: ⌘⇧D (or the calendar button above the file tree) opens today's note, created from a template if you set one (Settings › Editor & files; `{{date}}`, `{{title}}`, `{{weekday}}`, `{{time}}`).
- **Unlinked mentions** under Backlinks: notes that mention this one by name or alias without linking, with a one-click **Link** that keeps your wording.
- **New canvas from selection**: select notes in the file tree, right-click, and get a canvas with them as cards.
- **Bookmark a search** with the star in the Search panel; it shows in Bookmarks and runs with one click.
- ⇧↑ / ⇧↓ extend the selection in the file tree.
- Search, backlinks and tags stay responsive while a big vault is being indexed.
- Fixed: when the app and an agent (or the `mosaic` command) opened or updated the index at the same moment, one could fail with "database is locked".
- Fixed: moving a note rewrote links that used one of its aliases (`[[Start]]` became `[[Home]]`); alias links now stay as written.
- **Folders agents can't change** (Settings › AI): make a folder read-only for agents, or hide it from them entirely. Enforced by Mosaic for the MCP server and the `mosaic` command, never for you.
- Agents can move several files at once (`move_files`, or `mosaic move … --to Folder`) and add images and other files (`import_file`, base64, up to 20 MB).
- Notes are available as MCP resources (`mosaic:///Folder/Note.md`), so AI clients can attach them as context directly.

## 0.6.0 — 2026-10-02

- Agents can **see what they drew**: the new `render` tool returns a picture of a canvas (or SVG file), so they can check and fix a diagram. Also `mosaic render <file> -o out.png`.
- **File history**: Mosaic keeps versions of every file changed by you, the command line or an AI agent (and notices changes made by other apps). Right-click a file › File history… (or ⌘P › Show file history) to compare any version with the file now and restore it.
- **AI activity** (new sidebar tab): every change agents made, newest first, with the agent's name and one-click **Undo** (an edit goes back, a created file goes to the Trash, a deleted file comes back, a move is reversed).
- Agents get `file_history` and `restore_version` tools to undo their own mistakes; the CLI gets `mosaic history`, `restore`, `activity` and `undo`.
- Fixed: a tab restored from the last session could stay on "Loading…".
- Fixed: the **Open as diagram** button on Mermaid blocks in notes didn't appear.

## 0.5.0 — 2026-10-02

- Network and cloud icons for diagrams (server, database, router, user…) under Shape › Icons, or right-click a card › Icon; they're included in exports. New **C4 containers** template.
- Editing a Mermaid, Graphviz, chart or math block in a note shows a live preview under it; while the source has an error, the last good drawing stays with the error below.
- Hovering a node of a Mermaid flowchart (in a note or a card) makes its connections flow and dims the rest.
- **Present** a canvas (toolbar › ⋯): it fills the screen and steps through its groups and frames with the arrow keys, connections flowing; Esc to stop.
- `![[Diagram.canvas]]` in a note shows the diagram as a picture; click it to open the canvas.
- Export a canvas as SVG or PNG (canvas toolbar › ⋯); the file is saved next to the canvas.
- **Open as diagram**: hover a Mermaid flowchart or state diagram in a note to turn it into an editable canvas next to the note, keeping Mermaid's layout.
- **Copy as Mermaid** (canvas toolbar › ⋯) turns a diagram back into a Mermaid flowchart to paste into a note.
- UML stencils in the Shape menu (now grouped: Basic, Flowchart, UML structure, UML behaviour): class boxes with compartments (separate them with `---` lines), package, component, node, artifact, port, initial and final states, fork/join bar, lifeline, activation bar and frame.
- A template for each of the 14 UML diagram types under New diagram…, each noting the 4+1 view it serves.
- More connection points along each side (and all along a lifeline), thicker or thinner connections, and **Layout** to arrange cards top to bottom or left to right along their connections.
- AI agents now work on the vault open in Mosaic and follow when you switch vaults, so their files always land where you're looking. **If you connected Claude Code before, run `claude mcp remove mosaic`, then the command in Settings › AI** (it no longer pins a vault). An agent tied to a vault with `--vault` is warned when Mosaic shows another one.

## 0.4.0 — 2026-10-02

- Diagram shapes on canvases: rectangle, rounded, pill, ellipse, diamond, parallelogram, hexagon, cylinder, document, predefined process, cloud, note and actor, from the new **Shape** button. Right-click a card to change its shape, border or colour.
- Connection styles: dashed or dotted lines, UML arrowheads at either end (hollow triangle, open arrow, filled and hollow diamond, circle), labels near each end (like `1..*`) and Reverse direction, from a connection's right-click menu.
- Dragging a card snaps its edges and centre to other cards nearby, with a guide line.
- Hovering a card makes its connections flow in their direction and dims the rest (still, without motion, when macOS "Reduce motion" is on).
- **New diagram…** replaces New canvas: start blank or from a template (flowchart, 4+1 architecture views, C4 system context). Find it in the New menu, the file tree's right-click menu and the command palette.

## 0.3.0 — 2026-10-01

- Search finds the text in Excalidraw drawings without the JSON around it.
- Backlinks from a canvas show the card's text (or "File card"), and every link from a canvas is listed, not just the first.
- A chart's data file (e.g. `code-size.csv`) lists the chart as a backlink.
- Images in Markdown syntax (`![](image.png)`) look next to the note first, like the rest of Mosaic.
- Canvas cards render Mermaid, Graphviz and Vega-Lite blocks and math (`$…$`, `$$…$$`), like notes do. So do note previews in file cards.
- AI agents get a clear error when they write a broken canvas, drawing, chart or JSON file, and nothing is written.

## 0.2.0 — 2026-10-01

- The window can be moved again by dragging the sidebar header, the tab bar or the welcome screen.
- Mosaic now has real version numbers: About shows the version and its commit, and "Check for updates" lists the new versions with what changed in each.
- A running update can be cancelled; the installed app stays as it was.

## 0.1.0 — 2026-10-01

- Vault and file tree: open any folder of Markdown notes (Obsidian-compatible), create, rename, move and delete files, with link-aware renames.
- Markdown live preview with wikilinks, embeds, tags, tasks, math, Mermaid, Graphviz and Vega-Lite.
- Full-text search, backlinks and an outline panel, backed by a local index.
- Split panes, tabs, live refresh when files change on disk, and a layout that's remembered.
- Viewers for HTML, PDF, CSV, JSON, images and code; canvases, Excalidraw drawings, charts and graphs.
- The `mosaic` command and an MCP server so AI agents can read and write the vault.
- UI foundations: resizable sidebars, tree drag and drop and multi-selection, vault switcher, bookmarks, command palette (⌘P).
- Settings (⌘,) with appearance, editor, vault, AI, shortcuts, and in-app updates from the source checkout.
- Dropping files from Finder imports them into the vault; spellcheck in the editor.
