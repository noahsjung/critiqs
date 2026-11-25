import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The pilot runs the component from source, so it works without building the package first.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "critiqs-react": fileURLToPath(new URL("../../packages/react/src/index.ts", import.meta.url)) } },
});
