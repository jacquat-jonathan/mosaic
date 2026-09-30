import { useEffect, useState } from "react";
import { api } from "../ipc/api";
import type { TagCount } from "../ipc/types";
import { useVault } from "../state/vault";
import { useUi } from "../state/ui";

export function TagsPanel() {
  const revision = useVault((s) => s.revision);
  const [tags, setTags] = useState<TagCount[]>([]);
  useEffect(() => {
    api.tags().then(setTags, () => setTags([]));
  }, [revision]);
  return (
    <div className="panel">
      <div className="panel-meta">{tags.length ? `${tags.length} tags` : "No tags yet. Add #tags to your notes."}</div>
      <div className="tag-list">
        {tags.map((t) => (
          <button key={t.tag} className="tag-row" onClick={() => useUi.getState().showSearch(`tag:${t.tag}`)}>
            <span className="cm-tag">#{t.tag}</span>
            <span className="tag-count">{t.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
