/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { transformAsync } from "@babel/core";
import babelIstanbul from "babel-plugin-istanbul";
import fs from "node:fs";
import path from "node:path";

/**
 * Serves Excalidraw's fonts from the bundle instead of its default CDN (the app never touches the
 * network). Dev: middleware. Build: emitted as assets.
 */
function excalidrawFonts(): Plugin {
  const src = path.resolve(import.meta.dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
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
        this.emitFile({
          type: "asset",
          fileName: `excalidraw-assets/fonts/${path.relative(src, f)}`,
          source: fs.readFileSync(f),
        });
      }
    },
  };
}

/** Instruments original TS/TSX before Vite creates different client and SSR transforms. */
function coverageInstrumentation(): Plugin {
  return {
    name: "mosaic:coverage",
    enforce: "pre",
    async transform(code, id) {
      if (process.env.VITE_COVERAGE !== "true") return;
      const filename = id.split("?", 1)[0];
      const sourceRoot = `${path.resolve(import.meta.dirname, "src")}${path.sep}`;
      if (
        !filename.startsWith(sourceRoot) ||
        !/\.[jt]sx?$/.test(filename) ||
        /\.test\.[jt]sx?$/.test(filename) ||
        filename.endsWith("/ipc/bindings.ts")
      )
        return;
      const transformed = await transformAsync(code, {
        filename,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        inputSourceMap: this.getCombinedSourcemap(),
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[babelIstanbul, { cwd: import.meta.dirname }]],
      });
      if (!transformed?.code) return;
      return { code: transformed.code, map: transformed.map ? JSON.stringify(transformed.map) : undefined };
    },
  };
}

// Tauri expects a fixed port and no browser auto-open.
export default defineConfig({
  plugins: [coverageInstrumentation(), react(), excalidrawFonts()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 5000 },
  // e2e/ holds Playwright flows (pnpm e2e), not Vitest tests.
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/coverage.ts"],
    coverage: {
      // Istanbul is shared with instrumented browser journeys so both suites merge against the
      // same statement, branch and function map instead of double-counting incompatible maps.
      provider: "istanbul",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/ipc/bindings.ts"],
      reporter: ["text", "json", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      // Keep the all-source baseline from regressing and raise these floors as component and
      // workflow coverage grows.
      thresholds: { lines: 29, statements: 29, branches: 25, functions: 24 },
    },
  },
});
