import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The package is imported by SOURCE alias: every change in ../src is live in
// the lab with no build step. The two entry points map to the two files that
// tsup builds, so the lab exercises exactly what a consumer would import.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@usepatchwork/audio/visualizers", replacement: fileURLToPath(new URL("../src/visualizers.ts", import.meta.url)) },
      { find: "@usepatchwork/audio", replacement: fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: true,
    port: 5800,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
});
