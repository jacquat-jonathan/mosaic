// Panels are Markdown callouts (the Obsidian and GitHub alert syntax), so a note stays plain text:
//
//   > [!warning] Optional title
//   > The body, any Markdown.
//
// The type picks the panel's colour and icon. `custom` and types Mosaic doesn't know get a neutral
// panel showing their title, so a panel can be named without storing colours in the note.

export type CalloutKind = "info" | "note" | "success" | "warning" | "error" | "decision" | "custom";

export interface CalloutStyle {
  icon: string;
  title: string;
}

export const CALLOUT_KINDS: Record<CalloutKind, CalloutStyle> = {
  info: { icon: "i", title: "Info" },
  note: { icon: "✎", title: "Note" },
  success: { icon: "✓", title: "Success" },
  warning: { icon: "!", title: "Warning" },
  error: { icon: "×", title: "Error" },
  decision: { icon: "⇢", title: "Decision" },
  custom: { icon: "◆", title: "Panel" },
};

const ALIASES: Record<string, CalloutKind> = {
  info: "info",
  important: "info",
  abstract: "info",
  summary: "info",
  tldr: "info",
  todo: "info",
  question: "info",
  help: "info",
  faq: "info",
  note: "note",
  quote: "note",
  cite: "note",
  example: "note",
  success: "success",
  tip: "success",
  hint: "success",
  check: "success",
  done: "success",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  error: "error",
  danger: "error",
  failure: "error",
  fail: "error",
  missing: "error",
  bug: "error",
  decision: "decision",
  custom: "custom",
};

export interface CalloutHeader {
  kind: CalloutKind;
  /** The type as written, lower-cased. */
  type: string;
  /** The title written after the marker, or "" (then `defaultTitle` is shown). */
  title: string;
  defaultTitle: string;
  /** Offsets in the line of `[!type]` plus its fold sign and one following space. */
  markerFrom: number;
  markerTo: number;
}

const HEADER = /^([ \t]{0,3}>[ \t]?)\[!([A-Za-z][\w-]*)\]([+-]?)(?:[ \t]+|$)(.*)$/;

/** Reads a callout's first line (quote marks included), or null when the line isn't one. */
export function parseCalloutHeader(line: string): CalloutHeader | null {
  const m = HEADER.exec(line);
  if (!m) return null;
  const type = m[2].toLowerCase();
  const kind = ALIASES[type] ?? "custom";
  const markerFrom = m[1].length;
  const markerTo = line.length - m[4].length;
  const known = ALIASES[type] !== undefined;
  const defaultTitle = known ? CALLOUT_KINDS[kind].title : type.charAt(0).toUpperCase() + type.slice(1);
  return { kind, type, title: m[4].trim(), defaultTitle, markerFrom, markerTo };
}
