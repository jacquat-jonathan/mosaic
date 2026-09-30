import { useEffect, useState } from "react";
import { useWorkspace, type Buffer } from "../state/workspace";
import { api } from "../ipc/api";
import { diffLines, type DiffLine } from "../diff";

/** Shown when disk and an open buffer disagree; never resolves anything silently. */
export function ConflictBar({ buffer }: { buffer: Buffer }) {
  const ws = useWorkspace.getState;
  const [comparing, setComparing] = useState(false);
  if (buffer.deleted && buffer.dirty) {
    return (
      <div className="notice warn" role="alert">
        <span>This file was deleted on disk, but you have unsaved changes.</span>
        <button onClick={() => void ws().keepMine(buffer.path)}>Save my version</button>
        <button onClick={() => ws().deleted(buffer.path)}>Discard</button>
      </div>
    );
  }
  if (buffer.conflict) {
    return (
      <>
        <div className="notice warn" role="alert">
          <span>This file changed on disk while you were editing it.</span>
          <button onClick={() => setComparing(true)}>Compare</button>
          <button onClick={() => void ws().reload(buffer.path)}>Load disk version</button>
          <button onClick={() => void ws().keepMine(buffer.path)}>Keep mine</button>
        </div>
        {comparing && <CompareModal buffer={buffer} onClose={() => setComparing(false)} />}
      </>
    );
  }
  if (buffer.error && buffer.content !== null) {
    return (
      <div className="notice error" role="alert">
        <span>Couldn't save: {buffer.error}</span>
        <button onClick={() => void ws().save(buffer.path)}>Retry</button>
      </div>
    );
  }
  return null;
}

function CompareModal({ buffer, onClose }: { buffer: Buffer; onClose(): void }) {
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  useEffect(() => {
    api.read(buffer.path).then(
      (disk) => setLines(diffLines(disk.content ?? "", buffer.content ?? "")),
      () => setLines([]),
    );
  }, [buffer.path, buffer.content, buffer.conflict]);
  const ws = useWorkspace.getState;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal compare" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Disk version → your version</h2>
        <p>Lines only on disk are red; lines only in your unsaved version are green.</p>
        <pre className="diff">
          {lines?.map((l, i) => (
            <div key={i} className={`diff-${l.op}`}>
              <span className="diff-sign">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
              {l.text || " "}
            </div>
          ))}
        </pre>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <button onClick={() => { onClose(); void ws().reload(buffer.path); }}>Load disk version</button>
          <button className="primary" onClick={() => { onClose(); void ws().keepMine(buffer.path); }}>Keep mine</button>
        </div>
      </div>
    </div>
  );
}
