// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useVault } from "../state/vault";
const mocks = vi.hoisted(() => ({ fileUrl: vi.fn() }));
vi.mock("../ipc/api", async (original) => ({
  ...(await original<typeof import("../ipc/api")>()),
  fileUrl: mocks.fileUrl,
}));
import { ImageViewer } from "./ImageViewer";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
test("image failures retry the file and retain accessible loading states", async () => {
  mocks.fileUrl.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce("data:image/svg+xml,<svg/>");
  render(<ImageViewer path="image.svg" />);
  expect((await screen.findByRole("alert")).textContent).toContain("unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
  expect(screen.getByRole("status").textContent).toContain("Loading image");
  const image = await screen.findByAltText("image.svg");
  fireEvent.load(image);
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.fileUrl).toHaveBeenCalledTimes(2);
});
test("late image URLs cannot replace the active vault's image", async () => {
  let finish!: (value: string) => void;
  useVault.setState({ vault: { root: "/first", name: "First" } });
  mocks.fileUrl
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce("data:image/svg+xml,new");
  render(<ImageViewer path="same.svg" />);
  await act(async () => useVault.setState({ vault: { root: "/second", name: "Second" } }));
  const image = await screen.findByAltText("same.svg");
  await act(async () => finish("data:image/svg+xml,old"));
  expect(image.getAttribute("src")).toBe("data:image/svg+xml,new");
});
