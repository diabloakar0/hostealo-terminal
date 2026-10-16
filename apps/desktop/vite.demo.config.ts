import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { remFontSizes } from "./remFontSizes";

// The interactive demo for hostealo.es/terminal: the app on a pretend backend, as static files
// served from /terminal/demo/ (relative paths, so any folder works).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: { postcss: { plugins: [remFontSizes()] } },
  base: "./",
  build: {
    outDir: resolve(__dirname, "../../website/terminal/public/terminal/demo"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { index: resolve(__dirname, "demo.html") } },
  },
});
