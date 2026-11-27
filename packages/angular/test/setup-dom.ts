import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Fails an equality assertion given an element before bun can print the whole page.
import "../../../scripts/element-equality-guard.ts";
// Angular's own partially compiled classes (PlatformLocation, …) compile just in time in tests.
import "@angular/compiler";

// A real origin, so the router writes the address bar as in a browser.
GlobalRegistrator.register({ url: "http://localhost:4200/" });
