// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { AgentRule, AiSetupStatus } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { ConnectAiSection } from "./ConnectAi";

let stored: AgentRule[];
const DESKTOP_PATH = "/Users/me/Library/Application Support/Claude/claude_desktop_config.json";
let setupStatus: AiSetupStatus;
beforeEach(() => {
  setupStatus = { desktop: { path: DESKTOP_PATH, state: { state: "not-configured" } }, claude_code: [] };
  vi.spyOn(api, "aiSetupStatus").mockImplementation(async () => setupStatus);
  stored = [{ path: "Projects", access: "review" }];
  useVault.setState({
    vault: { root: "/vault", name: "Vault", history_warning: null },
    entries: [
      { path: "Projects", name: "Projects", is_dir: true, kind: null, size: 0, mtime: 0 },
      { path: "Private", name: "Private", is_dir: true, kind: null, size: 0, mtime: 0 },
    ],
  });
  useUi.setState({ picker: null });
  vi.spyOn(api, "cliInfo").mockResolvedValue({
    path: "/Applications/Mosaic.app/mosaic",
    link: "~/.local/bin/mosaic",
    installed: true,
  });
  vi.spyOn(api, "agentRules").mockImplementation(async () => stored);
  vi.spyOn(api, "setAgentRules").mockImplementation(async (next) => {
    stored = next;
    return null;
  });
  vi.spyOn(api, "tesseraStatus").mockResolvedValue({ paused: false, max_chain_depth: 2, agents: [], runs: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("failed rule saves keep the saved access and disable concurrent actions", async () => {
  const user = userEvent.setup();
  let fail!: (reason: Error) => void;
  vi.mocked(api.setAgentRules).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  render(<ConnectAiSection />);
  const access = await screen.findByLabelText("Access for Projects");
  await user.selectOptions(access, "hidden");
  expect(access).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Add a folder…" })).toHaveProperty("disabled", true);
  await act(async () => fail(new Error("Rule save refused")));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Rule save refused");
  expect(access).toHaveProperty("value", "review");
  expect(access).toHaveProperty("disabled", false);
  expect(document.activeElement).toBe(access);
});

test("a successful write followed by a failed refresh keeps the acknowledged rule and requires reload", async () => {
  const user = userEvent.setup();
  render(<ConnectAiSection />);
  const access = await screen.findByLabelText("Access for Projects");
  vi.mocked(api.agentRules).mockRejectedValueOnce(new Error("Refresh unavailable"));
  await user.selectOptions(access, "read-only");
  await screen.findByRole("button", { name: "Retry folder rules" });
  expect(access).toHaveProperty("value", "read-only");
  expect(access).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Retry folder rules" }));
  await waitFor(() => expect(access).toHaveProperty("disabled", false));
});

test("stale folder-picker callbacks do not change rules in another vault", async () => {
  const user = userEvent.setup();
  render(<ConnectAiSection />);
  await screen.findByLabelText("Access for Projects");
  await user.click(screen.getByRole("button", { name: "Add a folder…" }));
  const picker = useUi.getState().picker!;
  act(() => useVault.setState({ vault: { root: "/other", name: "Other", history_warning: null } }));
  act(() => picker.onPick({ id: "Private", label: "Private" }));
  expect(api.setAgentRules).not.toHaveBeenCalled();
});

test("chain-depth save failures preserve the saved depth and allow retry", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(api, "tesseraSetMaxChainDepth").mockRejectedValue(new Error("Depth save refused"));
  render(<ConnectAiSection />);
  const depth = screen.getByLabelText("Maximum workflow chain depth");
  await waitFor(() => expect(depth).toHaveProperty("disabled", false));
  await user.selectOptions(depth, "0");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Depth save refused");
  expect(depth).toHaveProperty("value", "2");
  expect(write).toHaveBeenCalledWith(0);
});

test("clipboard failures are visible and copied commands retain follow-vault setup", async () => {
  const user = userEvent.setup();
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("Clipboard denied"))
    .mockResolvedValue();
  render(<ConnectAiSection />);
  await screen.findByText("Installed");
  const block = screen.getByRole("region", { name: "Run once in any terminal — all your projects" });
  await user.click(within(block).getByRole("button"));
  expect(await within(block).findByRole("alert")).toHaveProperty("textContent", "Clipboard denied");
  await user.click(within(block).getByRole("button"));
  await within(block).findByText("Copied to clipboard.");
  expect(clipboard).toHaveBeenLastCalledWith(
    "claude mcp remove --scope user mosaic >/dev/null 2>&1; claude mcp add --scope user mosaic -- /Applications/Mosaic.app/mosaic mcp",
  );
});

test("Claude Desktop is set up from the app, showing the real config path", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(api, "writeClaudeDesktopConfig").mockResolvedValue({
    path: DESKTOP_PATH,
    state: { state: "configured" },
  });
  render(<ConnectAiSection />);
  await screen.findByText("Mosaic isn't in Claude Desktop's settings yet.");
  expect(screen.getByRole("region", { name: `Or add by hand to ${DESKTOP_PATH}` })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add Mosaic to Claude Desktop" }));
  expect(write).toHaveBeenCalledOnce();
  await screen.findByText("Mosaic is set up in Claude Desktop.");
  expect(screen.getByText(/Saved\. Open Claude Desktop again/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add Mosaic to Claude Desktop" })).toBeNull();
});

test("an older Desktop setup can be updated, and a write failure is shown", async () => {
  const user = userEvent.setup();
  setupStatus = {
    desktop: { path: DESKTOP_PATH, state: { state: "different", entry: { command: "mosaic", args: ["mcp"] } } },
    claude_code: [],
  };
  vi.spyOn(api, "writeClaudeDesktopConfig").mockRejectedValue(new Error("Permission denied"));
  render(<ConnectAiSection />);
  await screen.findByText(/older Mosaic setup: mosaic mcp/);
  await user.click(screen.getByRole("button", { name: "Update Mosaic in Claude Desktop" }));
  expect((await screen.findAllByRole("alert")).some((a) => a.textContent === "Permission denied")).toBe(true);
});

test("registrations that hide the recommended one are listed with a fix", async () => {
  setupStatus = {
    desktop: null,
    claude_code: [
      {
        scope: "user",
        project: null,
        entry: { command: "/Applications/Mosaic.app/mosaic", args: ["mcp"] },
        problems: [],
      },
      {
        scope: "local",
        project: "/Users/me/code/site",
        entry: { command: "mosaic", args: ["--vault", "/old", "mcp"] },
        problems: ["shadows-user", "pins-vault", "not-absolute"],
      },
    ],
  };
  render(<ConnectAiSection />);
  await screen.findByText(/a Mosaic registration that can stop it/);
  expect(screen.getByText(/It is tied to one vault/)).toBeTruthy();
  const fix = screen.getByRole("region", { name: "Remove the local registration" });
  expect(within(fix).getByText("cd /Users/me/code/site && claude mcp remove --scope local mosaic")).toBeTruthy();
});

test("Test connection reports a server that works without a vault, and one that fails", async () => {
  const user = userEvent.setup();
  const probe = vi
    .spyOn(api, "testMcpConnection")
    .mockResolvedValueOnce({
      ok: true,
      server_version: "1",
      tools: 45,
      no_vault: "No Mosaic vault is open yet.",
      error: null,
      stderr: "",
    })
    .mockResolvedValueOnce({
      ok: false,
      server_version: null,
      tools: 0,
      no_vault: null,
      error: "the server exited before answering",
      stderr: "boom",
    });
  render(<ConnectAiSection />);
  const button = await screen.findByRole("button", { name: "Test connection" });
  await user.click(button);
  await screen.findByText(/The server works \(45 tools\), but no vault opens yet/);
  await user.click(button);
  await screen.findByText(/didn't respond correctly: the server exited before answering/);
  expect(screen.getByText("boom")).toBeTruthy();
  expect(probe).toHaveBeenCalledTimes(2);
});

test("without a bundled command no broken setup is offered", async () => {
  vi.spyOn(api, "cliInfo").mockResolvedValue({ path: null, link: "~/.local/bin/mosaic", installed: false });
  render(<ConnectAiSection />);
  await screen.findByText(/which this build doesn't include/);
  expect(screen.queryByRole("region", { name: "Run once in any terminal — all your projects" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
});
