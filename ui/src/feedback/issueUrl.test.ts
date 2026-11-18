import { describe, expect, test } from "vitest";
import { buildIssueUrl, describeOs, MAX_TITLE_LENGTH, MAX_URL_LENGTH, TRUNCATION_NOTE } from "./issueUrl";

const params = (url: string) => new URL(url).searchParams;
const env = { version: "v0.29.0", os: "macOS" };

describe("buildIssueUrl", () => {
  test("targets the repository's new-issue page with the bug template and label", () => {
    const { url, truncated } = buildIssueUrl({ kind: "bug", title: "Crash", message: "It crashed", environment: env });
    expect(url.startsWith("https://github.com/jacquat-jonathan/mosaic/issues/new?")).toBe(true);
    expect(truncated).toBe(false);
    const query = params(url);
    expect(query.get("template")).toBe("bug_report.md");
    expect(query.get("labels")).toBe("bug");
    expect(query.get("title")).toBe("Crash");
    expect(query.get("body")).toContain("### What happened\n\nIt crashed");
    expect(query.get("body")).toContain("### Environment\n\n- Mosaic: v0.29.0\n- OS: macOS");
  });

  test("ideas use the feature template and enhancement label", () => {
    const query = params(buildIssueUrl({ kind: "idea", title: "Tags", message: "Please" }).url);
    expect(query.get("template")).toBe("feature_request.md");
    expect(query.get("labels")).toBe("enhancement");
    expect(query.get("body")).toContain("### Idea\n\nPlease");
  });

  test("leaves out the environment when not asked to include it", () => {
    const body = params(buildIssueUrl({ kind: "bug", title: "x", message: "y", environment: null }).url).get("body");
    expect(body).not.toContain("Environment");
    expect(body).not.toContain("Mosaic: ");
  });

  test("encodes reserved characters, newlines, unicode and emoji so they round-trip", () => {
    const title = "a & b # c ? d = e + f / g % h";
    const message = "line 1\nline 2\r\n\tété 日本語 🧩 <b>&amp;</b>";
    const { url } = buildIssueUrl({ kind: "bug", title, message });
    expect(url).not.toMatch(/[ \n#]/);
    expect(url).toContain("%20");
    expect(url.split("?")[1].split("&")).toHaveLength(4);
    const query = params(url);
    expect(query.get("title")).toBe(title);
    expect(query.get("body")).toContain(message.trim());
  });

  test("collapses whitespace in the title and caps it at GitHub's limit without splitting emoji", () => {
    const query = params(buildIssueUrl({ kind: "bug", title: `  ${"🧩".repeat(300)}\n x `, message: "" }).url);
    const title = query.get("title") ?? "";
    expect(Array.from(title)).toHaveLength(MAX_TITLE_LENGTH);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(params(buildIssueUrl({ kind: "bug", title: "  a \n  b ", message: "" }).url).get("title")).toBe("a b");
  });

  test("short input is not truncated", () => {
    const { url, truncated } = buildIssueUrl({ kind: "bug", title: "t", message: "x".repeat(1000), environment: env });
    expect(truncated).toBe(false);
    expect(params(url).get("body")).not.toContain(TRUNCATION_NOTE);
  });

  test.each([
    ["ascii", "word ".repeat(5000)],
    ["multi-byte", "日本語のテキスト".repeat(2000)],
    ["emoji", "🧩".repeat(5000)],
  ])("long %s messages are shortened to fit, with a note and the environment kept", (_name, message) => {
    const { url, truncated } = buildIssueUrl({ kind: "bug", title: "Long", message, environment: env });
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    // Close to the limit: the cut is not wastefully short.
    expect(url.length).toBeGreaterThan(MAX_URL_LENGTH - 40);
    const body = params(url).get("body") ?? "";
    expect(body).toContain("…");
    expect(body).toContain(TRUNCATION_NOTE);
    expect(body).toContain("- Mosaic: v0.29.0");
    expect(body).toContain("Sent from Mosaic's feedback dialog.");
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(message.startsWith(body.split("\n\n")[1].replace(/…$/, ""))).toBe(true);
  });

  test("honours a custom limit", () => {
    const { url, truncated } = buildIssueUrl({ kind: "idea", title: "t", message: "x".repeat(2000) }, 1000);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(1000);
  });
});

test("describeOs reports only the OS family", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  expect(describeOs({ platform: "MacIntel", userAgent: mac })).toBe("macOS");
  expect(describeOs({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("Windows");
  expect(describeOs({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("Linux");
  expect(describeOs({ platform: "", userAgent: "" })).toBe("Unknown");
});
