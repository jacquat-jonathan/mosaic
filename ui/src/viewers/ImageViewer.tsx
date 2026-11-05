import { useEffect, useState } from "react";
import { fileUrl } from "../ipc/api";
import { errorMessage } from "../ipc/types";
import { useVault } from "../state/vault";
import { Button, Notice } from "../design-system/components";
import { DesignSystemScope } from "../views/DesignSystemScope";
import "./documentStates.css";

export function ImageViewer({ path }: { path: string }) {
  const root = useVault((s) => s.vault?.root);
  const [retry, setRetry] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    setLoaded(false);
    void fileUrl(path).then(
      (value) => {
        if (!live || useVault.getState().vault?.root !== root) return;
        setUrl(
          retry && !value.startsWith("data:")
            ? `${value}${value.includes("?") ? "&" : "?"}mosaic-retry=${retry}`
            : value,
        );
      },
      (cause) => {
        if (live && useVault.getState().vault?.root === root) setError(errorMessage(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [path, root, retry]);
  if (error)
    return (
      <DesignSystemScope className="document-state">
        <Notice tone="error">Couldn't open this image: {error}</Notice>
        <div>
          <Button variant="secondary" onClick={() => setRetry((n) => n + 1)}>
            Retry image
          </Button>
        </div>
      </DesignSystemScope>
    );
  return (
    <div className="image-preview">
      {!loaded && (
        <DesignSystemScope className="document-state">
          <Notice>Loading image…</Notice>
        </DesignSystemScope>
      )}
      {url && (
        <div
          className="image-viewer"
          role="region"
          aria-label={`Image preview: ${path}`}
          tabIndex={0}
          style={loaded ? undefined : { display: "none" }}
        >
          <img
            key={`${root}:${path}:${retry}`}
            src={url}
            alt={path}
            onLoad={() => {
              if (useVault.getState().vault?.root === root) setLoaded(true);
            }}
            onError={() => {
              if (useVault.getState().vault?.root === root) setError(path);
            }}
          />
        </div>
      )}
    </div>
  );
}
