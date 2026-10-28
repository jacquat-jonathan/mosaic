import { useEffect, useId, useRef, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { Badge, Button, Notice, SettingRow } from "../design-system/components";
import { api, openExternal } from "../ipc/api";
import { errorMessage, type UpdateCheck, type UpdateStatus } from "../ipc/types";
import { renderInlineMarkdown } from "../markdown";
import { leaveAllDrafts } from "../state/drafts";
import { useUpdateFlow } from "../state/updates";
import { useWorkspace } from "../state/workspace";
import { DesignSystemScope } from "./DesignSystemScope";
import "./aboutSettings.css";

async function saveAll(): Promise<boolean> {
  const workspace = useWorkspace.getState();
  await Promise.all(
    Object.values(workspace.buffers)
      .filter((buffer) => buffer.dirty && !buffer.conflict && !buffer.deleted)
      .map((buffer) => workspace.save(buffer.path)),
  );
  return Object.values(useWorkspace.getState().buffers).every((buffer) => !buffer.dirty);
}

export function AboutSettings() {
  return (
    <DesignSystemScope className="about-settings" role="group" aria-label="About and update preferences">
      <Updates />
    </DesignSystemScope>
  );
}
function Updates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<"cancel" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flow = useUpdateFlow();
  const logRef = useRef<HTMLPreElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const checkingRef = useRef(false);
  const acting = useRef(false);
  const returnFocus = useRef(false);
  const errorId = useId();
  useEffect(() => {
    let active = true;
    void api.updateStatus().then(
      (next) => {
        if (!active) return;
        setStatus(next);
        if (next.ready_to_install && useUpdateFlow.getState().phase === "idle")
          useUpdateFlow.setState({ phase: "built" });
        if (next.running) useUpdateFlow.setState({ phase: "running" });
      },
      (cause) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [reload]);
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [flow.log.length]);
  useEffect(() => {
    if (!action && flow.phase !== "running" && returnFocus.current) {
      checkRef.current?.focus({ preventScroll: true });
      returnFocus.current = false;
    }
  }, [action, flow.phase]);
  const runCheck = async () => {
    if (checkingRef.current || useUpdateFlow.getState().phase === "running") return;
    checkingRef.current = true;
    setChecking(true);
    setError(null);
    try {
      setCheck(await api.checkUpdates());
    } catch (cause) {
      setCheck(null);
      setError(errorMessage(cause));
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };
  const update = async () => {
    if (!status?.app_path || !check?.update_available || ["running", "built"].includes(useUpdateFlow.getState().phase))
      return;
    setError(null);
    useUpdateFlow.setState({ log: [], phase: "running", error: null });
    try {
      await api.startUpdate();
    } catch (cause) {
      useUpdateFlow.setState({ phase: "failed", error: errorMessage(cause) });
    }
  };
  const cancel = async () => {
    if (acting.current || useUpdateFlow.getState().phase !== "running") return;
    acting.current = true;
    setAction("cancel");
    setError(null);
    returnFocus.current = true;
    try {
      await api.cancelUpdate();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      acting.current = false;
      setAction(null);
    }
  };
  const restart = async () => {
    if (acting.current || useUpdateFlow.getState().phase !== "built") return;
    acting.current = true;
    setAction("restart");
    setError(null);
    try {
      if (!(await leaveAllDrafts())) return;
      if (!(await saveAll())) {
        setError("Some notes couldn't be saved. Resolve them first, then restart.");
        return;
      }
      await api.finishUpdate();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      acting.current = false;
      setAction(null);
    }
  };
  if (!status)
    return error ? (
      <Notice tone="error">
        {error}{" "}
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            setReload((value) => value + 1);
          }}
        >
          Retry update status
        </Button>
      </Notice>
    ) : (
      <Notice>Loading update status…</Notice>
    );
  const dev = status.app_path === null;
  const hasNews = !!check?.update_available;
  return (
    <>
      <SettingRow
        label={status.commit ? `Mosaic ${status.version} (${status.commit})` : `Mosaic ${status.version}`}
        hint={status.commit ? undefined : "Build commit unknown"}
      >
        <Badge>{dev ? "Development build" : status.app_path}</Badge>
      </SettingRow>
      {status.last_install_error && (
        <Notice tone="warning">The last update was downloaded but not installed: {status.last_install_error}</Notice>
      )}
      <div className="about-update-box">
        <p className="mds-hint">
          Mosaic downloads signed universal packages from GitHub Releases. Checks and downloads use HTTPS only when you
          click; there is no telemetry.
        </p>
        {dev && (
          <Notice tone="warning">
            This is a development build (pnpm dev); it can't replace itself. Use scripts/install.sh.
          </Notice>
        )}
        <div className="about-update-actions">
          <Button
            ref={checkRef}
            variant="secondary"
            disabled={checking || flow.phase === "running" || !!action}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void runCheck()}
          >
            <RefreshCw aria-hidden="true" className={checking ? "spin" : undefined} />{" "}
            {checking ? "Checking…" : "Check for updates"}
          </Button>
          {flow.phase === "running" && (
            <Button
              variant="secondary"
              disabled={!!action}
              title="Stop the download; the installed app stays as it is"
              aria-describedby={error ? errorId : undefined}
              onClick={() => void cancel()}
            >
              <X aria-hidden="true" /> {action === "cancel" ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          {flow.phase !== "built" && flow.phase !== "running" && (
            <Button
              variant="secondary"
              disabled={dev || !hasNews || checking || !!action}
              aria-describedby={error ? errorId : undefined}
              onClick={() => void update()}
            >
              <Download aria-hidden="true" /> Download update
            </Button>
          )}
          {flow.phase === "built" && (
            <Button
              variant="secondary"
              disabled={!!action}
              aria-describedby={error ? errorId : undefined}
              onClick={() => void restart()}
            >
              {action === "restart" ? "Preparing restart…" : "Restart to finish"}
            </Button>
          )}
        </div>
        {error && (
          <div id={errorId}>
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {check && (
          <section className="about-update-result" aria-label="Available releases">
            {check.releases.length > 0 && (
              <>
                <p>
                  Mosaic {check.releases[0].version} is available (you have {status.version}).
                </p>
                {check.releases.map((release) => (
                  <div key={release.version} className="about-release">
                    <h3>
                      {release.version} {release.date && <span className="mds-hint">{release.date}</span>}
                    </h3>
                    <ul>
                      {release.notes.map((note, index) => (
                        <li
                          key={index}
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderInlineMarkdown output is sanitized by DOMPurify
                          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(note) }}
                          onClick={(event) => {
                            const link = (event.target as HTMLElement).closest("a");
                            if (link) {
                              event.preventDefault();
                              void openExternal(link.href);
                            }
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
            <p>
              {hasNews
                ? "The package is verified before installation. Your vault and settings are preserved."
                : check.latest_version
                  ? "You're up to date with downloadable releases."
                  : "No complete signed downloadable release is available yet."}
            </p>
          </section>
        )}
        {flow.phase === "running" && <Notice>Downloading and verifying… You can keep working meanwhile.</Notice>}
        {flow.phase === "built" && (
          <Notice>
            The new version is ready. Restart to switch to it; unsaved notes are saved first. The previous app is
            retained for recovery.
          </Notice>
        )}
        <p className="mds-hint">
          Mosaic is ad-hoc signed, not Apple-notarized. macOS may ask you to approve it in Privacy &amp; Security.
          Mosaic never disables Gatekeeper or removes quarantine. Restart connected MCP clients after updating.
        </p>
        {flow.phase === "failed" && flow.error && <Notice tone="error">{flow.error}</Notice>}
        {flow.phase === "cancelled" && <Notice>Update cancelled. The installed app wasn't changed.</Notice>}
        {flow.log.length > 0 && (
          <details className="about-update-log" open={flow.phase !== "built"}>
            <summary>Update log</summary>
            <pre ref={logRef} role="log" aria-label="Update log" aria-live="off" tabIndex={0}>
              {flow.log.join("\n")}
            </pre>
          </details>
        )}
      </div>
    </>
  );
}
