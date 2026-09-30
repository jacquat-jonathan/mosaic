import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function App() {
  const [version, setVersion] = useState<string>("…");
  useEffect(() => {
    invoke<string>("core_version").then(setVersion, () => setVersion("browser"));
  }, []);
  return (
    <main className="empty">
      <h1>Mosaic</h1>
      <p>core {version}</p>
    </main>
  );
}
