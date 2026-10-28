import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate entry and output: the application build does not include the review gallery.
export default defineConfig({
  plugins: [react()],
  server: { port: 1421, strictPort: true },
  build: {
    target: "safari15",
    outDir: "dist/design-system",
    rollupOptions: { input: "design-system.html" },
  },
});
