import { StrictMode, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, Check, Copy, FileText, Layers, Plus, Search, Settings, X } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  IconButton,
  MenuButton,
  Notice,
  SegmentedControl,
  Select,
  SettingRow,
  Switch,
  TextField,
  Toolbar,
  Tooltip,
  type ButtonProps,
} from "./index";
import "./gallery.css";
import { ActivityExample, ChatExample, RunExamples, WorkflowExamples } from "./ProductExamples";
import { BoardExample, CalendarExample } from "./PlanningExamples";

const loadIconCatalog = () => import("./IconCatalog");
const IconCatalog = lazy(loadIconCatalog);

type Theme = "light" | "dark" | "system";
const themeOptions = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;
const navigation = [
  {
    title: "Foundations",
    links: [
      ["colors", "Color"],
      ["type", "Typography"],
      ["spacing", "Spacing & shape"],
      ["icons", "Lucide icons"],
    ],
  },
  {
    title: "Controls",
    links: [
      ["buttons", "Buttons"],
      ["fields", "Fields & selection"],
    ],
  },
  {
    title: "Patterns",
    links: [
      ["settings", "Settings & toolbars"],
      ["feedback", "Feedback"],
      ["overlays", "Overlays"],
      ["workflows", "Workflows"],
      ["runs", "Runs & logs"],
      ["chat", "Chat"],
      ["activity", "Activity & review"],
      ["board", "Board"],
      ["calendar", "Calendar"],
    ],
  },
  { title: "Review", links: [["decisions", "Sources & decisions"]] },
];
const colorTokens = [
  ["surface", "Main surface"],
  ["surface-subtle", "Sidebar / inset"],
  ["surface-hover", "Hover overlay"],
  ["surface-selected", "Selected overlay"],
  ["text", "Primary text"],
  ["text-muted", "Secondary text"],
  ["text-faint", "Decorative / tertiary"],
  ["border", "Divider / border"],
  ["accent", "Accent"],
  ["danger", "Destructive"],
  ["warning-surface", "Warning surface"],
  ["error-surface", "Error surface"],
  ["success", "Completed"],
  ["review", "Needs review"],
  ["diff-add", "Added lines"],
  ["diff-remove", "Removed lines"],
] as const;
const spacing = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

function Section({
  id,
  number,
  title,
  description,
  children,
}: {
  id: string;
  number: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="ds-section" aria-labelledby={`${id}-heading`}>
      <div className="ds-section-heading">
        <span className="ds-number">{number}</span>
        <div>
          <h2 id={`${id}-heading`}>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Sample({ title, children, caption }: { title: string; children: ReactNode; caption?: string }) {
  return (
    <div className="ds-sample">
      <div className="ds-sample-title">{title}</div>
      <div className="ds-sample-content">{children}</div>
      {caption && <p className="ds-caption">{caption}</p>}
    </div>
  );
}

function Gallery() {
  const initialTheme = new URLSearchParams(window.location.search).get("theme");
  const [theme, setTheme] = useState<Theme>(
    initialTheme === "dark" || initialTheme === "system" ? initialTheme : "light",
  );
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [dialog, setDialog] = useState<"create" | "delete" | null>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const noteTitleInput = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("Untitled note");
  const [message, setMessage] = useState("Try a control. Changes stay in this preview.");
  const [validation, setValidation] = useState(false);

  useEffect(() => {
    if (!window.location.hash) return;
    let cancelled = false;
    let frame = 0;
    // React creates the anchor targets after the initial browser navigation. Wait for
    // the icon section too, so its lazy content cannot shift the requested section.
    void loadIconCatalog().then(() => {
      frame = requestAnimationFrame(() => {
        if (!cancelled) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const read = () => {
      if (!root.current) return;
      const computed = getComputedStyle(root.current);
      const keys = [
        ...colorTokens.map(([key]) => key),
        ...spacing.map((key) => `space-${key}`),
        ...["heading", "dialog-title", "body", "hint", "small", "caption"].map((key) => `text-${key}`),
      ];
      setTokens(Object.fromEntries(keys.map((key) => [key, computed.getPropertyValue(`--mds-${key}`).trim()])));
    };
    read();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => media.removeEventListener("change", read);
  }, [theme]);

  const announce = (text: string) => setMessage(text);
  const openDialog = (kind: "create" | "delete", trigger = document.activeElement) => {
    dialogTrigger.current = trigger instanceof HTMLElement ? trigger : null;
    setValidation(false);
    setDialog(kind);
  };
  const confirmDialog = () => {
    if (dialog === "create" && !name.trim()) {
      setValidation(true);
      return;
    }
    announce(dialog === "delete" ? "Preview note removed." : `Created “${name.trim()}” in the preview.`);
    setDialog(null);
  };

  return (
    <div ref={root} className="mosaic-ds ds-gallery" data-theme={theme}>
      <a href="#gallery-content" className="ds-skip-link">
        Skip to content
      </a>
      <aside className="ds-sidebar">
        <a className="ds-brand" href="#overview">
          <span className="ds-brand-mark">
            <Layers size={18} />
          </span>
          <span>
            Mosaic<small>Design system</small>
          </span>
        </a>
        <div className="ds-sidebar-status">
          <span className="ds-status-dot" />
          Approved · v0.3
        </div>
        <nav aria-label="Design system sections">
          {navigation.map((group) => (
            <div className="ds-nav-group" key={group.title}>
              <h2>{group.title}</h2>
              {group.links.map(([id, label]) => (
                <a href={`#${id}`} key={id}>
                  {label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="ds-sidebar-footer">
          Extracted from Mosaic
          <br />
          <span>Shared foundations · Product patterns</span>
        </div>
      </aside>

      <div className="ds-page">
        <header className="ds-topbar">
          <span>
            Interface foundations <span className="ds-topbar-divider">/</span> Component gallery
          </span>
          <SegmentedControl<Theme> label="Preview theme" value={theme} options={themeOptions} onChange={setTheme} />
          <label className="ds-mobile-jump">
            Jump to{" "}
            <select
              className="mds-input"
              aria-label="Jump to section"
              value=""
              onChange={(event) => {
                window.location.hash = event.target.value;
              }}
            >
              <option value="">Section…</option>
              {navigation
                .flatMap((group) => group.links)
                .map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        </header>
        <main id="gallery-content">
          <section id="overview" className="ds-intro">
            <div className="ds-eyebrow">MOSAIC / DESIGN SYSTEM</div>
            <h1>
              A shared language for
              <br />
              the interface we have.
            </h1>
            <p>
              Existing colors, familiar controls, and compact proportions. Collected in one place to review before they
              become shared building blocks.
            </p>
            <div className="ds-intro-meta">
              <Badge>Approved design</Badge>
              <span>System fonts</span>
              <span>Light & dark</span>
              <span>Local preview</span>
            </div>
          </section>

          <Section
            id="colors"
            number="01"
            title="Color"
            description="The existing palette, named by purpose. Switch themes to inspect the same roles in both appearances."
          >
            <div className="ds-colors">
              {colorTokens.map(([key, label]) => (
                <div className="ds-color" key={key}>
                  <div className="ds-color-preview">
                    <div style={{ background: `var(--mds-${key})` }} />
                  </div>
                  <strong>{label}</strong>
                  <code>--mds-{key}</code>
                  <span>{tokens[key]}</span>
                </div>
              ))}
            </div>
            <p className="ds-footnote">
              Overlay swatches sit on the main surface. Faint text is retained for comparison; avoid it for essential
              instructions.
            </p>
          </Section>

          <Section
            id="type"
            number="02"
            title="Typography"
            description="The existing system font stack, with each interface size increased by 1px for easier reading."
          >
            <div className="ds-type-table">
              {[
                ["heading", "600", "Panel title", "Appearance"],
                ["dialog-title", "600", "Dialog title", "Create a new note"],
                ["body", "400", "Interface text", "A place for your notes, plans, and ideas."],
                ["hint", "400", "Supporting text", "Use the system appearance or choose your own."],
                ["small", "400", "Metadata", "Edited just now · Daily notes"],
                ["caption", "400", "Section label", "WORKSPACE"],
              ].map(([token, weight, role, text]) => (
                <div className="ds-type-row" key={token}>
                  <div>
                    <strong>{role}</strong>
                    <code>
                      {tokens[`text-${token}`]} / {weight}
                    </code>
                  </div>
                  <span
                    style={{
                      fontSize: `var(--mds-text-${token})`,
                      fontWeight: Number(weight),
                    }}
                  >
                    {text}
                  </span>
                </div>
              ))}
            </div>
            <div className="ds-mono">
              <code>Notes/Projects/Design system.md</code>
              <span>SF Mono → system monospace fallback · Paths and source</span>
            </div>
          </Section>

          <Section
            id="spacing"
            number="03"
            title="Spacing & shape"
            description="A named scale drawn from current paddings and gaps. Existing controls keep their individual proportions."
          >
            <div className="ds-two-up">
              <Sample title="Spacing scale">
                <div className="ds-spacing">
                  {spacing.map((key) => (
                    <div key={key}>
                      <code>{tokens[`space-${key}`]}</code>
                      <span style={{ width: `var(--mds-space-${key})` }} />
                      <small>space-{key}</small>
                    </div>
                  ))}
                </div>
              </Sample>
              <Sample title="Corner radii">
                <div className="ds-radii">
                  {[
                    ["item", "5px", "Menu item"],
                    ["control", "6px", "Control"],
                    ["group", "7px", "Segmented"],
                    ["menu", "8px", "Menu"],
                    ["dialog", "12px", "Dialog"],
                  ].map(([token, value, label]) => (
                    <div key={token}>
                      <span style={{ borderRadius: `var(--mds-radius-${token})` }}>{value}</span>
                      <small>{label}</small>
                    </div>
                  ))}
                </div>
                <div className="ds-elevation">
                  Floating surface<small>Existing menu & dialog shadow</small>
                </div>
              </Sample>
            </div>
          </Section>

          <Section
            id="icons"
            number="04"
            title="Lucide icons"
            description="Browse every icon available in Mosaic's installed library. Choose one and use its exact name when describing a change."
          >
            <Suspense fallback={<p className="mds-hint">Loading icon catalog…</p>}>
              <IconCatalog onAnnounce={announce} />
            </Suspense>
          </Section>

          <Section
            id="buttons"
            number="05"
            title="Buttons"
            description="Five existing action treatments. State samples below are fixed for comparison; the controls remain interactive."
          >
            <div className="ds-state-scroll">
              <table className="ds-state-table">
                <thead>
                  <tr>
                    <th scope="col">Variant</th>
                    {["Default", "Hover", "Pressed", "Focus", "Disabled"].map((state) => (
                      <th scope="col" key={state}>
                        {state}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["quiet", "Quiet"],
                      ["secondary", "Secondary"],
                      ["primary", "Primary"],
                      ["danger", "Destructive"],
                      ["danger-primary", "Confirm delete"],
                    ] as const
                  ).map(([variant, label]) => (
                    <tr key={variant}>
                      <th scope="row">
                        <strong>{label}</strong>
                        <code>{variant}</code>
                      </th>
                      {["default", "hover", "pressed", "focus", "disabled"].map((state) => (
                        <td key={state} data-preview-state={state}>
                          <Button
                            variant={variant as ButtonProps["variant"]}
                            disabled={state === "disabled"}
                            onClick={() => announce(`${label} button activated.`)}
                          >
                            {variant.includes("danger") ? "Delete" : "Button"}
                          </Button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ds-two-up ds-gap-top">
              <Sample title="With icons">
                <Toolbar label="Example actions">
                  <Button variant="primary" onClick={() => announce("New note action previewed.")}>
                    <Plus />
                    New note
                  </Button>
                  <Button variant="secondary" onClick={() => announce("Copy action previewed.")}>
                    <Copy />
                    Copy link
                  </Button>
                </Toolbar>
              </Sample>
              <Sample title="Icon buttons" caption="16px Lucide icons, accessible labels, and quiet surfaces.">
                <Toolbar label="Icon examples">
                  <IconButton label="Search notes" onClick={() => announce("Search action previewed.")}>
                    <Search />
                  </IconButton>
                  <IconButton label="Open settings" onClick={() => announce("Settings action previewed.")}>
                    <Settings />
                  </IconButton>
                  <IconButton label="Close preview" disabled>
                    <X />
                  </IconButton>
                </Toolbar>
              </Sample>
            </div>
          </Section>

          <Section
            id="fields"
            number="06"
            title="Fields & selection"
            description="Visible labels and associated descriptions, with native input and radio behavior."
          >
            <div className="ds-two-up">
              <Sample title="Text fields">
                <div className="ds-stack">
                  <TextField
                    label="Note title"
                    placeholder="Untitled note"
                    hint="The filename will follow this title."
                  />
                  <TextField label="Invalid title" defaultValue="Project/Notes" error="Use a title without a slash." />
                  <TextField label="Read-only location" defaultValue="Notes/Archive" disabled />
                </div>
              </Sample>
              <Sample title="Choice controls">
                <div className="ds-stack">
                  <Select label="Default folder" defaultValue="daily">
                    <option value="daily">Daily notes</option>
                    <option value="projects">Projects</option>
                    <option value="root">Vault root</option>
                  </Select>
                  <div>
                    <div className="ds-control-label">Appearance</div>
                    <SegmentedControl<Theme>
                      label="Example appearance"
                      value={theme}
                      options={themeOptions}
                      onChange={setTheme}
                    />
                  </div>
                  <div className="ds-switch-row">
                    <span>Show hidden files</span>
                    <Switch label="Show hidden files" checked={showHidden} onCheckedChange={setShowHidden} />
                  </div>
                  <div className="ds-switch-row">
                    <span className="mds-hint">Unavailable setting</span>
                    <Switch label="Unavailable setting" checked disabled onCheckedChange={() => {}} />
                  </div>
                </div>
              </Sample>
            </div>
          </Section>

          <Section
            id="settings"
            number="07"
            title="Settings & toolbars"
            description="Compositions of the same controls. These are preview examples, with no connection to app settings."
          >
            <div className="ds-settings-example">
              <div className="ds-pattern-header">
                <Settings size={16} />
                <strong>Appearance</strong>
                <Badge>Preview</Badge>
              </div>
              <SettingRow label="Theme" hint="Use a light, dark, or system appearance.">
                <SegmentedControl<Theme>
                  label="Settings theme"
                  value={theme}
                  options={themeOptions}
                  onChange={setTheme}
                />
              </SettingRow>
              <SettingRow label="Hidden files" hint="Show dotfiles in the file tree.">
                <Switch label="Settings hidden files" checked={showHidden} onCheckedChange={setShowHidden} />
              </SettingRow>
              <SettingRow label="Daily note folder" hint="Where new daily notes will be created.">
                <Button variant="secondary" onClick={() => announce("Folder picker previewed.")}>
                  Choose folder
                  <ArrowUpRight size={14} />
                </Button>
              </SettingRow>
            </div>
            <div className="ds-document-toolbar">
              <div>
                <FileText size={16} />
                <span>Design system.md</span>
              </div>
              <Toolbar label="Document actions">
                <Badge>Markdown</Badge>
                <IconButton label="Copy document link" onClick={() => announce("Document link copied in the preview.")}>
                  <Copy />
                </IconButton>
                <Button
                  variant="secondary"
                  onClick={(event) => {
                    openDialog("create", event.currentTarget);
                  }}
                >
                  <Plus />
                  New note
                </Button>
              </Toolbar>
            </div>
          </Section>

          <Section
            id="feedback"
            number="08"
            title="Feedback"
            description="Neutral metadata and existing warning/error surfaces. Messages use text as well as color."
          >
            <div className="ds-feedback">
              <Notice>Preview changes are kept in memory.</Notice>
              <Notice tone="warning">Warning · Some files could not be indexed. You can retry.</Notice>
              <Notice tone="error">Error · This note could not be saved. Your changes are still here.</Notice>
            </div>
            <div className="ds-badges">
              <Badge>Markdown</Badge>
              <Badge>12 notes</Badge>
              <Badge>App-wide</Badge>
              <span className="mds-hint">Neutral badges describe metadata.</span>
            </div>
          </Section>

          <Section
            id="overlays"
            number="09"
            title="Overlays"
            description="Three distinct surfaces, each with room for its content. Dialogs separate the heading, form, and actions; menus and tooltips stay anchored to their trigger."
          >
            <div className="ds-overlays-grid">
              <article className="ds-overlay-card">
                <header>
                  <h3>Dialogs</h3>
                  <p>Use a modal for a focused decision or a short form.</p>
                </header>
                <div className="ds-overlay-stage ds-overlay-stage--dialog" aria-hidden="true">
                  <div className="ds-mini-dialog">
                    <strong>Create a new note</strong>
                    <p>Give your note a title.</p>
                    <span>Title</span>
                    <div className="ds-mini-input">Untitled note</div>
                    <div className="ds-mini-footer">
                      <span>Cancel</span>
                      <span>Create note</span>
                    </div>
                  </div>
                </div>
                <div className="ds-overlay-description">
                  <Toolbar label="Dialog examples">
                    <Button
                      variant="secondary"
                      onClick={(event) => {
                        openDialog("create", event.currentTarget);
                      }}
                    >
                      Open dialog
                    </Button>
                    <Button variant="danger" onClick={(event) => openDialog("delete", event.currentTarget)}>
                      Delete note…
                    </Button>
                  </Toolbar>
                  <p>Focus remains inside. Escape or Cancel closes the dialog and returns focus to its opener.</p>
                </div>
              </article>
              <article className="ds-overlay-card">
                <header>
                  <h3>Action menus</h3>
                  <p>Place related actions beside the object they affect.</p>
                </header>
                <div className="ds-overlay-stage ds-overlay-stage--menu">
                  <div className="ds-note-context">
                    <div>
                      <FileText size={16} />
                      <span>Design system.md</span>
                    </div>
                    <MenuButton
                      label="Note actions"
                      items={[
                        {
                          id: "open",
                          label: "Open note",
                          shortcut: "↵",
                          onSelect: () => announce("Open note selected."),
                        },
                        {
                          id: "copy",
                          label: "Copy link",
                          shortcut: "⌘⇧C",
                          onSelect: () => announce("Copy link selected."),
                        },
                        { id: "move", label: "Move to…", disabled: true, onSelect: () => {} },
                        {
                          id: "delete",
                          label: "Delete note…",
                          danger: true,
                          separatorBefore: true,
                          onSelect: () => openDialog("delete"),
                        },
                      ]}
                    />
                  </div>
                </div>
                <div className="ds-overlay-description">
                  <strong>One active row</strong>
                  <p>
                    Pointer movement and arrow keys move the same highlight. Home / End jump to the first / last action.
                    Escape closes.
                  </p>
                </div>
              </article>
              <article className="ds-overlay-card">
                <header>
                  <h3>Tooltips</h3>
                  <p>Supplement a clear label with a short explanation.</p>
                </header>
                <div className="ds-overlay-stage ds-overlay-stage--tooltip">
                  <Tooltip label="Create a note in the current folder">
                    <Button variant="secondary" onClick={() => announce("Tooltip action previewed.")}>
                      <Plus />
                      New note
                    </Button>
                  </Tooltip>
                </div>
                <div className="ds-overlay-description">
                  <strong>Hover or focus the action</strong>
                  <p>
                    The hint sits below its trigger. Escape dismisses it. Essential instructions stay visible in the
                    interface.
                  </p>
                </div>
              </article>
            </div>
          </Section>

          <Section
            id="workflows"
            number="10"
            title="Workflows"
            description="What runs, when it runs, what it produces, and what needs your attention. Agent and model settings stay available in the expandable details."
          >
            <WorkflowExamples onAnnounce={announce} />
          </Section>
          <Section
            id="runs"
            number="11"
            title="Runs & logs"
            description="The current ledger layout, with aligned metadata, explicit run states, expandable tool activity, and a clear outcome."
          >
            <RunExamples />
          </Section>
          <Section
            id="chat"
            number="12"
            title="Chat"
            description="User messages, assistant answers, tool activity, review links, attachment chips, and a composer. Send a sample message to inspect the working and stopped states."
          >
            <ChatExample onAnnounce={announce} />
          </Section>
          <Section
            id="activity"
            number="13"
            title="Activity & review"
            description="Pending proposals come first, followed by the ledger of applied changes. Try a diff, acceptance, rejection with a reason, a stale proposal, and undo."
          >
            <ActivityExample onAnnounce={announce} />
          </Section>

          <Section
            id="board"
            number="14"
            title="Board"
            description="Task cards, status columns, epic headers and planning actions. Explore selection, filtering, reordering, compact density and empty/drop states."
          >
            <BoardExample onAnnounce={announce} />
          </Section>
          <Section
            id="calendar"
            number="15"
            title="Calendar"
            description="Calendar layers, day cells, event and work-session chips, session actions and open tasks. Review month, week and day compositions using local sample data."
          >
            <CalendarExample onAnnounce={announce} />
          </Section>

          <Section
            id="decisions"
            number="16"
            title="Sources & decisions"
            description="The foundations, typography, and product patterns are approved. Adopting them in the application remains a separate step."
          >
            <div className="ds-two-up">
              <Sample title="Preserved from the app">
                <ul className="ds-decisions-list">
                  <li>
                    <Check />
                    Both palettes, accent and status colors
                  </li>
                  <li>
                    <Check />
                    System fonts and the existing type hierarchy
                  </li>
                  <li>
                    <Check />
                    Button treatments, switch dimensions, and radii
                  </li>
                  <li>
                    <Check />
                    Menu and dialog surfaces, shadows, and spacing
                  </li>
                </ul>
              </Sample>
              <Sample title="Approved foundation rules">
                <ul className="ds-decisions-list">
                  <li>
                    <Check />A named scale for existing spacing values
                  </li>
                  <li>
                    <Check />
                    Consistent focus rings and disabled treatment
                  </li>
                  <li>
                    <Check />
                    Associated field errors and visible labels
                  </li>
                  <li>
                    <Check />
                    Keyboard menus, modal focus, reduced motion
                  </li>
                </ul>
              </Sample>
            </div>
            <div className="ds-review-note">
              <strong>Before migration</strong>
              <p>
                Review the palette in both themes, control density, corner radii, and interaction states. The existing
                white-on-accent pairing and faint text are preserved for review; contrast needs a decision before
                adoption.
              </p>
              <p>
                Source: <code>ui/src/styles.css</code> · <code>ui/src/views/Overlays.tsx</code> ·{" "}
                <code>ui/src/theme.ts</code>. Scope and API notes live in <code>ui/src/design-system/README.md</code>.
              </p>
            </div>
          </Section>
          <footer className="ds-footer">
            <Layers size={14} />
            <span>Mosaic design system · Shared foundations · Board & Calendar patterns available for review</span>
          </footer>
        </main>
        <div className="ds-preview-status" role="status">
          <span className="ds-status-dot" />
          {message}
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        title={dialog === "delete" ? "Delete this note?" : "Create a new note"}
        description={
          dialog === "delete"
            ? "This demonstrates a destructive confirmation. It only affects the preview."
            : "Give your note a title. This example does not write a file."
        }
        onClose={() => setDialog(null)}
        returnFocusRef={dialogTrigger}
        initialFocusRef={noteTitleInput}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant={dialog === "delete" ? "danger-primary" : "primary"} onClick={confirmDialog}>
              {dialog === "delete" ? "Delete note" : "Create note"}
            </Button>
          </>
        }
      >
        {dialog === "create" && (
          <TextField
            ref={noteTitleInput}
            label="New note title"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setValidation(false);
            }}
            error={validation ? "Enter a title for your note." : undefined}
          />
        )}
      </Dialog>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
