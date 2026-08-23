import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  // The service worker reads this at install time so the first installed shell includes Vite's
  // hashed JavaScript and CSS, not only the stable files copied from public/.
  build: { manifest: "vite-manifest.json" },
  plugins: [react()],
});
