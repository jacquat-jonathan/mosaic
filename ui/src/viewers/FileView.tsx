import { ExternalLink } from "lucide-react";
import { useWorkspace, type Buffer } from "../state/workspace";
import { MarkdownEditor } from "./MarkdownEditor";
import { CodeEditor } from "./CodeEditor";
import { ImageViewer } from "./ImageViewer";
import { HtmlViewer } from "./HtmlViewer";
import { PdfViewer } from "./PdfViewer";
import { CsvEditor } from "./CsvEditor";
import { ConflictBar } from "../views/ConflictBar";
import { openInDefaultApp } from "../ipc/api";

/** Picks the viewer or editor for a file by its kind. */
export function FileView({ path }: { path: string }) {
  const buffer = useWorkspace((s) => s.buffers[path]);
  if (!buffer) return <div className="empty"><p>Loading…</p></div>;
  return (
    <div className="file-view">
      <ConflictBar buffer={buffer} />
      {buffer.error && !buffer.deleted && buffer.content === null && buffer.kind === "other" ? (
        <Unsupported path={path} message={buffer.error} />
      ) : (
        <Viewer buffer={buffer} />
      )}
    </div>
  );
}

export function viewerFor(buffer: Buffer) {
  return <Viewer buffer={buffer} />;
}

function Viewer({ buffer }: { buffer: Buffer }) {
  switch (buffer.kind) {
    case "markdown":
      return <MarkdownEditor buffer={buffer} />;
    case "html":
      return <HtmlViewer buffer={buffer} />;
    case "csv":
      return <CsvEditor buffer={buffer} />;
    case "text":
      return <CodeEditor buffer={buffer} wrap />;
    case "image":
      return <ImageViewer path={buffer.path} />;
    case "pdf":
      return <PdfViewer path={buffer.path} />;
    case "other":
      return <Unsupported path={buffer.path} message="Mosaic has no viewer for this file type." />;
    default:
      return <CodeEditor buffer={buffer} />;
  }
}

function Unsupported({ path, message }: { path: string; message: string }) {
  return (
    <div className="empty">
      <p>{message}</p>
      <p>
        <button className="primary" onClick={() => void openInDefaultApp(path)}>
          <ExternalLink size={14} /> Open in default app
        </button>
      </p>
    </div>
  );
}
