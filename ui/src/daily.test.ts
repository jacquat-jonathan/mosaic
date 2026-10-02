import { expect, test } from "vitest";
import { dailyPath, dayStamp, fillTemplate } from "./daily";

const day = new Date(2026, 9, 2, 9, 5);

test("daily notes are named by date, in their folder", () => {
  expect(dayStamp(day)).toBe("2026-10-02");
  expect(dailyPath("Daily", day)).toBe("Daily/2026-10-02.md");
  expect(dailyPath("/Journal/", day)).toBe("Journal/2026-10-02.md");
  expect(dailyPath("", day)).toBe("2026-10-02.md");
});

test("templates get the date, weekday and time", () => {
  expect(fillTemplate("# {{title}}\n{{weekday}} at {{ time }}\n{{unknown}}", day)).toBe("# 2026-10-02\nFriday at 09:05\n{{unknown}}");
});
