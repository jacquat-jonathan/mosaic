import { useWorkspace, type Buffer } from "../state/workspace";
import { MarkdownEditor } from "./MarkdownEditor";
import { CodeEditor } from "./CodeEditor";
import { ImageViewer } from "./ImageViewer";
import { ConflictBar } from "../views/ConflictBar";

/** Picks the viewer or editor for a file by its kind. */
export function FileView({ path }: { path: string }) {
  const buffer = useWorkspace((s) => s.buffers[path]);
  if (!buffer) return <div className="empty"><p>Loading…</p></div>;
  return (
    <div className="file-view">
      <ConflictBar buffer={buffer} />
      {buffer.error && !buffer.deleted && buffer.content === null && buffer.kind === "other" ? (
        <div className="empty"><p>{buffer.error}</p></div>
      ) : (
        <Viewer buffer={buffer} />
      )}
    </div>
  );
}

function Viewer({ buffer }: { buffer: Buffer }) {
  switch (buffer.kind) {
    case "markdown":
      return <MarkdownEditor buffer={buffer} />;
    case "text":
      return <CodeEditor buffer={buffer} wrap />;
    case "image":
      return <ImageViewer path={buffer.path} />;
    case "pdf":
    case "other":
      return <div className="empty"><p>No preview for this file type yet.</p></div>;
    default:
      return <CodeEditor buffer={buffer} />;
  }
}
