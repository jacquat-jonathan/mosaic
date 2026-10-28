import { describe, expect, it } from "vitest";
import { ago, dayLabel } from "./time";

const now = new Date(2026, 9, 28, 18, 0).getTime();

describe("relative time labels", () => {
  it("uses compact labels for recent activity", () => {
    expect(ago(now - 30_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });

  it("distinguishes today, yesterday and older dates", () => {
    const today = new Date(2026, 9, 28, 9, 5).getTime();
    const yesterday = new Date(2026, 9, 27, 14, 3).getTime();
    const older = new Date(2026, 9, 20, 12, 0).getTime();
    const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    expect(ago(today, now)).toBe(`today ${time(today)}`);
    expect(ago(yesterday, now)).toBe(`yesterday ${time(yesterday)}`);
    expect(ago(older, now)).toBe(`${new Date(older).toLocaleDateString()} ${time(older)}`);
    expect(dayLabel(today, now)).toBe("Today");
    expect(dayLabel(yesterday, now)).toBe("Yesterday");
    expect(dayLabel(older, now)).toBe(
      new Date(older).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }),
    );
  });
});
