import { useEffect, useId, useRef, useState } from "react";
import { parseDocument } from "yaml";
import { Button, Notice, Select, SettingRow, Switch, TextArea, TextField } from "../design-system/components";
import { api } from "../ipc/api";
import { errorMessage, type Agent } from "../ipc/types";
import { useAttention } from "../state/attention";
import { useUi } from "../state/ui";
import { useVault, uniquePath } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { FRONTMATTER_RE } from "../editor/livePreview";
import { vaultPrefs } from "../state/vaultPreferences";
import { registerDraft } from "../state/drafts";
import { FolderChoices } from "./FolderChoices";
import { eventFolder } from "./workflowPresentation";
import { viewPath } from "./specialTabs";
import { DesignSystemScope } from "./DesignSystemScope";
import "./workflowEditor.css";

export function workflowContent(
  source: string,
  schedule: string | null,
  events: string[],
  model: string | null,
  folders: string[],
  instructions?: string,
  web = false,
): string {
  const fm = FRONTMATTER_RE.exec(source);
  const doc = parseDocument(fm?.[1] ?? "");
  if (doc.errors.length) throw new Error("Fix the agent's YAML in its source before using the form.");
  // Initialize an empty mapping before deleting optional keys for a manual workflow.
  if (!doc.contents) doc.set("may-change", folders);
  if (schedule) doc.set("schedule", schedule);
  else doc.delete("schedule");
  if (events.length === 1) doc.set("on", events[0]);
  else if (events.length) doc.set("on", events);
  else doc.delete("on");
  if (model) doc.set("model", model);
  else doc.delete("model");
  doc.delete("may_change");
  doc.set("may-change", folders);
  if (web) doc.set("web", true);
  else doc.delete("web");
  const body = instructions === undefined ? source.slice(fm?.[0].length ?? 0) : `\n${instructions.trim()}\n`;
  return `---\n${doc.toString()}---${instructions === undefined && fm ? body : `\n${body}`}`;
}
export function WorkflowForm({ agent, onDone }: { agent?: Agent; onDone?: () => void }) {
  const agents = useAttention((s) => s.agents);
  const [dirty, setDirty] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [choice, setChoice] = useState(agent?.name ?? "");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [source, setSource] = useState<{ path: string; content: string; hash: string } | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleKind, setScheduleKind] = useState("daily");
  const [time, setTime] = useState("08:00");
  const [interval, setInterval] = useState(2);
  const [custom, setCustom] = useState("");
  const [eventFolders, setEventFolders] = useState<string[]>([]);
  const [eventEnabled, setEventEnabled] = useState(false);
  const [otherEvents, setOtherEvents] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [review, setReview] = useState(true);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [web, setWeb] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const id = useId();
  const saveLock = useRef(false);
  const chosen = agents.find((a) => a.name === choice);
  const root = useVault((s) => s.vault?.root);
  const [initialRoot] = useState(root);
  const [draftPath] = useState(() => (agent ? viewPath("workflow", agent.name) : "mosaic:new-workflow"));
  const unregister = useRef<(() => void) | null>(null);
  const discard = async () => {
    if (saveLock.current) return false;
    if (!dirty) return true;
    const ok = await useUi.getState().ask({
      title: "Discard workflow changes?",
      body: "Your draft has not been saved. The agent source is unchanged.",
      confirmLabel: "Discard changes",
      danger: true,
    });
    if (ok) {
      setDirty(false);
      unregister.current?.();
    }
    return ok;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `discard` is recreated with `dirty`, which is listed
  useEffect(() => {
    if (!dirty) return;
    unregister.current = registerDraft(draftPath, discard);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unregister.current?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, draftPath]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the form is reset only when another agent is chosen
  useEffect(() => {
    let live = true;
    setSource(null);
    setError(null);
    if (!chosen) {
      setInstructions("");
      setScheduleEnabled(false);
      setScheduleKind("daily");
      setEventEnabled(false);
      setEventFolders([]);
      setOtherEvents([]);
      setModel("");
      setAllowed([]);
      setReview(true);
      setWeb(false);
      return;
    }
    setInstructions(chosen.instructions);
    setAllowed(chosen.may_change);
    setReview(!chosen.may_change.length);
    setModel(chosen.model ?? "");
    setWeb(chosen.web);
    const parsedEvents = (chosen.on ?? []).map((raw) => [raw, eventFolder(raw)] as const);
    setEventFolders(parsedEvents.map(([, folder]) => folder).filter((f): f is string => f !== null));
    setEventEnabled(parsedEvents.some(([, folder]) => folder !== null));
    setOtherEvents(parsedEvents.filter(([, folder]) => folder === null).map(([raw]) => raw));
    const parts = /^(daily|weekdays|mon|tue|wed|thu|fri|sat|sun) (\d{2}:\d{2})$/.exec(chosen.schedule ?? "");
    const every = /^every (\d+)h$/.exec(chosen.schedule ?? "");
    setScheduleEnabled(!!chosen.schedule);
    if (parts) {
      setScheduleKind(parts[1]);
      setTime(parts[2]);
    } else if (every) {
      setScheduleKind("every");
      setInterval(Number(every[1]));
    } else if (chosen.schedule) {
      setScheduleKind("custom");
      setCustom(chosen.schedule);
    } else setScheduleKind("daily");
    void api.read(chosen.path).then(
      (f) => {
        if (live) setSource({ path: chosen.path, content: f.content ?? "", hash: f.hash });
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [chosen?.path]);
  useEffect(() => {
    if (error && invalidField) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [error, invalidField]);
  const invalid = (field: string, message: string): never => {
    setInvalidField(field);
    throw new Error(message);
  };
  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError(null);
    setInvalidField(null);
    try {
      if (useVault.getState().vault?.root !== initialRoot)
        throw new Error("The vault changed. Reopen the workflow form.");
      if (!instructions.trim()) invalid("instructions", "Describe what the agent should do.");
      if (!review && !allowed.length) invalid("allowed", "Choose at least one folder, or review every change.");
      const schedule = !scheduleEnabled
        ? null
        : scheduleKind === "custom"
          ? custom
          : scheduleKind === "every"
            ? `every ${interval}h`
            : `${scheduleKind} ${time}`;
      if (scheduleEnabled && !schedule?.trim()) invalid("schedule", "Choose a schedule or disable scheduled runs.");
      if (
        scheduleEnabled &&
        scheduleKind !== "custom" &&
        scheduleKind !== "every" &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
      )
        invalid("time", "Choose a valid time.");
      if (
        scheduleEnabled &&
        scheduleKind === "every" &&
        (!Number.isInteger(interval) || interval < 1 || interval > 8760)
      )
        invalid("interval", "Choose an interval between 1 and 8760 hours.");
      if (eventEnabled && !eventFolders.length)
        invalid("events", "Choose at least one event folder, including Vault root if needed.");
      const events = [
        ...otherEvents,
        ...(eventEnabled ? eventFolders : []).map((folder) => `created in ${folder ? `${folder}/` : "/"}`),
      ];
      let path: string;
      if (chosen) {
        if (!source || source.path !== chosen.path) throw new Error("Wait for the agent to load.");
        const buffer = useWorkspace.getState().buffers[chosen.path];
        if (buffer?.dirty || buffer?.conflict)
          throw new Error("Save the open agent source and resolve conflicts before editing its workflow.");
        await api.write(
          chosen.path,
          workflowContent(
            source.content,
            schedule,
            events,
            model || null,
            review ? [] : allowed,
            instructions === chosen.instructions ? undefined : instructions,
            web,
          ),
          source.hash,
          initialRoot,
        );
        if (useVault.getState().vault?.root !== initialRoot) return;
        path = chosen.path;
        await useWorkspace.getState().externalChange(path);
      } else {
        const name = title.trim();
        if (!name || /[\\/:*?"<>|]/.test(name)) invalid("title", "Enter a title without file path characters.");
        path = uniquePath(
          new Set(useVault.getState().entries.map((e) => e.path.toLowerCase())),
          vaultPrefs().agents_folder,
          name,
          "md",
        );
        await api.create(
          path,
          workflowContent("", schedule, events, model || null, review ? [] : allowed, instructions, web),
          initialRoot,
        );
      }
      if (useVault.getState().vault?.root !== initialRoot) return;
      await api.mirrorAgents();
      if (useVault.getState().vault?.root !== initialRoot) return;
      await useVault.getState().refresh();
      if (useVault.getState().vault?.root !== initialRoot) return;
      await useAttention.getState().refresh();
      if (useVault.getState().vault?.root !== initialRoot) return;
      const result = useAttention.getState().agents.find((a) => a.path === path);
      unregister.current?.();
      setDirty(false);
      if (result) useUi.getState().openView("workflow", result.name);
      if (onDone) onDone();
      else {
        const ws = useWorkspace.getState();
        for (const p of ws.panes) if (p.tabs.includes("mosaic:new-workflow")) ws.closeTab(p.id, "mosaic:new-workflow");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
      saveLock.current = false;
    }
  };
  const cancel = async () => {
    if (await discard()) {
      if (onDone) onDone();
      else useUi.getState().openView("workflows");
    }
  };
  const fieldError = (field: string) => (invalidField === field ? (error ?? undefined) : undefined);
  const problem = root !== initialRoot ? "The vault changed. Reopen this form before saving." : error;
  const toggle = (setter: (checked: boolean) => void) => (checked: boolean) => {
    setter(checked);
    setDirty(true);
  };
  return (
    <DesignSystemScope className="workspace-page workflow-editor" role="group" aria-label="Workflow editor">
      <header>
        <p className="mds-hint">WORKFLOW · {agent ? "EDIT" : "NEW"}</p>
        <h1>{agent ? "Edit workflow" : "Create workflow"}</h1>
        <p>Describe the work, choose when it runs, and keep control of every change.</p>
      </header>
      <form
        ref={form}
        className="workflow-form"
        noValidate
        aria-label={agent ? "Edit workflow" : "Create workflow"}
        aria-describedby={problem ? `${id}-error` : undefined}
        onChange={() => setDirty(true)}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="workflow-form-fields" disabled={saving}>
          <legend className="workflow-form-legend">Workflow configuration</legend>
          <section className="workflow-section">
            <h2>The work</h2>
            {!agent && (
              <Select
                label="Agent"
                value={choice}
                onChange={(event) => {
                  const next = event.target.value;
                  void discard().then((accepted) => {
                    if (accepted && useVault.getState().vault?.root === initialRoot) {
                      setChoice(next);
                      setDirty(false);
                    }
                  });
                }}
              >
                <option value="">Create a new agent</option>
                {agents.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.title}
                  </option>
                ))}
              </Select>
            )}
            {!choice ? (
              <TextField
                label="Name"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Weekly review"
                error={fieldError("title")}
                autoFocus
              />
            ) : (
              <Notice>
                Editing <strong>{chosen?.title}</strong> · <code>{chosen?.path}</code>. Saving updates this agent
                source.
              </Notice>
            )}
            <TextArea
              label="Instructions"
              required
              rows={10}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What should this agent do with your vault files?"
              error={fieldError("instructions")}
            />
          </section>
          <section className="workflow-section">
            <h2>When to run</h2>
            <p className="mds-hint">Run now is always available. Automatic triggers run while Mosaic is open.</p>
            <SettingRow label="Run on a schedule" controlId={`${id}-schedule-toggle`}>
              <Switch
                id={`${id}-schedule-toggle`}
                label="Run on a schedule"
                checked={scheduleEnabled}
                onCheckedChange={toggle(setScheduleEnabled)}
              />
            </SettingRow>
            {scheduleEnabled && (
              <>
                <Select
                  label="Schedule"
                  value={scheduleKind}
                  aria-invalid={invalidField === "schedule" || undefined}
                  aria-describedby={invalidField === "schedule" ? `${id}-error` : undefined}
                  onChange={(event) => setScheduleKind(event.target.value)}
                >
                  {[
                    ["daily", "Every day"],
                    ["weekdays", "Weekdays"],
                    ["mon", "Mondays"],
                    ["tue", "Tuesdays"],
                    ["wed", "Wednesdays"],
                    ["thu", "Thursdays"],
                    ["fri", "Fridays"],
                    ["sat", "Saturdays"],
                    ["sun", "Sundays"],
                    ["every", "Every few hours"],
                    ...(custom ? [["custom", `Existing schedule: ${custom}`]] : []),
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                {scheduleKind === "every" ? (
                  <TextField
                    label="Hours"
                    type="number"
                    min={1}
                    max={8760}
                    value={interval}
                    onChange={(event) => setInterval(Number(event.target.value))}
                    error={fieldError("interval")}
                  />
                ) : (
                  scheduleKind !== "custom" && (
                    <TextField
                      label="Local time"
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                      error={fieldError("time")}
                    />
                  )
                )}
              </>
            )}
            <SettingRow label="Run when a Markdown note is created" controlId={`${id}-event-toggle`}>
              <Switch
                id={`${id}-event-toggle`}
                label="Run when a Markdown note is created"
                checked={eventEnabled}
                onCheckedChange={toggle(setEventEnabled)}
              />
            </SettingRow>
            {eventEnabled && (
              <>
                <FolderChoices
                  label="Event folders"
                  root
                  value={eventFolders}
                  disabled={saving}
                  error={fieldError("events")}
                  onChange={(value) => {
                    setEventFolders(value);
                    setDirty(true);
                  }}
                />
                <p className="mds-hint">Includes Markdown notes in subfolders.</p>
              </>
            )}
            {!scheduleEnabled && !eventEnabled && !otherEvents.length && (
              <Notice>Manual only · Run it whenever you need it.</Notice>
            )}
          </section>
          <section className="workflow-section">
            <h2>Execution &amp; safety</h2>
            <Select label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">Claude Code default</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
              {model && !["sonnet", "opus", "haiku"].includes(model) && <option value={model}>{model}</option>}
            </Select>
            <Select
              label="Review behavior"
              value={review ? "all" : "folders"}
              onChange={(event) => setReview(event.target.value === "all")}
            >
              <option value="all">Review every change — recommended</option>
              <option value="folders">Allow changes in selected folders</option>
            </Select>
            {!review && (
              <FolderChoices
                label="May change without review"
                value={allowed}
                disabled={saving}
                error={fieldError("allowed")}
                onChange={(value) => {
                  setAllowed(value);
                  setDirty(true);
                }}
              />
            )}
            <p className="mds-hint">
              Outside these folders, changes require review. Stricter vault permissions always apply.
            </p>
            <SettingRow
              label="Can use the web (search and fetch pages)"
              controlId={`${id}-web-toggle`}
              hintId={`${id}-web-hint`}
              hint="Off by default. A run started by a new note treats that note as untrusted input; web access lets it send what it reads elsewhere."
            >
              <Switch
                id={`${id}-web-toggle`}
                label="Can use the web (search and fetch pages)"
                aria-describedby={`${id}-web-hint`}
                checked={web}
                onCheckedChange={toggle(setWeb)}
              />
            </SettingRow>
          </section>
          {chosen && (
            <details className="workflow-section">
              <summary>Advanced · agent source</summary>
              <p className="mds-hint">
                <code>{chosen.path}</code>
              </p>
              {!!otherEvents.length && (
                <Notice tone="warning">Custom events preserved: {otherEvents.join(", ")}</Notice>
              )}
              {scheduleKind === "custom" && <p className="mds-hint">Custom schedule preserved: {custom}</p>}
              <Button
                variant="secondary"
                onClick={() => {
                  if (useVault.getState().vault?.root === initialRoot)
                    void useWorkspace
                      .getState()
                      .open(chosen.path, { newTab: true })
                      .catch((cause) => setError(errorMessage(cause)));
                }}
              >
                Edit source
              </Button>
            </details>
          )}
        </fieldset>
        {problem && (
          <div id={`${id}-error`}>
            <Notice tone="error">{problem}</Notice>
          </div>
        )}
        {saving && (
          <p className="mds-hint" role="status">
            Saving workflow…
          </p>
        )}
        <footer className="workflow-save">
          <div>
            <strong>
              {scheduleEnabled || eventEnabled || otherEvents.length ? "Automatic triggers configured" : "Manual only"}
            </strong>
            <p className="mds-hint">
              {review ? "Review every change" : `${allowed.length} allowed folders`} · Saving does not run or unpause
              this workflow.
            </p>
          </div>
          <Button disabled={saving} onClick={() => void cancel()}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="secondary"
            disabled={saving || !root || root !== initialRoot || (!!choice && !source)}
          >
            {saving ? "Saving…" : agent ? "Save changes" : "Create workflow"}
          </Button>
        </footer>
      </form>
    </DesignSystemScope>
  );
}
