/** Store image widths in the note so they survive reopening and travel with the file. */
export function imageWithWidth(source: string, width: number | null): string {
  const suffix = width === null ? "" : `|${Math.max(48, Math.round(width))}`;
  if (source.startsWith("![[") && source.endsWith("]]")) {
    const inner = source.slice(3, -2).replace(/\|\d+(?:x\d+)?\s*$/, "");
    return `![[${inner}${suffix}]]`;
  }
  return source.replace(
    /^!\[((?:\\.|[^\]\\])*)\]/,
    (_match, alt: string) => `![${alt.replace(/\|\d+(?:x\d+)?\s*$/, "")}${suffix}]`,
  );
}
