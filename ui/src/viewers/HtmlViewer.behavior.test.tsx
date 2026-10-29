// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useVault } from "../state/vault";
import { useVaultPreferences } from "../state/vaultPreferences";
import type { Buffer } from "../state/workspace";
const mocks = vi.hoisted(() => ({ publish: vi.fn(), fileUrl: vi.fn() }));
vi.mock("../ipc/api", async (original) => ({
  ...(await original<typeof import("../ipc/api")>()),
  htmlPreviewDocumentUrl: mocks.publish,
  fileUrl: mocks.fileUrl,
}));
import { HtmlViewer } from "./HtmlViewer";
const buffer: Buffer = {
  path: "page.html",
  kind: "html",
  content: "<h1>Demo</h1>",
  baseHash: "base",
  dirty: false,
  conflict: null,
  deleted: false,
  error: null,
  version: 1,
};
beforeEach(() => {
  mocks.fileUrl.mockResolvedValue("file:///vault/page.html");
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
  useVaultPreferences.setState({ root: "/vault" });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test("failed HTML publication offers a fresh preview retry", async () => {
  mocks.publish.mockRejectedValueOnce(new Error("preview unavailable")).mockResolvedValueOnce("about:blank");
  render(<HtmlViewer buffer={buffer} />);
  expect((await screen.findByRole("alert")).textContent).toContain("preview unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  expect(await screen.findByTitle("page.html")).toBeTruthy();
  expect(mocks.publish).toHaveBeenCalledTimes(2);
});
test("closed HTML viewers do not publish a late prepared document", async () => {
  mocks.publish.mockResolvedValue("about:blank");
  const view = render(<HtmlViewer buffer={buffer} />);
  view.unmount();
  await act(async () => {});
  expect(mocks.publish).not.toHaveBeenCalled();
});
