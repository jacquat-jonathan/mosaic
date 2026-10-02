import { expect, test } from "vitest";
import { pastedName } from "./MarkdownEditor";

test("pasted images get a dated name with the right extension", () => {
  const at = new Date(2026, 9, 2, 14, 30, 5);
  expect(pastedName({ type: "image/png" }, 0, at)).toBe("Pasted image 2026-10-02 143005.png");
  expect(pastedName({ type: "image/jpeg" }, 1, at)).toBe("Pasted image 2026-10-02 143005 2.jpg");
  expect(pastedName({ type: "image/svg+xml" }, 0, at)).toBe("Pasted image 2026-10-02 143005.svg");
});
