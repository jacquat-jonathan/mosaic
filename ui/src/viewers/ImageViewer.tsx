import { useEffect, useState } from "react";
import { fileUrl } from "../ipc/api";

export function useFileUrl(path: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fileUrl(path).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [path]);
  return url;
}

export function ImageViewer({ path }: { path: string }) {
  const url = useFileUrl(path);
  return <div className="image-viewer">{url && <img src={url} alt={path} />}</div>;
}
