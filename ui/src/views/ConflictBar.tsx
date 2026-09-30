import { useWorkspace, type Buffer } from "../state/workspace";

/** Shown when disk and an open buffer disagree; never resolves anything silently. */
export function ConflictBar({ buffer }: { buffer: Buffer }) {
  const ws = useWorkspace.getState;
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
      <div className="notice warn" role="alert">
        <span>This file changed on disk while you were editing it.</span>
        <button onClick={() => void ws().reload(buffer.path)}>Load disk version</button>
        <button onClick={() => void ws().keepMine(buffer.path)}>Keep mine</button>
      </div>
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
