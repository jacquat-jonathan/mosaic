import { useWorkspace, type Buffer } from "../state/workspace";

/** Minimal text editor; replaced per kind by richer editors. */
export function PlainEditor({ buffer }: { buffer: Buffer }) {
  return (
    <textarea
      className="plain-editor"
      spellCheck={false}
      value={buffer.content ?? ""}
      onChange={(e) => useWorkspace.getState().edit(buffer.path, e.target.value)}
    />
  );
}
