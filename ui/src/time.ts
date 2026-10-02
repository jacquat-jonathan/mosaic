/** "just now", "5 min ago", "3 h ago", "yesterday 14:03", or a date. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h ago`;
  if (dayLabel(ms, now) === "Today") return `today ${time}`;
  if (dayLabel(ms, now) === "Yesterday") return `yesterday ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

/** "Today", "Yesterday" or the date, for grouping a list by day. */
export function dayLabel(ms: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(ms) === day(now)) return "Today";
  if (day(ms) === day(now - 86_400_000)) return "Yesterday";
  return new Date(ms).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
