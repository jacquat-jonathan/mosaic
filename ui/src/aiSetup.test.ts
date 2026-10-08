import { expect, test } from "vitest";
import { aiSetup } from "./aiSetup";

test("Mosaic is user-scoped and follows the app without a pinned vault", () => {
  const setup = aiSetup({ path: "/Applications/Mosaic.app/Contents/MacOS/mosaic", link: "/user/.local/bin/mosaic", installed: true });
  expect(setup.claudeCode).toBe("claude mcp add --scope user mosaic -- /Applications/Mosaic.app/Contents/MacOS/mosaic mcp");
  expect(JSON.parse(setup.desktop).mcpServers.mosaic).toEqual({ command: "/Applications/Mosaic.app/Contents/MacOS/mosaic", args: ["mcp"] });
  expect(setup.claudeCode).not.toContain("--vault");
  expect(aiSetup(null).claudeCode).toBe("claude mcp add --scope user mosaic -- mosaic mcp");
});

test("absolute CLI paths with shell syntax are quoted literally", () => {
  const setup = aiSetup({ path: "/Apps/Jon's $tools/`mosaic`", link: "unused", installed: false });
  expect(setup.claudeCode).toBe("claude mcp add --scope user mosaic -- '/Apps/Jon'\\''s $tools/`mosaic`' mcp");
});
