// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { isDark, onDarkChange } from "./theme";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe("effective colour scheme", () => {
  it("honours explicit themes before the system preference", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    document.documentElement.dataset.theme = "dark";
    expect(isDark()).toBe(true);
    document.documentElement.dataset.theme = "light";
    expect(isDark()).toBe(false);
    delete document.documentElement.dataset.theme;
    expect(isDark()).toBe(true);

    vi.stubGlobal("matchMedia", undefined);
    expect(isDark()).toBe(false);
  });

  it("reports changes once and removes both listeners", () => {
    let matches = false;
    let mediaListener: (() => void) | undefined;
    const addEventListener = vi.fn((_event: string, listener: () => void) => {
      mediaListener = listener;
    });
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener,
        removeEventListener,
      })),
    );
    const callback = vi.fn();
    const stop = onDarkChange(callback);

    window.dispatchEvent(new Event("mosaic-theme"));
    expect(callback).not.toHaveBeenCalled();
    matches = true;
    mediaListener?.();
    expect(callback).toHaveBeenLastCalledWith(true);
    document.documentElement.dataset.theme = "light";
    window.dispatchEvent(new Event("mosaic-theme"));
    expect(callback).toHaveBeenLastCalledWith(false);

    stop();
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
