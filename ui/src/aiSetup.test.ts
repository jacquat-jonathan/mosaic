import { expect, test } from "vitest";
import { aiSetup, removeCommand } from "./aiSetup";

const REPLACE = "claude mcp remove --scope user mosaic >/dev/null 2>&1; ";

test("Mosaic is user-scoped, replaces an older registration and follows the app without a pinned vault", () => {
  const setup = aiSetup({
    path: "/Applications/Mosaic.app/Contents/MacOS/mosaic",
    link: "/user/.local/bin/mosaic",
    installed: true,
  });
  expect(setup.claudeCode).toBe(
    `${REPLACE}claude mcp add --scope user mosaic -- /Applications/Mosaic.app/Contents/MacOS/mosaic mcp`,
  );
  expect(JSON.parse(setup.desktop ?? "").mcpServers.mosaic).toEqual({
    command: "/Applications/Mosaic.app/Contents/MacOS/mosaic",
    args: ["mcp"],
  });
  expect(setup.claudeCode).not.toContain("--vault");
});

test("without the bundled command there is no setup, never a bare PATH lookup", () => {
  expect(aiSetup(null)).toEqual({ claudeCode: null, desktop: null });
  expect(aiSetup({ path: null, link: "/user/.local/bin/mosaic", installed: false }).claudeCode).toBeNull();
});

test("absolute CLI paths with shell syntax are quoted literally", () => {
  const setup = aiSetup({ path: "/Apps/Jon's $tools/`mosaic`", link: "unused", installed: false });
  expect(setup.claudeCode).toBe(
    `${REPLACE}claude mcp add --scope user mosaic -- '/Apps/Jon'\\''s $tools/\`mosaic\`' mcp`,
  );
});

test("local and project registrations get a removal command run in their folder", () => {
  const entry = { command: "mosaic", args: ["mcp"] };
  expect(removeCommand({ scope: "local", project: "/Users/me/My project", entry, problems: ["shadows-user"] })).toBe(
    "cd '/Users/me/My project' && claude mcp remove --scope local mosaic",
  );
  expect(removeCommand({ scope: "project", project: "/code/app", entry, problems: ["shadows-user"] })).toBe(
    "cd /code/app && claude mcp remove --scope project mosaic",
  );
  expect(removeCommand({ scope: "user", project: null, entry, problems: ["pins-vault"] })).toBeNull();
});
