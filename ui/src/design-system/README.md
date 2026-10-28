# Mosaic design system · approved design

A standalone inventory of Mosaic's existing interface and a candidate component API (v0.3).
The visual design and gallery were approved on 2026-10-28 after review of typography,
icons, focus behavior, overlays, workflows, runs, chat, and Activity & review.
**Settings → Appearance** was visually accepted on 2026-10-28. Settings navigation, header,
and sections, Connections & safety, workflows, runs, chats, Activity & review, file history,
Welcome, and app navigation are migrated. **Files and Find** are next; remaining workspace
and planning surfaces keep their existing controls.

## Open the gallery

From the repository root:

```sh
pnpm --dir ui design-system
```

Open http://localhost:1421/design-system.html. The existing dev server also serves
`/design-system.html`, but the dedicated command avoids starting the app or its backend.
Use the Light / Dark / System controls; `?theme=dark` and `?theme=system` also work.
Theme and demo choices stay in memory, without reading or writing application settings.

```sh
pnpm --dir ui design-system:build
# Output: ui/dist/design-system/design-system.html and assets/
pnpm --dir ui exec vite preview --config vite.design-system.config.ts --port 1421
```

The gallery remains separate from the app entry, Tauri configuration, and Vite configuration.
The gallery has its own HTML entry and build configuration; it is not an app route. A normal
app build may clean `ui/dist`, so rebuild the gallery when needed.

## What to review

1. Inspect color, typography, spacing, radii, and floating surfaces in both themes.
2. Compare default, hover, pressed, focus, and disabled button specimens. Those columns
   deliberately fix the visual state; other controls show their actual interaction states.
3. Try fields, validation, switches, and segmented choices using the keyboard.
4. Open dialogs and the action menu; check focus entry, navigation, Escape, and focus return.
5. Review settings rows and the document toolbar at desktop and narrow widths.
6. Search the Lucide catalog, select an icon, and copy its exact name for a UI request.
7. Try the workflow, run, chat, and Activity & review examples, including error and stale states.
8. Review the larger typography and product patterns, and settle contrast decisions before migration.

The large gallery heading, sidebar navigation, and swatch layout are presentation for this
review page. They are not new application typography or layout requirements.

## Files and boundaries

| File | Purpose |
| --- | --- |
| `tokens.css` | Opt-in theme, color, spacing, type, shape, and motion variables |
| `controls.css` | Styles for candidate controls under a `.mosaic-ds` ancestor |
| `components.tsx` | Stateless/controlled React building blocks; no store, IPC, or vault dependencies |
| `index.ts` | Gallery barrel exports and stylesheet imports |
| `patterns.tsx`, `patterns.css` | Candidate workflow cards, run ledgers/logs, transcript messages, composer, changes, and diffs |
| `ProductExamples.tsx` | Interactive product patterns using local sample data, without app stores or a backend |
| `IconCatalog.tsx` | Searchable catalog of every canonical icon in the installed Lucide package |
| `gallery.tsx`, `gallery.css` | Isolated review page with local demonstration state |
| `../../design-system.html` | Separate HTML entry |
| `../../vite.design-system.config.ts` | Separate preview/build configuration |

All tokens use the `--mds-` prefix. All component styles use `mds-` classes and are scoped
under `.mosaic-ds`. They do not redefine legacy variables or generic app element styles.
Only the gallery stylesheet resets `body`; never import it into the application.

## Application adoption: Settings

`views/DesignSystemScope.tsx` adapts the existing app preferences to one opt-in surface.
It imports only foundation tokens and control styles, sets an explicit local theme scope
(needed when the app forces a theme different from the system), and maps `--mds-accent`
to the user's existing accent. Interface scale continues to use the document's existing zoom,
so it is applied once. Comfortable rows use the approved 14px spacing; Compact uses the
existing 10px spacing token within this screen. Other sections retain their existing styles.

The adapter supports semantic `nav` and `header` elements. Settings navigation, header, and
the active migrated section use separate scopes, so remaining section content keeps its existing
typography and controls. `views/settingsNavigation.css` owns the migrated layout and replaces
the old global navigation/header rules. Search uses a visibly labelled field and shared buttons;
the current section is announced with `aria-current="page"`. Selecting a search result clears
the query and returns focus to search. Section navigation uses native button keyboard behavior.
Narrow panes keep navigation in a bounded scroll area above the section body, using the existing
container breakpoint as well as the narrow-window breakpoint.

`views/AppearanceSettings.tsx` uses shared setting rows, icon buttons, buttons, segmented
choices, and input styles. Native range inputs add a scoped `mds-range` treatment. Setting
rows can associate their visible label with a control and expose a hint ID; segmented groups
can reference that hint. The note preview keeps its note font, size, width, line spacing,
heading scale, and code font preferences independently of interface typography.

`views/EditorFilesSettings.tsx` adopts shared rows, switches, reset buttons, and notices for
spellcheck, source line numbers, Trash confirmation, and the vault's HTML script policy.
Switches associate their hint/error descriptions with the control. The Editor section reset
retains its app-wide scope and focus return; it does not reset the vault policy. HTML policy
actions are disabled while saving or when vault preferences are unavailable. Failed writes
leave the saved value in place and show an inline error. A vault change remounts the policy
control so pending/error UI from the previous vault does not carry over.

`views/VaultFoldersSettings.tsx` adopts shared rows, buttons, selects, switches, badges, and
notices for vault selection, folder/note defaults, attachment visibility, and folder colors.
Changes are serialized within the screen, with disabled controls and inline save errors.
Picker/prompt/confirmation callbacks check the active vault before changing preferences;
changing vaults remounts the local UI. Missing paths keep their explicit Create folder action.
The folder reset touches its nine existing keys, preserving HTML policy, calendar/link settings,
template assignments, and files. Agent-folder changes and reset refresh generated agent mirrors.
Existing picker, text-prompt, and confirmation overlays are retained for their later migration.

`views/TemplatesSettings.tsx` adopts shared fields, selects, buttons, badges, and notices.
Folder assignments remain a draft until Save, including after a failed write or a template-list
retry. Native fieldsets group each inheritance rule; Blank still stops inheritance and removing
a rule restores it. Starter previews keep their raw Markdown and placeholders, require an explicit
Add action, preserve existing filenames, and return focus when cancelled or completed. Controls
are disabled during writes; installation checks the active vault and pins new files to its root.
The scoped `views/templatesSettings.css` wraps rule controls and preview content in narrow panes.

`views/CalendarLinksSettings.tsx` uses shared setting rows, switches, notices, and reset actions.
`views/PreferenceControls.tsx` provides app preference controls and the app-only section reset.
Week start and link opening keep their app scope; daily file names and generated syntax remain
vault preferences. Vault writes are serialized, disabled when unavailable, and preserve saved
values after failure. The reset confirmation restores focus and leaves vault preferences intact.

`views/WorkspaceSettings.tsx` shares the app preference controls, including native width ranges
with associated outputs. Startup-note choices keep their vault scope, serialized writes, load/save
errors, and a missing-note notice. Picker callbacks check the vault and restore focus after cancel
or save. Workspace reset changes only its five app defaults and preserves the selected vault note.
The former legacy `Personalization.tsx` helpers are removed after their final consumer migrated.

`views/ShortcutsSettings.tsx` uses native tables with labelled shared binding buttons, custom
badges, and live recording/conflict notices. Capture keeps Escape cancellation, Backspace removal,
and conflict reassignment; Tab or leaving the button cancels capture. Unsupported Control chords
are refused. Reset returns focus to the first command when its own button disappears. Legacy
shortcut styles are removed while the picker's keyboard labels retain their existing styling.

`views/AboutSettings.tsx` adopts shared version rows, badges, notices, and outlined update actions.
Release notes retain sanitized inline Markdown and external-link handling; long references and
logs wrap inside narrow panes. `state/updates.ts` retains the shared update state/listeners so
progress survives Settings navigation. Status/check failures are retryable, cancellation restores
focus, and restart actions serialize draft decisions and note saves before installation. Existing
draft confirmation overlays remain for their later migration; native update behavior is unchanged.

`views/ConnectAi.tsx` adopts the shared theme, typography, setup/copy controls, notices, badges,
and setting rows for Connections & safety. The root owns its heading and scroll layout. Folder
rules and chain depth keep saved values until write acknowledgement, serialize related actions,
and require a reload when a successful write cannot be reread. Failed writes retain saved choices.
Folder-picker callbacks check the vault; cancelled/completed selections and CLI installation
restore focus. Copy failures are announced. The existing picker remains for its later migration.

`views/WorkflowList.tsx` adopts `WorkflowCard` for Workflows and the Agent library. Cards show
the real trigger, effective review policy, newest recorded result, and expandable source metadata.
Agent definitions have no dedicated input/output schema: the read scope references folder rules,
and output is explicitly defined by the instructions. The complete result remains in its run log.
The card supports an optional title action and notice; an empty result has no fabricated run state.
Status labels use normal text with colored, distinct icons to preserve readability across accents;
filled button variants and faint text remain outside adoption. Actions serialize, guard the vault,
and restore menu/picker/confirmation focus. Deletion rechecks whether a run started while its
confirmation was open. The sibling recent-runs ledger shares the approved runs table in its own theme scope.
`workflowPresentation.ts` retains the shared status, trigger, and duration helpers.

`views/WorkflowForm.tsx` extracts and migrates the shared create/edit form. Fields, text areas,
switches, notices, folder chips/search, and actions use shared controls. `TextArea` retains the
same label/error/hint associations as `TextField`. Invalid fields receive focus; draft guards
include switch edits, refuse navigation during a pending save, and preserve failed drafts.
Writes retain source hashes and vault roots; subsequent refresh/mirror/navigation phases check
the original vault. Manual-only creation initializes an empty YAML mapping before deleting optional
keys. The save footer flows after the form in narrow panes so it does not cover the fields.

`views/WorkflowDetail.tsx` reuses the same guarded card actions for a selected workflow, opens
the shared editor, and restores Edit focus after cancellation or saving. The context body adopts
17px titles, 13px metadata, status icons, and a guarded source action with inline errors. Missing
workflows offer a route back to the list. Local styles override legacy context label/title rules;
the surrounding workspace/context frame remains for its later migration. Obsolete workflow-card
styles are removed after their final consumer migrated. The run-history page owns its separate theme scope.

`views/RunsHistory.tsx` and `views/RunsLedger.tsx` adopt `RunsTable` for All runs and recent
history. Sorting, workflow filtering, run navigation, review counts, tool warnings, errors, and
empty/loading/error states remain explicit. All eight status values map to the same text/icon
treatments. The table takes an accessible label and only exposes expansion when an inline
selection is controlled. A named container query adapts to pane width, with a narrow-window
fallback for older WebKit. Status text stays neutral and notes wrap instead of clipping errors.
Legacy ledger styles are removed after their final consumer migrated.

`views/RunDetail.tsx` adopts `RunPanel`, status labels, notices, and shared actions. The panel
accepts a heading level, structured metadata, expandable details, a log title, and transcript
DOM props so the app retains its focusable scroll region and follow-at-bottom behavior.
`TranscriptItem` shares sanitized Markdown, tool details, source
links, errors, and proposed-change actions with chat.
Tool activity supports all run states and distinguishes reads from writes. Older saved results,
shortened logs, chain/attempt metadata, changed files, and review outcomes remain available.
Changed-file and transcript-link failures show an inline notice. Legacy run-only styles are removed.

`views/ChatHistory.tsx` scopes All chats and the sidebar's saved rows independently. Shared
buttons, badges, and notices retain date groups, newest-first order, older-history disclosure,
selection, new chat, rename, and deletion. Long titles wrap in both locations. Menu and dialog
cancellation return focus; deleting a row chooses the next available row or New chat. Pending
rename/delete decisions check both the chat store and active vault before applying. The existing
menu/prompt/confirmation overlays remain scheduled separately. The surrounding AI navigation and
chat conversation stay in their own migration steps; unused legacy chat-row CSS is removed.

`views/ChatPanel.tsx` adopts `ChatComposer`, transcript messages, tool details, attachments,
model choice, notices, and outlined send/stop actions. The composer exposes controlled attachment,
footer, annotation, textarea, and action-variant options; its gallery annotation stays out of the
app. Enter/Shift+Enter/composition rules, agent-only sends, typing while running, stop, cost,
saved-note export, slash agents, and selected-text context remain intact. Attachment picker and
rename cancellation restore focus. Saved-note writes serialize and pin their vault root; async
picker/rename/save continuations check the original chat and vault. Connection-check failures
are retryable. `ChatContext.tsx` shares scoped metadata, statuses, source actions, and errors.
The last legacy transcript consumer has migrated, so old chat/transcript CSS and mode are removed.
The surrounding context frame remains scheduled separately.

`views/ActivityPanel.tsx` adopts `ChangeRow`, notices, outlined review/undo controls, and scoped
page headings. The row accepts semantic timestamps, action-specific icons, file buttons, list
semantics, and inline errors. Pending proposals remain oldest first, before newest applied changes;
stale warnings stay explicit. Loading, empty, failed-load/retry, deleted-file, and undo-conflict
states retain their recovery actions. Undo serializes mutations and guards its vault; late loads
and event-listener setup are ignored after unmount. Review/history close restores focus; successful
undo focuses History when its own button becomes disabled. The review dialog renders as
a sibling with its own adopted theme. Unused legacy activity-row styles are removed.

`views/ReviewModal.tsx` adopts the wide `Dialog`, shared diff, selectable hunks, notices,
segmented stale-change comparison, rejection text area, and outlined actions. Failed comparisons
can be retried and cannot be accepted until the file was read; a missing file remains distinct.
Conflicts reread the current file before offering Accept anyway. Accept/reject serialize, disable
fields and dismissal while pending, guard the vault, and retain failed drafts. An accepted change
is not repeated if opening its file fails. Shared DiffView supports labelled views and optional
hunk controls. Native and fallback dialogs are checked for keyboard containment, Escape, background
focus blocking, return focus, themes, and narrow layouts at 130% scale.

`views/HistoryModal.tsx` adopts the compatible wide Dialog, shared diff, notices, and outlined
restore action. The labelled versions list supports Arrow Up/Down and Home/End, preserves selection,
and disables rename-only entries. Missing current files stay distinct from failed reads; history,
current-file, and version failures have retries. Late version responses cannot replace a newer
selection. Restores serialize, keep the current-file hash guard, block dismissal while pending,
and report success; a vault change closes the dialog. The body becomes one column in narrow panes,
while header/actions remain visible. Shared legacy diff CSS remains for ConflictBar until its step;
unused history-specific styles are removed.

`views/Welcome.tsx` adopts the shared scope, outlined actions, notices, saved theme/density/scale,
and a bounded scroll layout. Native picker/naming cancellation restores focus; pending actions
serialize and stay disabled until completion. Inline errors remain visible until retry, including
store-handled open/create failures. The common vault actions accept an optional validity guard so
late choices cannot replace a newly opened vault. Startup failures reach Welcome instead of leaving
a blank loading screen; loading uses the same scoped presentation. Existing naming/picker overlays
stay independent until their migration. Legacy Welcome styles are removed.

`views/WindowChrome.tsx` adopts the shared theme, 13px title and 12.5px version metadata,
while retaining native drag regions and the space reserved for macOS window controls. Long vault
names truncate within the strip. The rest of the shell remains scoped separately for subsequent
navigation passes.

`views/DestinationNavigation.tsx` adopts shared icon buttons and neutral selected surfaces for
the destination rail. Arrow Up/Down and Home/End retain activation and roving focus; mounting Search
does not steal keyboard focus from the rail. Click-to-toggle sidebar behavior and Settings remain.
Attention counts use readable neutral badges and a full screen-reader description. IconButton
preserves an explicit title so app shortcut hints can accompany its accessible label. Unused legacy
rail/badge styles are removed; sidebar and workspace content remain scoped separately.

`views/SidebarHeader.tsx` adopts shared vault/menu controls, disabled loading state, inline errors,
and focus return across menu/picker/prompt cancellation. Recent-vault failures retain open/create
recovery actions; stale responses and actions guard the vault. AreaSidebar adopts shared navigation
buttons and the radio-based AI section switch; ChatList can inherit that scope without nesting a
second theme. The file tree and Find panel bodies retain their own migration boundaries. Scoped
indexing metadata and width caps keep the frame usable in narrow windows. Resizer adopts a scoped
focus ring, keyboard arrows/Home/End/reset, scale-correct dragging, and unmount cleanup, preserving
saved widths and defaults. Legacy navigation/header/resize styles are removed after their consumers
migrate.

**Contrast decision for this pilot:** retain the approved palettes and existing user-selected
accents. The migrated controls use normal/muted text, quiet or outlined buttons, and neutral
selected segments. They introduce no white-on-accent or white-on-danger text. Decisions about
those filled variants remain required before their first application adoption.

**Dialog compatibility strategy:** `Dialog` feature-detects native modal support. Supported
older WebKit receives an open dialog in a fixed backdrop, explicit focus containment, background
ARIA hiding (plus inertness when available), scroll blocking, Escape handling, and focus return.
Prior background state is restored on close. Backdrop clicks do not dismiss either implementation.
The app's remaining confirmations stay on their existing implementation until Step 28.

## Provenance

Colors, spacing, and shapes are copied from `ui/src/styles.css`. Following review, every
interface type size is increased by 1px: body text is now 14px, supporting text 13.5px,
metadata 13px, captions 12.5px, and dialog/panel titles 16/17px. The font stacks and hierarchy
are unchanged. The gallery's own annotations also use larger type.

| Foundation / pattern | Existing source | Candidate representation |
| --- | --- | --- |
| Light/dark palette | `:root`, system dark media query, explicit `[data-theme="dark"]` | `--mds-surface`, `--mds-text`, `--mds-accent`, etc. |
| UI and monospace font stacks | `--font-ui`, `--font-mono` | `--mds-font-ui`, `--mds-font-mono` |
| 13px UI, 12.5px hint, 12px metadata, 11.5px caption, 15/16px headings | Root, `.setting-hint`, `.badge`, `.settings-nav h2`, `.modal h2`, `.settings-head h2` | Named type tokens, increased by 1px in this candidate |
| Spacing 2, 4, 6, 8, 10, 12, 14, 16, 20, 24px | Buttons, menus, settings, inputs, modals | `--mds-space-1` through `--mds-space-10` |
| 5/6/7/8/12px radii | Menu items, buttons, segmented controls, menus, modals | Named radius tokens |
| Quiet, outlined, primary, destructive buttons | `button`, `.secondary`, `.primary`, `.danger` | Five `Button` variants |
| Text fields | `.text-input` | Labelled `TextField`, retaining 7px / 10px padding |
| Switch 36 × 20px, 16px thumb, 150ms motion | `.toggle` | `Switch` |
| Segmented appearance | `.segmented` and its later cascade overrides | `SegmentedControl` |
| Settings rows and hints | `.setting-row`, `.setting-text`, `.setting-hint` | `SettingRow` |
| Metadata and notice surfaces | `.badge`, `.notice`, `.notice.warn`, `.notice.error` | `Badge`, `Notice` |
| Menu and dialog surfaces | `.menu`, `.modal-backdrop`, `.modal`, `--shadow` | `MenuButton`, `Dialog` |
| Iconography | Existing `lucide-react` dependency and 16px interface icons | Searchable catalog with exact canonical import names and 16/20/24px previews |
| Workflow cards | `views/Workflows.tsx`, `.workflow-card`, `.workflow-grid` | `WorkflowCard`, `StatusLabel` |
| Runs ledger and detail | `views/Workflows.tsx`, `.run-ledger-*`, `.run-*` | `RunsTable`, `RunPanel`, eight explicit status labels |
| Completed/review status colors | `.ledger-status.done`, `.ledger-status.review` | Existing light/dark green and amber as `--mds-success`, `--mds-review` |
| Chat and tool activity | `views/ChatPanel.tsx`, `views/Transcript.tsx`, `.chat-*` | `TranscriptMessage`, `ToolActivity`, `ChatComposer` |
| Activity and review queue | `views/ActivityPanel.tsx`, `.activity-*` | `ChangeRow`, review-first example, undo actions |
| Review diff | `views/ReviewModal.tsx`, `.diff`, `.diff-add`, `.diff-del` | `DiffView` with the existing translucent add/remove colors |

The spacing scale names common existing values. Optical values like 5px menu padding and
7px primary-button padding stay as they are. Buttons preserve their variant-specific padding
and native line height instead of forcing every control to a new fixed height.

## Approved foundation rules

Approved during the 2026-10-28 design review, before component migration:

- A named scale for existing spacing values.
- Consistent focus rings and disabled treatment.
- Associated field errors and visible labels.
- Keyboard menus, modal focus, and reduced motion.

## Interaction details

- A 2px accent ring, offset 2px, for keyboard focus on buttons and selection controls.
  Text fields, textareas, and selects instead use an outline offset of -1px, covering the
  normal border with one continuous boundary. They do not combine a blue border with a
  separate outer blue ring. An invalid focused field uses a single danger outline.
- Consistent 50% disabled opacity without suppressing native disabled semantics.
- Associated field labels, hints, and error descriptions.
- Native radio behavior for segmented choices; the group is labelled and arrow keys select.
- A single-level menu with disabled-item skipping, arrows, Home/End, Escape, outside-click
  dismissal, and focus return on selection or Escape. Keyboard opening focuses the first
  action (or the last for Arrow Up). Pointer opening focuses the menu surface until the
  pointer moves over an enabled row. Pointer movement moves DOM focus too; a separate
  hover highlight never leaves two active rows. Nested menus, context positioning,
  collision detection, and typeahead are not included in this candidate.
  The trigger uses a centered 14px Lucide `ChevronDown`, rather than a baseline-aligned text glyph.
- Modal dialogs use native support when available and a focus-managed fallback otherwise. Both
  provide explicit Tab wrapping, Escape, and focus restoration. Pass
  `returnFocusRef` to restore the opener after mouse activation too (Safari does not focus
  buttons on mouse clicks). Without it, the previously focused element is restored. Native `showModal` is
  available in Safari 15.4+; earlier supported WebKit uses the fallback without raising Mosaic's
  macOS minimum. Backdrop clicks do not
  dismiss a dialog; explicit Cancel, the close button, and Escape do. Heading/description,
  body, and footer actions have separate layout regions. `size="wide"` accommodates diffs.
  `initialFocusRef` can focus the main field after the dialog opens, instead of its close button.
  `dismissible={false}` disables close/Escape during a pending decision. Notice roles can be
  explicitly set to alert when an urgent warning needs announcement.
- A tooltip surface derived from existing floating surfaces, displayed on hover/focus,
  associated with its child via `aria-describedby`, and dismissible with Escape. Tooltips
  supplement an existing accessible label. Viewport collision handling is deferred.
- Reduced motion disables the switch transition. No additional animation is introduced.
- `Toolbar` uses a labelled group and regular Tab navigation. It does not claim the ARIA
  toolbar pattern until roving focus is implemented.

## Icon catalog

The catalog reads `icons` from the installed `lucide-react` package, so its names are actual
available imports. Compatibility aliases are omitted. All names can be searched; pagination
renders 72 tiles at a time. Search ignores case, spaces, and hyphens (`calendar-days` finds
`CalendarDays`). Selection shows the name and import statement. “Copy name” copies only
that name, and a text fallback is shown if clipboard access fails. No icon download or CDN
is used. The full icon library is in a separate gallery chunk and is never added to the app.

## Product patterns

The product examples preserve the current compact workflow cards, runs ledger, chat transcript,
and review-first activity layout. They use the larger candidate type scale and shared controls.
All state stays in memory; no workflow runs, model calls, schedules, messages, or vault edits occur.

- **Workflows:** purpose and outcome first; a prominent scheduled/event trigger; named inputs
  and output; a plain-language review policy; and a separate latest-run result. Agent, model,
  direct-update folders, and web settings are available under “Workflow settings.” Primary
  actions stay in the card footer. Reset/finish simulation controls sit outside the cards.
  “Finish preview run” advances the sample without starting an agent.
- **Runs:** eight status specimens, a selectable ledger, run log, expandable tool details,
  failed/skipped examples, pending-review outcome, and an empty state.
  Ready uses Lucide `Circle`; Skipped uses `SkipForward`. Both retain a neutral tone while
  remaining distinguishable by shape, including without color.
- **Chat:** user/assistant messages, tool activity and review indication, attachments, model
  choice, compose/send, working/stop state, and an explicit “Finish preview response” control.
- **Activity & review:** pending rows first; a wide diff dialog; accept, reject with optional
  reason, a stale-proposal confirmation, applied changes, undo, empty queue, and reset.

`patterns.tsx` exposes controlled presentation primitives. `ProductExamples.tsx` is gallery-only
and demonstrates how those primitives compose; it is not an application feature implementation.

## Contrast decisions still to make

The existing white-on-accent and white-on-danger combinations are retained, including dark
mode's lighter accents. These and faint text may fall short of text contrast targets. This
is an inventory for review, not a claim of accessibility compliance. Agree on any palette
adjustments before migration. Essential hints use muted text instead of faint text.

## Candidate API

The gallery and the first application pilot share these primitives. For subsequent migrations:

```tsx
import { Button, SettingRow, Switch, TextField } from "./design-system";

<div className="mosaic-ds" data-theme="light">
  <Button variant="primary" onClick={createNote}>New note</Button>
  <TextField label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
  <SettingRow label="Hidden files" hint="Show dotfiles in the file tree.">
    <Switch label="Hidden files" checked={hidden} onCheckedChange={setHidden} />
  </SettingRow>
</div>
```

`data-theme` supports `light`, `dark`, and `system` (or omission for system). Place the class
on one root; nested independent theme scopes are not supported in this candidate. Settings
row controls need their own accessible label. Button's default type is `button`; use
`type="submit"` explicitly in forms. Switch and segmented choice components are controlled.

## Validation

```sh
pnpm --dir ui lint
pnpm --dir ui design-system:build
pnpm --dir ui e2e design-system.spec.ts --project=chrome --project=webkit
```

The gallery checks exercise keyboard behavior, modal focus, validation, menu dismissal,
theme selection, and responsive overflow using sample data. App checks use the mock vault.

The Appearance pilot additionally runs in both projects via `pnpm --dir ui e2e appearance.spec.ts`.
It checks theme/keyboard behavior, preference persistence, individual and confirmed section resets,
preservation of other preferences, and isolation/overflow at maximum interface scale. Review
screenshots are written to the corresponding Playwright test output folder.

`pnpm --dir ui e2e settings-navigation.spec.ts` checks keyboard search/selection, focus return,
empty results, section headings, tab closing, theme changes, scale/density, and isolation from
remaining section content. WebKit uses Option-Tab to include buttons under Safari's native
keyboard preference. Both test projects save Light/Dark and narrow-pane review screenshots.

`pnpm --dir ui e2e editor-files.spec.ts` checks keyboard switches, saved app preferences,
individual/section reset and cancellation, preservation of the vault HTML policy and unrelated
app preferences, themes, reduced motion, scope isolation, and narrow layouts at 130% scale.
Component tests additionally cover pending/failed vault saves and unavailable preferences.

`pnpm --dir ui e2e vault-folders.spec.ts` checks folder/note picking and focus return, defaults,
attachment visibility, colors, explicit folder creation, cancelled/confirmed reset, preservation
of unrelated data, themes, and narrow layouts including expanded colors. Component checks
cover serialized writes, stale callbacks after vault switches, associated save errors, explicit
creation, reset scope, and refused preference repair.

`views/FileTree.tsx` adopts shared icon buttons for the Files toolbar and scoped tokens for
its custom multi-select tree, file-kind icons, selection, drops, and inline rename input.
Rows use 14px text and 30px height (28px Compact); folder colors and note typography remain
independent. Tree keyboard selection, menus, imports, drag scrolling, and file actions retain
their behavior. The tree and toolbar own sibling theme scopes; Find panels remain separate.

`views/BookmarksPanel.tsx` uses shared list actions, notices, and neutral current-page states.
Each bookmark has a native open button and an accessible action menu; missing targets retain
their removal action. Alt+Arrow Up/Down and menu commands complement drag reordering. Writes
serialize and update the list after acknowledgement; cancelled query prompts restore focus,
failed writes retain saved order, and stale query choices cannot change a different vault.

`views/TagsPanel.tsx` uses shared buttons, count badges, and retry notices. Loading, empty,
and error states stay distinct, and cancelled/stale loads cannot replace a newer vault or
revision. Tag labels wrap in narrow panels; selecting a tag retains the existing Find query.
