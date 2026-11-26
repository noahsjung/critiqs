import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Fails an equality assertion given an element before bun can print the whole page.
import "../../../scripts/element-equality-guard.ts";

// A site's address, so navigations change the URL as they do in a browser.
GlobalRegistrator.register({ url: "http://localhost:4321/" });
