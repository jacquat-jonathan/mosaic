// Daily notes: one note per day in a folder (Settings › Editor & files), created from an optional
// template the first time it's opened.

/** Local date as YYYY-MM-DD (the daily note's name). */
export function dayStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Fills {{date}}, {{title}}, {{weekday}} and {{time}} in a template. */
export function fillTemplate(template: string, d = new Date()): string {
  const values: Record<string, string> = {
    date: dayStamp(d),
    title: dayStamp(d),
    weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
  return template.replace(/\{\{\s*(date|title|weekday|time)\s*\}\}/g, (_m, k: string) => values[k]);
}

/** The vault path of a day's note. */
export function dailyPath(folder: string, d = new Date()): string {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return f ? `${f}/${dayStamp(d)}.md` : `${dayStamp(d)}.md`;
}
