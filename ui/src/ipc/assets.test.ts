// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bindVaultSession } from "../state/vaultSession";

const native = vi.hoisted(() => ({ asset: vi.fn(), preview: vi.fn() }));
vi.mock("./bindings", () => ({ commands: { assetPath: native.asset, htmlPreviewDocument: native.preview } }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
}));

let active = { session: { root: "/a", generation: "1", vault_id: "a" } };
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  active = { session: { root: "/a", generation: "1", vault_id: "a" } };
  bindVaultSession(() => active);
  vi.clearAllMocks();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test("native URLs preserve folders while encoding filename characters once", async () => {
  const { fileUrl } = await import("./api");
  native.asset.mockResolvedValue("secret/vault/dir/space # %.svg");
  const url = await fileUrl("dir/space # %.svg");
  expect(native.asset).toHaveBeenCalledWith("dir/space # %.svg", "1");
  expect(url).toBe("mosaic-asset://localhost/secret/vault/dir/space%20%23%20%25.svg");
  expect(new URL("font.woff2", url).href).toBe("mosaic-asset://localhost/secret/vault/dir/font.woff2");
});

test("delayed file and preview replies cannot publish URLs into a new activation", async () => {
  const { fileUrl, htmlPreviewDocumentUrl } = await import("./api");
  let finishFile!: (value: string) => void;
  let finishPreview!: (value: string) => void;
  native.asset.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishFile = resolve;
      }),
  );
  native.preview.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPreview = resolve;
      }),
  );
  const file = fileUrl("a.png");
  const preview = htmlPreviewDocumentUrl("<h1>A</h1>");
  expect(native.preview).toHaveBeenCalledWith("<h1>A</h1>", "1");
  active = { session: { root: "/a", generation: "2", vault_id: "a" } };
  finishFile("old/vault/a.png");
  finishPreview("old/preview/a.html");
  await expect(file).rejects.toThrow("Asset session changed");
  await expect(preview).rejects.toThrow("Asset session changed");
});
