// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ADD_PROPERTY_EVENT } from "./noteViews";
import { PropertiesEditor } from "./PropertiesEditor";

afterEach(cleanup);

test("edits every supported property kind and removes list values", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const yaml = [
    "title: Draft",
    "tags: [alpha, beta]",
    "published: false",
    "due: 2026-10-27",
    "count: 2",
    "nested:",
    "  owner: team",
  ].join("\n");
  render(<PropertiesEditor yaml={yaml} onChange={change} onEditSource={vi.fn()} />);

  const title = screen.getByLabelText("title");
  await user.clear(title);
  await user.type(title, "Ready");
  fireEvent.blur(title);
  await user.click(screen.getByLabelText("published"));
  fireEvent.change(screen.getByLabelText("due"), { target: { value: "2026-11-01" } });
  const count = screen.getByLabelText("count");
  await user.clear(count);
  await user.type(count, "5");
  fireEvent.blur(count);
  await user.click(screen.getByRole("button", { name: "Remove alpha from tags" }));
  await user.type(screen.getByLabelText("Add to tags"), "gamma, delta{Enter}");
  const edits = change.mock.calls.length;
  expect(edits).toBeGreaterThanOrEqual(6);

  const key = screen.getAllByLabelText("Property name")[0];
  await user.clear(key);
  await user.type(key, "heading{Enter}");
  expect(change.mock.calls.length).toBeGreaterThan(edits);
  const renamed = change.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Remove title" }));
  expect(change.mock.calls.length).toBeGreaterThan(renamed);
});

test("adds properties, handles clashes and opens invalid YAML as source", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const edit = vi.fn();
  const view = render(<PropertiesEditor yaml="title: Test\n" onChange={change} onEditSource={edit} />);
  await user.click(screen.getByRole("button", { name: /Add property/ }));
  await user.type(screen.getByLabelText("New property name"), "title");
  expect(screen.getByRole("button", { name: "Name taken" })).toHaveProperty("disabled", true);
  await user.clear(screen.getByLabelText("New property name"));
  await user.type(screen.getByLabelText("New property name"), "priority");
  await user.selectOptions(screen.getByLabelText("Type"), "number");
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect(change).toHaveBeenCalled();

  fireEvent(window, new Event(ADD_PROPERTY_EVENT));
  expect(await screen.findByLabelText("New property name")).toBeTruthy();
  await user.keyboard("{Escape}");
  view.unmount();

  render(<PropertiesEditor yaml="broken: [" onChange={change} onEditSource={edit} />);
  expect(screen.getByText(/aren't valid YAML/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Edit as YAML" }));
  expect(edit).toHaveBeenCalled();
});
