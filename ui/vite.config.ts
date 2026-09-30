import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/**
 * Serves Excalidraw's fonts from the bundle instead of its default CDN (the app never touches the
 * network). Dev: middleware. Build: emitted as assets.
 */
function excalidrawFonts(): Plugin {
  const src = path.resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  return {
    name: "excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use("/excalidraw-assets/fonts", (req, res, next) => {
        const file = path.join(src, decodeURIComponent((req.url ?? "").split("?")[0]));
        if (!file.startsWith(src) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
        res.setHeader("Content-Type", "font/woff2");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const f of files(src)) {
        this.emitFile({ type: "asset", fileName: `excalidraw-assets/fonts/${path.relative(src, f)}`, source: fs.readFileSync(f) });
      }
    },
  };
}

// Tauri expects a fixed port and no browser auto-open.
export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 5000 },
});
