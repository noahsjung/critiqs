// Plain JavaScript and declarations, with no JSX: the component renders
// nothing, so its code is the same for every Solid compile mode (browser,
// server, hydration) and needs no compiler step in the app.
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
await rm(`${directory}dist`, { recursive: true, force: true });
const tsc = Bun.spawn(["bun", "run", "tsc", "-p", "tsconfig.build.json"], { cwd: directory, stdout: "inherit", stderr: "inherit" });
if ((await tsc.exited) !== 0) throw new Error("critiqs-solid's build failed.");
console.error("Built critiqs-solid.");
