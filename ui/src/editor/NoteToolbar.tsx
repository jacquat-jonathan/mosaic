// The note's fixed formatting toolbar: block type (Normal text, Heading 1–6), inline marks, link and lists.
// It sits above the editor's scroller, so it stays in place while the note scrolls.

import type { EditorView } from "@codemirror/view";
import type { KeyboardEvent, ReactNode } from "react";
import { addWebLink } from "./selectionToolbar";
import { type ListKind, setBlockType, toggleInline, toggleList, type ToolbarState } from "./formatCommands";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";
const blockKey = (level: number) => (isMac ? `⌘⌥${level}` : `Ctrl+Shift+${level}`);

const BLOCKS = ["Normal text", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"];

function ToolButton(props: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  onRun: () => void;
  className?: string;
  children: ReactNode;
}) {
  const title = props.shortcut ? `${props.label} (${props.shortcut})` : props.label;
  return (
    <button
      type="button"
      className={`mds-button mds-button--quiet note-toolbar-button ${props.className ?? ""}`}
      title={title}
      aria-label={props.label}
      aria-pressed={props.pressed}
      // Keep the editor's selection: the command runs on it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onRun}
    >
      {props.children}
    </button>
  );
}

export function NoteToolbar({ view, state }: { view: EditorView | null; state: ToolbarState }) {
  const act = (command: (view: EditorView) => boolean) => () => {
    if (view) command(view);
  };
  const list = (kind: ListKind) => act(toggleList(kind));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      view?.focus();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    if ((event.target as HTMLElement).tagName === "SELECT") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button, select")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar of buttons, as in the selection toolbar.
    <div className="note-toolbar" role="toolbar" aria-label="Format text" onKeyDown={onKeyDown}>
      <select
        className="mds-input note-toolbar-block"
        aria-label="Text style"
        title={`Text style (${blockKey(0)} … ${blockKey(6)})`}
        value={state.block ?? 0}
        disabled={state.block === null}
        onChange={(event) => {
          if (view) setBlockType(Number(event.target.value))(view);
        }}
      >
        {BLOCKS.map((label, level) => (
          <option key={label} value={level} title={blockKey(level)}>
            {label}
          </option>
        ))}
      </select>
      <span className="note-toolbar-divider" aria-hidden="true" />
      <ToolButton label="Bold" shortcut={`${mod}B`} onRun={act(toggleInline("**"))} className="strong">
        B
      </ToolButton>
      <ToolButton label="Italic" shortcut={`${mod}I`} onRun={act(toggleInline("*"))} className="emphasis">
        I
      </ToolButton>
      <ToolButton label="Strikethrough" shortcut={`${mod}⇧X`} onRun={act(toggleInline("~~"))} className="strike">
        S
      </ToolButton>
      <ToolButton label="Inline code" shortcut={`${mod}E`} onRun={act(toggleInline("`"))} className="code">
        {"</>"}
      </ToolButton>
      <ToolButton label="Link" shortcut={`${mod}K`} onRun={act(addWebLink)}>
        ↗
      </ToolButton>
      <span className="note-toolbar-divider" aria-hidden="true" />
      <ToolButton label="Bullet list" pressed={state.list === "bullet"} onRun={list("bullet")}>
        •≡
      </ToolButton>
      <ToolButton label="Numbered list" pressed={state.list === "ordered"} onRun={list("ordered")}>
        1≡
      </ToolButton>
      <ToolButton label="Checklist" pressed={state.list === "task"} onRun={list("task")}>
        ☑
      </ToolButton>
    </div>
  );
}
