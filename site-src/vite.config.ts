import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The sample app runs Critiqs from source, like examples/pilot, and sends
// /critiqs to the local self-hosted server (server.ts).
export default defineConfig({
  root: "app",
  plugins: [react()],
  resolve: {
    alias: { "critiqs-react": fileURLToPath(new URL("../packages/react/src/index.ts", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    // Keep the browser's Host header: the server only accepts same-site requests.
    proxy: { "/critiqs": { target: "http://127.0.0.1:4810", changeOrigin: false } },
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
});
