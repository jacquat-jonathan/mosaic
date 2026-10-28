# Mosaic design system · approved design

A standalone inventory of Mosaic's existing interface and a candidate component API (v0.3).
The visual design and gallery were approved on 2026-10-28 after review of typography,
icons, focus behavior, overlays, workflows, runs, chat, and Activity & review.
**Settings → Appearance** was visually accepted on 2026-10-28. Navigation and header are
committed, and continuation to **Editor & files** was authorized. That section is the current
migration; remaining Settings sections keep their existing controls.

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

**Contrast decision for this pilot:** retain the approved palettes and existing user-selected
accents. The migrated controls use normal/muted text, quiet or outlined buttons, and neutral
selected segments. They introduce no white-on-accent or white-on-danger text. Decisions about
those filled variants remain required before their first application adoption.

**Dialog compatibility strategy:** retain the existing app confirmation for the pilot's section
reset, including cancellation and return to its opener. Before adopting `Dialog` in the app,
feature-detect `showModal` and provide a focus-managed fallback for supported older WebKit
versions. Do not raise the macOS minimum as a side effect of the visual migration. The native
gallery dialog is not imported by this pilot.

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
- Native modal dialogs with explicit Tab wrapping, Escape, and focus restoration. Pass
  `returnFocusRef` to restore the opener after mouse activation too (Safari does not focus
  buttons on mouse clicks). Without it, the previously focused element is restored. These require
  Safari 15.4+; Mosaic's macOS 12 minimum can include earlier WebKit versions. Resolve the
  compatibility strategy before adopting this component in the app. Backdrop clicks do not
  dismiss a dialog; explicit Cancel, the close button, and Escape do. Heading/description,
  body, and footer actions have separate layout regions. `size="wide"` accommodates diffs.
  `initialFocusRef` can focus the main field after the dialog opens, instead of its close button.
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
