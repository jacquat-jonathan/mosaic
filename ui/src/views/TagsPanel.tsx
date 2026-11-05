import { useEffect, useRef, useState } from "react";
import { api } from "../ipc/api";
import { errorMessage, type TagCount } from "../ipc/types";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";
import { Badge, Button, Notice } from "../design-system/components";
import { DesignSystemScope } from "./DesignSystemScope";
import "./tagsPanel.css";

export function TagsPanel() {
  const root = useVault((s) => s.vault?.root);
  const revision = useVault((s) => s.revision);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryFocus = useRef(false);
  const first = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!loading && retryFocus.current) {
      (problem ? retry.current : (first.current ?? summary.current))?.focus({ preventScroll: true });
      retryFocus.current = false;
    }
  }, [loading, problem]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setProblem(null);
    api.tags().then(
      (value) => {
        if (live) {
          setTags(value);
          setLoading(false);
        }
      },
      (cause) => {
        if (live) {
          setProblem(errorMessage(cause));
          setLoading(false);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [root, revision, attempt]);
  return (
    <DesignSystemScope className="tags-panel" role="group" aria-label="Tags" aria-busy={loading}>
      {loading ? (
        <p className="mds-hint" role="status">
          Loading tags…
        </p>
      ) : problem ? (
        <Notice tone="error">
          {problem}
          <Button
            ref={retry}
            variant="secondary"
            onClick={() => {
              retryFocus.current = true;
              setAttempt((value) => value + 1);
            }}
          >
            Retry tags
          </Button>
        </Notice>
      ) : (
        <>
          <p ref={summary} tabIndex={-1} className="mds-hint" role="status">
            {tags.length
              ? `${tags.length} ${tags.length === 1 ? "tag" : "tags"}`
              : "No tags yet. Add #tags to your notes."}
          </p>
          <div className="tags-list" role="list" aria-label="Note tags">
            {tags.map((tag, index) => (
              <div key={tag.tag} role="listitem">
                <Button
                  ref={index === 0 ? first : undefined}
                  className="tag-row"
                  aria-label={`Search #${tag.tag} · ${tag.count} ${tag.count === 1 ? "note" : "notes"}`}
                  onClick={() => useUi.getState().showSearch(`tag:${tag.tag}`)}
                >
                  <span className="tag-name">#{tag.tag}</span>
                  <Badge aria-hidden="true">{tag.count}</Badge>
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </DesignSystemScope>
  );
}
