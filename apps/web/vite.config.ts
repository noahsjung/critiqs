import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Every path serves index.html, so /start and /setup/<id> both load the app.
export default defineConfig({ plugins: [react()], appType: "spa" });
