// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShortcuts } from "./shortcuts";
import { useUi } from "./state/ui";
import { useVault } from "./state/vault";

const keydown = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => window.dispatchEvent(event));
  return event;
};

const makeVisible = (element: HTMLElement) => {
  Object.defineProperty(element, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }) as DOMRectList,
  });
};

afterEach(() => {
  document.body.replaceChildren();
  useVault.setState({ vault: null });
  useUi.setState({ switcher: false });
});

describe("global keyboard shortcuts", () => {
  it("cycles visible focus regions in both directions", () => {
    const first = document.createElement("section");
    first.dataset.focusRegion = "first";
    makeVisible(first);
    const button = document.createElement("button");
    first.append(button);

    const second = document.createElement("section");
    second.dataset.focusRegion = "second";
    second.tabIndex = 0;
    makeVisible(second);

    const hidden = document.createElement("section");
    hidden.dataset.focusRegion = "hidden";
    document.body.append(first, second, hidden);
    const { unmount } = renderHook(() => useShortcuts());

    button.focus();
    expect(keydown({ key: "F6" }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    keydown({ key: "F6", shiftKey: true });
    expect(document.activeElement).toBe(button);

    first.remove();
    second.remove();
    expect(keydown({ key: "F6" }).defaultPrevented).toBe(false);
    unmount();
  });

  it("requires an open vault and runs only matching commands", () => {
    renderHook(() => useShortcuts());
    expect(keydown({ code: "KeyO", metaKey: true }).defaultPrevented).toBe(false);

    useVault.setState({ vault: { root: "/vault", name: "Vault" } });
    expect(keydown({ code: "KeyZ", metaKey: true }).defaultPrevented).toBe(false);
    expect(keydown({ code: "KeyO" }).defaultPrevented).toBe(false);
    expect(keydown({ code: "KeyO", metaKey: true }).defaultPrevented).toBe(true);
    expect(useUi.getState().switcher).toBe(true);
  });
});
