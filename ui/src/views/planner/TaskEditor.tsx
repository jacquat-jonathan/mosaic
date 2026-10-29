import { useEffect, useRef, useState } from "react";
import { Button, IconButton, Notice, Select, TextArea, TextField } from "../../design-system/components";
import { X } from "lucide-react";
import { DesignSystemScope } from "../DesignSystemScope";
import { useVault } from "../../state/vault";
import "./taskEditor.css";
import { api } from "../../ipc/api";
import { errorMessage, isCoreError, type PlannerEpic, type PlannerTask, type PlannerTaskStatus } from "../../ipc/types";
import { useUi } from "../../state/ui";
import { PLANNER_STATUSES } from "./plannerModel";
import { ActivityTimeline } from "./ActivityTimeline";

export function TaskEditor({
  task,
  epics,
  tasks,
  onChanged,
  onClose,
  onReload,
}: {
  task: PlannerTask;
  epics: PlannerEpic[];
  tasks: PlannerTask[];
  onChanged(task: PlannerTask | null): void;
  onClose(): void;
  onReload(): void;
}) {
  const root = useVault((state) => state.vault?.root);
  const identity = `${root}/${task.id}/${task.revision}`;
  const activeIdentity = useRef(identity),
    live = useRef(true),
    writing = useRef(false),
    choosing = useRef(false);
  activeIdentity.current = identity;
  const current = () => live.current && activeIdentity.current === identity && root === useVault.getState().vault?.root;
  const titleInput = useRef<HTMLInputElement>(null),
    closeButton = useRef<HTMLButtonElement>(null);
  const [decision, setDecision] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    (titleInput.current?.disabled ? closeButton.current : titleInput.current)?.focus();
  }, [task.id]);
  const [title, setTitle] = useState(task.title),
    [description, setDescription] = useState(task.description),
    [due, setDue] = useState(task.due_date ?? ""),
    [estimate, setEstimate] = useState(task.estimate_minutes?.toString() ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [conflict, setConflict] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the form resets only when another task, or a newer revision of it, arrives
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setDue(task.due_date ?? "");
    setEstimate(task.estimate_minutes?.toString() ?? "");
    setError(null);
    setConflict(false);
  }, [task.id, task.revision]);
  const run = async (action: () => Promise<PlannerTask>, remove = false) => {
    if (writing.current || !current()) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    setConflict(false);
    const previousFocus = document.activeElement as HTMLElement | null;
    try {
      const value = await action();
      if (current()) onChanged(remove ? null : value);
    } catch (e) {
      if (current()) {
        setError(errorMessage(e));
        setConflict(isCoreError(e) && e.code === "conflict");
      }
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
      if (current())
        setTimeout(() => {
          if (
            previousFocus?.isConnected &&
            (document.activeElement === document.body || document.activeElement === previousFocus)
          )
            previousFocus.focus();
        }, 0);
    }
  };
  const decide = async (action: () => Promise<unknown>) => {
    if (choosing.current || writing.current || !current()) return;
    choosing.current = true;
    setDecision(true);
    const previousFocus = document.activeElement as HTMLElement | null;
    try {
      await action();
    } catch (reason) {
      if (current()) setError(errorMessage(reason));
    } finally {
      choosing.current = false;
      if (live.current) setDecision(false);
      if (current())
        setTimeout(() => {
          if (previousFocus?.isConnected && document.activeElement === document.body) previousFocus.focus();
        }, 0);
    }
  };
  const save = () =>
    run(() =>
      api.updatePlannerTask(task.id, {
        expected_revision: task.revision,
        title,
        description,
        due_date: due || null,
        clear_due_date: !due,
        estimate_minutes: estimate ? Number(estimate) : null,
        clear_estimate: !estimate,
      }),
    );
  const futurePolicy = async () => {
    const future = (await api.plannerWorkSessions(task.id, false)).filter(
      (session) =>
        (!session.all_day && session.start_value > new Date().toISOString()) ||
        (session.all_day && session.start_value > new Date().toISOString().slice(0, 10)),
    );
    if (!current()) return null;
    if (!future.length) return "cancel" as const;
    if (
      await useUi.getState().ask({
        title: "Cancel future work sessions?",
        body: `${future.length} future session${future.length === 1 ? "" : "s"} can be cancelled now.`,
        confirmLabel: "Cancel sessions",
      })
    )
      return "cancel" as const;
    if (!current()) return null;
    if (
      await useUi.getState().ask({
        title: "Keep future work sessions?",
        body: "They will remain visible after this task is completed.",
        confirmLabel: "Keep sessions",
      })
    )
      return "keep" as const;
    return null;
  };
  const status = async (next: PlannerTaskStatus) => {
    if (next === task.status) return;
    if (next === "done") {
      const open = tasks.some((item) => item.parent_id === task.id && item.status !== "done" && !item.archived_at);
      if (
        open &&
        !(await useUi.getState().ask({
          title: "Complete task with unfinished subtasks?",
          body: "The subtasks will remain incomplete.",
          confirmLabel: "Complete task",
        }))
      )
        return;
      if (!current()) return;
      const policy = await futurePolicy();
      if (!policy || !current()) return;
      return run(() => api.completePlannerTask(task.id, task.revision, open, policy));
    }
    if (task.status === "done") {
      return run(async () => {
        const reopened = await api.reopenPlannerTask(task.id, task.revision);
        if (!current()) return reopened;
        return next === "new"
          ? reopened
          : api.movePlannerTask(reopened.id, {
              expected_revision: reopened.revision,
              epic_id: reopened.epic_id,
              parent_id: reopened.parent_id,
              status: next,
              position: reopened.position,
            });
      });
    }
    return run(() =>
      api.movePlannerTask(task.id, {
        expected_revision: task.revision,
        epic_id: task.epic_id,
        parent_id: task.parent_id,
        status: next,
        position: task.position,
      }),
    );
  };
  const moveEpic = async (epicId: string | null) => {
    let parent = task.parent_id;
    if (parent && epicId !== task.epic_id) {
      if (
        !(await useUi.getState().ask({
          title: "Promote this subtask?",
          body: "Moving it to another epic makes it a top-level task.",
          confirmLabel: "Promote and move",
        }))
      )
        return;
      parent = null;
    }
    await run(() =>
      api.movePlannerTask(task.id, {
        expected_revision: task.revision,
        epic_id: epicId,
        parent_id: parent,
        status: task.status,
        position: task.position,
      }),
    );
  };
  const archive = async () => {
    if (!(await useUi.getState().ask({ title: "Archive task?", body: task.title, confirmLabel: "Archive" }))) return;
    await run(() => api.archivePlannerTask(task.id, task.revision), true);
  };
  const trash = async () => {
    if (
      !(await useUi.getState().ask({
        title: "Delete task?",
        body: "It will move to Deleted and remain recoverable.",
        confirmLabel: "Delete",
      }))
    )
      return;
    await run(() => api.trashPlannerTask(task.id, task.revision), true);
  };
  const addSubtask = async () => {
    const title = await useUi
      .getState()
      .askText({ title: "New subtask", value: "", placeholder: `Part of ${task.title}` });
    if (!title?.trim()) return;
    await run(() =>
      api.createPlannerTask({
        epic_id: task.epic_id,
        parent_id: task.id,
        title: title.trim(),
        description: "",
        status: "new",
        due_date: null,
        estimate_minutes: null,
      }),
    );
  };
  const promote = async () => {
    if (
      !task.parent_id ||
      !(await useUi.getState().ask({
        title: "Promote subtask?",
        body: "It will become a top-level task in the same epic.",
        confirmLabel: "Promote",
      }))
    )
      return;
    await run(() =>
      api.movePlannerTask(task.id, {
        expected_revision: task.revision,
        epic_id: task.epic_id,
        parent_id: null,
        status: task.status,
        position: task.position + 1024,
      }),
    );
  };
  const reorder = (direction: -1 | 1) =>
    run(() =>
      api.movePlannerTask(task.id, {
        expected_revision: task.revision,
        epic_id: task.epic_id,
        parent_id: task.parent_id,
        status: task.status,
        position: task.position + direction * 1536,
      }),
    );
  const readOnly = !!task.archived_at || !!task.trashed_at;
  const disabled = busy || decision;
  return (
    <DesignSystemScope
      as="aside"
      className="planner-editor task-editor"
      aria-label={`Edit ${task.title}`}
      aria-busy={disabled}
    >
      <header>
        <h2>Task</h2>
        <IconButton ref={closeButton} label="Close task editor" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {conflict && (
        <Notice tone="warning">
          This task changed elsewhere.{" "}
          <Button disabled={disabled} onClick={onReload}>
            Reload
          </Button>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {readOnly && <Notice>{task.trashed_at ? "Deleted task" : "Archived task"}. Restore it to edit.</Notice>}
      <TextField
        ref={titleInput}
        label="Title"
        value={title}
        disabled={disabled || readOnly}
        onChange={(event) => setTitle(event.target.value)}
      />
      <TextArea
        label="Description"
        rows={5}
        value={description}
        disabled={disabled || readOnly}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Select
        label="Status"
        value={task.status}
        disabled={disabled || readOnly}
        onChange={(event) => void decide(() => status(event.target.value as PlannerTaskStatus))}
      >
        {PLANNER_STATUSES.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </Select>
      <Select
        label="Epic"
        value={task.epic_id ?? ""}
        disabled={disabled || readOnly}
        onChange={(event) => void decide(() => moveEpic(event.target.value || null))}
      >
        <option value="">Unassigned</option>
        {epics
          .filter((epic) => !epic.archived_at && !epic.trashed_at)
          .map((epic) => (
            <option value={epic.id} key={epic.id}>
              {epic.title}
            </option>
          ))}
      </Select>
      <div className="planner-editor-row">
        <TextField
          label="Due date"
          type="date"
          value={due}
          disabled={disabled || readOnly}
          onChange={(event) => setDue(event.target.value)}
        />
        <TextField
          label="Estimate (minutes)"
          type="number"
          min="0"
          value={estimate}
          disabled={disabled || readOnly}
          onChange={(event) => setEstimate(event.target.value)}
        />
      </div>
      {!readOnly && (
        <div className="planner-editor-tools">
          <Button disabled={disabled} onClick={() => void decide(addSubtask)}>
            Add subtask
          </Button>
          {task.parent_id && (
            <Button disabled={disabled} onClick={() => void decide(promote)}>
              Promote
            </Button>
          )}
          <Button disabled={disabled} aria-label="Move task earlier" onClick={() => void reorder(-1)}>
            Move earlier
          </Button>
          <Button disabled={disabled} aria-label="Move task later" onClick={() => void reorder(1)}>
            Move later
          </Button>
        </div>
      )}
      <p className="mds-hint">
        Revision {task.revision}
        {task.parent_id ? " · Subtask" : ""}
      </p>
      <ActivityTimeline kind="task" id={task.id} revision={task.revision} designSystem />
      <footer>
        {task.trashed_at ? (
          <Button disabled={disabled} onClick={() => void run(() => api.restorePlannerTask(task.id, task.revision))}>
            Restore
          </Button>
        ) : task.archived_at ? (
          <>
            <Button disabled={disabled} onClick={() => void run(() => api.restorePlannerTask(task.id, task.revision))}>
              Restore
            </Button>
            <Button variant="danger" disabled={disabled} onClick={() => void decide(trash)}>
              Delete
            </Button>
          </>
        ) : (
          <Button disabled={disabled} onClick={() => void decide(archive)}>
            Archive
          </Button>
        )}
        <Button variant="secondary" disabled={disabled || !title.trim() || readOnly} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </footer>
    </DesignSystemScope>
  );
}
