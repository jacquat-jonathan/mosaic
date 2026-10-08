import { expect, test } from "vitest";
import { dailyPath, fillTemplate } from "./daily";
import { sanitize } from "./state/settings";
import { DEFAULT_VAULT_PREFS, useVaultPreferences } from "./state/vaultPreferences";
import { embedsFor } from "./actions";
import { startOfWeek, monthGrid } from "./views/calendar";
import { registerDraft, leaveDraft, hasDraft } from "./state/drafts";

test("daily filename choices don't change date-oriented template values", () => {
  const date = new Date(2026,9,8,12);
  expect(dailyPath("Journal",date,"DD-MM-YYYY")).toBe("Journal/08-10-2026.md");
  expect(dailyPath("",date,"YYYYMMDD")).toBe("20261008.md");
  expect(fillTemplate("{{date}} {{title}}",date)).toBe("2026-10-08 2026-10-08");
});
test("Sunday calendars use the same date range and heading order", () => {
  expect(startOfWeek(new Date(2026,9,8),true).getDay()).toBe(0);
  expect(monthGrid(new Date(2026,9,8),true).from.getDay()).toBe(0);
});
test("appearance and workspace settings reject malformed choices", () => {
  expect(sanitize({lineSpacing:0,uiScale:9,noteFont:[],weekStart:"friday"})).toMatchObject({lineSpacing:1.7,uiScale:1,noteFont:"system",weekStart:"monday"});
  expect(sanitize({noteFont:"Georgia",density:"compact",openLinksNewTab:true,sourceLineNumbers:true})).toMatchObject({noteFont:"Georgia",density:"compact",openLinksNewTab:true,sourceLineNumbers:true});
});
test("new Markdown attachment links are escaped and relative to the receiving note", () => {
  useVaultPreferences.setState({value:{...DEFAULT_VAULT_PREFS,link_style:"markdown"}});
  expect(embedsFor(["Assets/a (b)#1.png"],"Projects/Meeting.md")).toBe("![a (b)#1.png](../Assets/a%20%28b%29%231.png)");
  useVaultPreferences.setState({value:DEFAULT_VAULT_PREFS});
});
test("cancelled draft navigation leaves the guard registered", async () => {
  const unregister = registerDraft("mosaic:new-workflow",async()=>false);
  expect(await leaveDraft("mosaic:new-workflow")).toBe(false); expect(hasDraft("mosaic:new-workflow")).toBe(true);
  unregister(); expect(await leaveDraft("mosaic:new-workflow")).toBe(true);
});
