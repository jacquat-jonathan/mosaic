export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

/** ATX headings outside fenced code (frontmatter skipped). */
export function parse(text: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const lines = text.split("\n");
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
    if (h) out.push({ level: h[1].length, text: h[2], line: i + 1 });
  }
  return out;
}
