/**
 * Builds a prefilled "new issue" link on GitHub for in-app feedback. Nothing is sent from the app:
 * the link opens in the browser, where the person reviews it and submits it with their own account.
 * Only what the person typed, and optionally the app version and OS family, goes into the link —
 * never vault contents or file paths.
 */

export const FEEDBACK_REPOSITORY = "jacquat-jonathan/mosaic";
const NEW_ISSUE = `https://github.com/${FEEDBACK_REPOSITORY}/issues/new`;

/** Browsers and GitHub accept longer links, but some hops (the OS opener, proxies) do not; stay well below 8 KB. */
export const MAX_URL_LENGTH = 6000;
/** GitHub rejects longer issue titles. */
export const MAX_TITLE_LENGTH = 256;

export type FeedbackKind = "bug" | "idea";

export const FEEDBACK_KINDS: Record<FeedbackKind, { label: string; template: string; heading: string }> = {
  bug: { label: "bug", template: "bug_report.md", heading: "What happened" },
  idea: { label: "enhancement", template: "feature_request.md", heading: "Idea" },
};

export type FeedbackEnvironment = { version: string; os: string };

export type Feedback = {
  kind: FeedbackKind;
  title: string;
  message: string;
  environment?: FeedbackEnvironment | null;
};

export const TRUNCATION_NOTE =
  "> This message was too long for a link and was shortened. Paste the rest in a comment below.";
const FOOTER = "<sub>Sent from Mosaic's feedback dialog.</sub>";

/** Cuts on code points so an emoji or other astral character is never split into a lone surrogate. */
function prefix(text: string, codePoints: number): string {
  return Array.from(text).slice(0, codePoints).join("");
}

function body(feedback: Feedback, message: string, truncated: boolean): string {
  const heading = FEEDBACK_KINDS[feedback.kind].heading;
  const parts = [`### ${heading}`, message.trim() || "_No details given._"];
  if (truncated) parts.push(TRUNCATION_NOTE);
  if (feedback.environment) {
    parts.push(
      "### Environment",
      `- Mosaic: ${feedback.environment.version || "unknown"}\n- OS: ${feedback.environment.os || "unknown"}`,
    );
  }
  parts.push(FOOTER);
  return parts.join("\n\n");
}

function url(feedback: Feedback, title: string, text: string): string {
  const kind = FEEDBACK_KINDS[feedback.kind];
  // encodeURIComponent (not URLSearchParams) so spaces become %20 and the link reads the same everywhere.
  const query = [
    ["template", kind.template],
    ["labels", kind.label],
    ["title", title],
    ["body", text],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${NEW_ISSUE}?${query}`;
}

export function buildIssueUrl(feedback: Feedback, maxLength = MAX_URL_LENGTH): { url: string; truncated: boolean } {
  const title = prefix(feedback.title.trim().replace(/\s+/g, " "), MAX_TITLE_LENGTH);
  const full = url(feedback, title, body(feedback, feedback.message, false));
  if (full.length <= maxLength) return { url: full, truncated: false };
  // The largest message prefix that still fits, with the note saying it was shortened.
  const characters = Array.from(feedback.message);
  const fits = (count: number) =>
    url(feedback, title, body(feedback, `${characters.slice(0, count).join("").trimEnd()}…`, true)).length <= maxLength;
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const message = `${characters.slice(0, low).join("").trimEnd()}…`;
  return { url: url(feedback, title, body(feedback, message, true)), truncated: true };
}

/** The OS family only (no version, host or user names); WebKit's user agent version is frozen anyway. */
export function describeOs(nav: Pick<Navigator, "userAgent" | "platform"> | undefined = globalThis.navigator): string {
  const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/Mac/i.test(hint)) return "macOS";
  if (/\bWin/.test(hint)) return "Windows";
  if (/Android/i.test(hint)) return "Android";
  if (/Linux|X11/i.test(hint)) return "Linux";
  return "Unknown";
}
