// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { Settings } from "./Settings";

beforeEach(() => {
  useUi.setState({ settings: "appearance" });
  useWorkspace.setState({ panes: [{ id: "p", tabs: ["mosaic:settings"], active: "mosaic:settings" }], focused: "p" });
});

afterEach(cleanup);

test("finds a setting and navigates to its section", async () => {
  const user = userEvent.setup();
  render(<Settings />);

  await user.type(screen.getByRole("textbox", { name: "Search settings" }), "trash");
  await user.click(
    within(screen.getByRole("region", { name: "Settings search results" })).getByRole("button", {
      name: "Editor & files",
    }),
  );
  expect(screen.getByRole("heading", { name: "Editor & files" })).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Ask before moving to the Trash" })).toBeTruthy();
});

test("reports an empty settings search and closes its workspace tab", async () => {
  const user = userEvent.setup();
  render(<Settings />);

  await user.type(screen.getByRole("textbox", { name: "Search settings" }), "definitely absent");
  expect(screen.getByText("No matching settings.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Close settings" }));
  expect(useWorkspace.getState().panes[0].tabs).not.toContain("mosaic:settings");
});
