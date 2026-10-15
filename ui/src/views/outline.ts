export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
  offset: number;
}

/** ATX headings outside fenced code (frontmatter skipped). */
export function parse(text: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((l, n) => n > 0 && /^---\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(l);
    if (h) out.push({ level: h[1].length, text: h[2], line: i + 1, offset: offsets[i] });
  }
  return out;
}

export interface SectionRange {
  heading: OutlineHeading;
  index: number;
  from: number;
  to: number;
}

/** A Markdown section is its ATX heading and everything up to the next heading at the same or a higher level. */
export function sectionRange(text: string, line: number): SectionRange | null {
  const headings = parse(text);
  const index = headings.findIndex((heading) => heading.line === line);
  if (index < 0) return null;
  const heading = headings[index];
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  return { heading, index, from: heading.offset, to: next?.offset ?? text.length };
}

function parentIndex(headings: OutlineHeading[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (headings[i].level < headings[index].level) return i;
  return -1;
}

/** The same-level headings under the same nearest parent. Only these can be reordered together. */
export function siblingLines(text: string, line: number): number[] {
  const headings = parse(text);
  const index = headings.findIndex((heading) => heading.line === line);
  if (index < 0) return [];
  const parent = parentIndex(headings, index);
  const end =
    parent < 0
      ? headings.length
      : headings.findIndex((heading, i) => i > parent && heading.level <= headings[parent].level);
  const limit = end < 0 ? headings.length : end;
  return headings
    .slice(parent + 1, limit)
    .filter((heading) => heading.level === headings[index].level)
    .map((heading) => heading.line);
}

export interface SectionEdit {
  text: string;
  /** New offset of the moved or inserted heading. */
  focus: number;
  /** Optional range to select after the edit. */
  select?: { anchor: number; head: number };
}

interface TextReplacement {
  from: number;
  to: number;
  insert: string;
}

function headingNumber(text: string, heading: OutlineHeading): { from: number; to: number; number: number } | null {
  const end = text.indexOf("\n", heading.offset);
  const source = text.slice(heading.offset, end < 0 ? text.length : end);
  // Accept both list-like titles (`## 2. Shipping`) and bare numeric titles (`## 2`).
  const match = /^(#{1,6})([ \t]+)(\d+)(?:(?=[.)](?:[ \t]|$))|(?=[ \t#]*$))/.exec(source);
  if (!match) return null;
  const from = heading.offset + match[1].length + match[2].length;
  return { from, to: from + match[3].length, number: Number(match[3]) };
}

/**
 * Numbered section headings are a lightweight ordered list (`## 1. First`, `## 2. Second`).
 * After one of them moves, keep every numbered sibling in display order while preserving whether
 * each heading used a dot or a closing parenthesis.
 */
function renumberMovedSection(text: string, focus: number): SectionEdit {
  const headings = parse(text);
  const moved = headings.find((heading) => heading.offset === focus);
  if (!moved || !headingNumber(text, moved)) return { text, focus };
  const lines = siblingLines(text, moved.line);
  const siblings = headings.filter((heading) => lines.includes(heading.line));
  const numbered = siblings.flatMap((heading) => headingNumber(text, heading) ?? []);
  if (numbered.length < 2) return { text, focus };

  const start = Math.min(...numbered.map((item) => item.number));
  const changes: TextReplacement[] = numbered.map((item, index) => ({
    from: item.from,
    to: item.to,
    insert: String(start + index),
  }));
  let adjustedFocus = focus;
  for (const change of changes) {
    if (change.from < focus) adjustedFocus += change.insert.length - (change.to - change.from);
  }
  let result = text;
  for (const change of changes.reverse()) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return { text: result, focus: adjustedFocus };
}

function insertMovedBlock(text: string, at: number, block: string): SectionEdit {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const suffix = after && !block.endsWith("\n\n") ? (block.endsWith("\n") ? "\n" : "\n\n") : "";
  return { text: before + prefix + block + suffix + after, focus: at + prefix.length };
}

/** Moves one section before/after a sibling while retaining its nested subsections and exact source. */
export function moveSectionTo(
  text: string,
  fromLine: number,
  targetLine: number,
  place: "before" | "after",
): SectionEdit | null {
  if (fromLine === targetLine) return null;
  const siblings = siblingLines(text, fromLine);
  if (!siblings.includes(targetLine)) return null;
  const source = sectionRange(text, fromLine);
  const target = sectionRange(text, targetLine);
  if (!source || !target) return null;
  const block = text.slice(source.from, source.to);
  const without = text.slice(0, source.from) + text.slice(source.to);
  let at = place === "before" ? target.from : target.to;
  if (at > source.from) at -= block.length;
  const inserted = insertMovedBlock(without, at, block);
  return renumberMovedSection(inserted.text, inserted.focus);
}

/** Moves a section one place among its siblings. */
export function moveSection(text: string, line: number, direction: -1 | 1): SectionEdit | null {
  const siblings = siblingLines(text, line);
  const index = siblings.indexOf(line);
  const target = siblings[index + direction];
  if (target === undefined) return null;
  return moveSectionTo(text, line, target, direction < 0 ? "before" : "after");
}

/** Adds a same-level section directly after the selected section (including its nested children). */
export function insertSiblingSection(text: string, line: number, title = "New section"): SectionEdit | null {
  const section = sectionRange(text, line);
  if (!section) return null;
  const before = text.slice(0, section.to);
  const after = text.slice(section.to);
  const prefix = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const heading = `${"#".repeat(section.heading.level)} ${title}`;
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  const insertion = `${prefix}${heading}\n\n${suffix}`;
  const focus = section.to + prefix.length;
  const titleFrom = focus + section.heading.level + 1;
  return {
    text: before + insertion + after,
    focus,
    select: { anchor: titleFrom, head: titleFrom + title.length },
  };
}
