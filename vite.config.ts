import { defineConfig } from "vite";
import { DEFAULT_TRIAS_PROXY_URL, DEV_TRIAS_PROXY_PATH } from "./src/data/kvv-proxy-config.ts";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  // The service worker reads this at install time so the first installed shell includes Vite's
  // hashed JavaScript and CSS, not only the stable files copied from public/.
  build: { manifest: "vite-manifest.json" },
  plugins: [react()],
  // `npm run proxy` serves the TRIAS proxy; with VITE_TRIAS_PROXY_URL=/api/ the app reads it here.
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      [DEV_TRIAS_PROXY_PATH]: {
        target: DEFAULT_TRIAS_PROXY_URL,
        changeOrigin: true,
        rewrite: (path) => path.slice(DEV_TRIAS_PROXY_PATH.length),
      },
    },
  },
});
