import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { STYLES } from "./shared.ts";
import { APP_STYLES } from "./styles.ts";

// The design system's tokens and styles are scoped to `:host`, as Critiqs
// draws inside a shadow root on a prototype, so the website's app renders in
// one too.
const host = document.getElementById("root")!;
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = STYLES + APP_STYLES;
const mount = document.createElement("div");
shadow.append(style, mount);

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
