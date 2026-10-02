// File history: the versions Mosaic kept of a file, each compared with the file as it is now, and
// restorable in one click (see crates/mosaic-core/src/history.rs).

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { api } from "../ipc/api";
import { errorMessage, type Version } from "../ipc/types";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";
import { diffLines } from "../diff";
import { ago } from "../time";
import { what, who } from "./history";

export function HistoryModal() {
  const spec = useUi((s) => s.history);
  if (!spec) return null;
  return <History key={spec.path} path={spec.path} focus={spec.focus} />;
}

function History({ path, focus }: { path: string; focus?: number }) {
  const close = useUi((s) => s.closeHistory);
  const revision = useVault((s) => s.revision);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<number | null>(focus ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ text: string; hash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    api.fileHistory(path).then(
      (vs) => {
        setVersions(vs);
        setSelected((sel) => sel ?? vs.find((v) => v.action !== "renamed")?.id ?? null);
      },
      (e) => setError(errorMessage(e)),
    );
    api.read(path).then(
      (f) => setCurrent({ text: f.content ?? "", hash: f.hash }),
      () => setCurrent(null),
    );
  }, [path, revision, restored]);

  useEffect(() => {
    setContent(null);
    if (selected !== null) api.versionContent(selected).then(setContent, (e) => setError(errorMessage(e)));
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const lines = useMemo(() => (content === null ? null : diffLines(content, current?.text ?? "")), [content, current]);
  const same = content !== null && current !== null && content === current.text;
  const chosen = versions?.find((v) => v.id === selected);

  const restore = async () => {
    if (selected === null) return;
    setError(null);
    try {
      await api.restoreVersion(path, selected, current?.hash ?? null);
      setRestored((r) => !r);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const name = path.split("/").pop()!.replace(/\.md$/, "");
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal history" role="dialog" aria-label={`History of ${name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-head">
          <h2>History of “{name}”</h2>
          <button className="icon" aria-label="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>
        {versions && versions.length === 0 && (
          <p className="settings-note">No versions yet. Mosaic keeps one each time this file is changed by you, the command line or an AI agent.</p>
        )}
        {versions && versions.length > 0 && (
          <div className="history-body">
            <ul className="history-list" role="listbox">
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    role="option"
                    aria-selected={v.id === selected}
                    className={v.id === selected ? "selected" : ""}
                    disabled={v.action === "renamed"}
                    onClick={() => setSelected(v.id)}
                  >
                    <span className="history-when">{ago(v.time)}</span>
                    <span className={`history-who source-${v.source}`}>{who(v)}</span>
                    <span className="history-what">{what(v)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="history-diff">
              {chosen && (
                <p className="settings-note">
                  {current ? "From this version to the file as it is now: red lines would come back, green lines would go." : "The file doesn't exist now (it was deleted or moved). Restore brings this version back."}
                </p>
              )}
              {same && <p className="ok-text">This version is the same as the file now.</p>}
              {lines && !same && (
                <pre className="diff">
                  {lines.map((l, i) => (
                    <div key={i} className={`diff-${l.op}`}>
                      <span className="diff-sign">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
                      {l.text || " "}
                    </div>
                  ))}
                </pre>
              )}
            </div>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button onClick={close}>Close</button>
          <button className="primary" disabled={selected === null || same || content === null} onClick={() => void restore()}>
            <RotateCcw size={14} /> Restore this version
          </button>
        </div>
      </div>
    </div>
  );
}
