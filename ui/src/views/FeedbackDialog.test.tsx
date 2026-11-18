// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../ipc/api", async (original) => ({
  ...(await original<typeof import("../ipc/api")>()),
  openExternal: mocks.openExternal,
}));
import { FeedbackDialog } from "./FeedbackDialog";
import { WindowChrome } from "./WindowChrome";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const openedUrl = () => new URL(mocks.openExternal.mock.calls[0][0] as string);

test("the window strip's feedback button opens the dialog next to the version", () => {
  render(<WindowChrome vaultName="Vault" version="0.29.0" />);
  expect(screen.getByText("v0.29.0")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  const dialog = screen.getByRole("dialog", { name: "Send feedback" });
  // Rendered outside the title strip.
  expect(dialog.closest(".window-chrome")).toBeNull();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("submitting a bug opens a prefilled GitHub issue with version and OS, then closes", async () => {
  const onClose = vi.fn();
  render(<FeedbackDialog version="0.29.0" onClose={onClose} />);
  const submit = screen.getByRole("button", { name: "Open in GitHub" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(
    (screen.getByRole("switch", { name: "Include app version and OS" }) as HTMLElement).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByText(/access to the Mosaic repository/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Search & replace broke" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Steps:\n1. open" } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  const url = openedUrl();
  expect(url.origin + url.pathname).toBe("https://github.com/jacquat-jonathan/mosaic/issues/new");
  expect(url.searchParams.get("labels")).toBe("bug");
  expect(url.searchParams.get("title")).toBe("Search & replace broke");
  expect(url.searchParams.get("body")).toContain("Steps:\n1. open");
  expect(url.searchParams.get("body")).toMatch(/- Mosaic: v0\.29\.0\n- OS: \w+/);
  expect(onClose).toHaveBeenCalled();
});

test("an idea without the environment carries the enhancement label and no version", () => {
  render(<FeedbackDialog version="0.29.0" onClose={() => {}} />);
  fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
  fireEvent.click(screen.getByRole("switch", { name: "Include app version and OS" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Kanban" } });
  fireEvent.submit(screen.getByLabelText("Title").closest("form") as HTMLFormElement);
  const url = openedUrl();
  expect(url.searchParams.get("labels")).toBe("enhancement");
  expect(url.searchParams.get("template")).toBe("feature_request.md");
  expect(url.searchParams.get("body")).not.toContain("0.29.0");
});

test("a blank title does not submit, and a very long message warns that it will be shortened", () => {
  render(<FeedbackDialog version="0.29.0" onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
  fireEvent.submit(screen.getByLabelText("Title").closest("form") as HTMLFormElement);
  expect(mocks.openExternal).not.toHaveBeenCalled();
  expect(screen.queryByText(/too long for a link/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "x ".repeat(5000) } });
  expect(screen.getByText(/too long for a link/)).toBeTruthy();
});

test("Cancel closes without opening anything", () => {
  const onClose = vi.fn();
  render(<FeedbackDialog version="" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
  expect(mocks.openExternal).not.toHaveBeenCalled();
});

test("if the browser can't be opened, the dialog stays open with what was typed and says so", async () => {
  mocks.openExternal.mockRejectedValueOnce(new Error("denied"));
  const onClose = vi.fn();
  render(<FeedbackDialog version="0.29.0" onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("button", { name: "Open in GitHub" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/Couldn't open your browser/)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Keep me");
  expect((screen.getByRole("button", { name: "Open in GitHub" }) as HTMLButtonElement).disabled).toBe(false);
});
