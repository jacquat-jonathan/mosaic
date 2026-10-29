// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useVault } from "../state/vault";
const mocks = vi.hoisted(() => ({ fileUrl: vi.fn(), getDocument: vi.fn() }));
vi.mock("../ipc/api", async (original) => ({
  ...(await original<typeof import("../ipc/api")>()),
  fileUrl: mocks.fileUrl,
}));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: mocks.getDocument }));
import { PdfViewer } from "./PdfViewer";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test("late file URLs cannot start PDF workers after the viewer closes", async () => {
  let finish!: (url: string) => void;
  mocks.fileUrl.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<PdfViewer path="old.pdf" />);
  expect(screen.getByRole("status").textContent).toContain("Loading PDF");
  view.unmount();
  await act(async () => finish("data:application/pdf;base64,YQ=="));
  expect(mocks.getDocument).not.toHaveBeenCalled();
});
test("PDF failures offer a fresh read without retaining the failed document", async () => {
  useVault.setState({ vault: { root: "/vault", name: "Vault" } });
  mocks.fileUrl.mockResolvedValue("data:application/pdf;base64,YQ==");
  const destroy = vi.fn().mockResolvedValue(undefined);
  mocks.getDocument
    .mockReturnValueOnce({ promise: Promise.reject(new Error("invalid PDF")), destroy })
    .mockReturnValueOnce({ promise: new Promise(() => {}), destroy });
  render(<PdfViewer path="broken.pdf" />);
  expect((await screen.findByRole("alert")).textContent).toContain("invalid PDF");
  fireEvent.click(screen.getByRole("button", { name: "Retry PDF" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Loading PDF");
  await act(async () => {});
  expect(mocks.fileUrl).toHaveBeenCalledTimes(2);
  expect(destroy).toHaveBeenCalledOnce();
});
