import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The standalone server's root should open the gallery, including in built previews.
function galleryEntry(): Plugin {
  const redirect: import("vite").Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/" && url.pathname !== "/index.html") return next();
    response.writeHead(302, { Location: `/design-system.html${url.search}` });
    response.end();
  };
  return {
    name: "mosaic:gallery-entry",
    configureServer(server) {
      server.middlewares.use(redirect);
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirect);
    },
  };
}

// Separate entry and output: the application build does not include the review gallery.
export default defineConfig({
  plugins: [galleryEntry(), react()],
  server: { port: 1421, strictPort: true },
  build: {
    target: "safari15",
    outDir: "dist/design-system",
    rollupOptions: { input: "design-system.html" },
  },
});
