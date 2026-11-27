import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Fails an equality assertion given an element before bun can print the whole page.
import "../../../scripts/element-equality-guard.ts";

GlobalRegistrator.register();
