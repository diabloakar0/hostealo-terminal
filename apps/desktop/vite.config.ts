import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { remFontSizes } from "./remFontSizes";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  // Text follows the root font size (the iOS text size setting).
  css: { postcss: { plugins: [remFontSizes()] } },
  // Loaded from disk by the webview, so bundle size matters less than on the web.
  build: { chunkSizeWarningLimit: 1500 },
  // Keep Rust compiler errors visible.
  clearScreen: false,
  server: {
    // Tauri expects a fixed port.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
