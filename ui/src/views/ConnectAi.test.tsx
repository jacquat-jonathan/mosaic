// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../ipc/api";
import type { AgentRule } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { ConnectAiSection } from "./ConnectAi";

let stored: AgentRule[];
beforeEach(() => {
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
    "claude mcp add --scope user mosaic -- /Applications/Mosaic.app/mosaic mcp",
  );
});
