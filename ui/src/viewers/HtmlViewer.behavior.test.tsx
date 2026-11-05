// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useVault } from "../state/vault";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "../state/vaultPreferences";
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
  useVaultPreferences.setState({ root: "/vault", value: DEFAULT_VAULT_PREFS });
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

const publishedPolicy = () =>
  new DOMParser()
    .parseFromString(mocks.publish.mock.lastCall?.[0] ?? "", "text/html")
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    ?.getAttribute("content");

test("a vault internet default permits listed origins without enabling scripts, and a page can block them", async () => {
  useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, allow_html_internet: true } });
  mocks.publish.mockResolvedValue("about:blank");
  render(
    <HtmlViewer
      buffer={{ ...buffer, path: "internet-default.html", content: '<img src="https://cdn.example.com/image.png">' }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Internet allowed by vault setting" }));
  await screen.findByRole("button", { name: "Internet blocked for this page" });
  expect(screen.queryByRole("alert", { name: "External resource permission" })).toBeNull();
  await waitFor(() => expect(publishedPolicy()).not.toContain("https://cdn.example.com"));
  expect(publishedPolicy()).toContain("script-src 'none'");
  fireEvent.click(screen.getByRole("button", { name: "Internet blocked for this page" }));
  await waitFor(() =>
    expect(publishedPolicy()).toContain("connect-src data: asset: http://asset.localhost https://cdn.example.com"),
  );
  expect(publishedPolicy()).toContain("script-src 'none'");
});

test("script permission alone still asks for internet, grants expire with page content and vault changes", async () => {
  useVaultPreferences.setState({ value: { ...DEFAULT_VAULT_PREFS, allow_html_scripts: true } });
  mocks.publish.mockResolvedValue("about:blank");
  const content = '<img src="https://images.example.com/image.png">';
  const view = render(<HtmlViewer buffer={{ ...buffer, path: "internet-scope.html", content }} />);
  await screen.findByRole("alert", { name: "External resource permission" });
  fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
  await waitFor(() => expect(publishedPolicy()).toContain("https://images.example.com"));
  view.rerender(
    <HtmlViewer buffer={{ ...buffer, path: "internet-scope.html", content: `${content}<p>Changed</p>` }} />,
  );
  await screen.findByRole("alert", { name: "External resource permission" });
  act(() => {
    useVault.setState({ vault: { root: "/other-vault", name: "Other" } });
    useVaultPreferences.setState({ root: "/other-vault", value: DEFAULT_VAULT_PREFS });
  });
  view.rerender(<HtmlViewer buffer={{ ...buffer, path: "internet-scope.html", content }} />);
  await screen.findByRole("alert", { name: "External resource permission" });
  await waitFor(() => expect(publishedPolicy()).not.toContain("https://images.example.com"));
});
