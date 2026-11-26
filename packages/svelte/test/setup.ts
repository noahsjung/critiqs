// Tests run Critiqs.svelte as a browser would: a DOM, and .svelte files
// compiled for the client (run with `--conditions browser`, so `svelte`
// resolves to its client build). A test file that sets
// `globalThis.svelteGenerate = "server"` before importing components gets
// them compiled for the server instead; `--isolate` keeps each file's modules
// its own.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { compile, compileModule } from "svelte/compiler";

GlobalRegistrator.register();

declare global {
  var svelteGenerate: "client" | "server" | undefined;
}
const generate = () => globalThis.svelteGenerate ?? "client";

plugin({
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const { js } = compile(await Bun.file(path).text(), { filename: path, generate: generate() });
      return { contents: js.code, loader: "js" };
    });
    build.onLoad({ filter: /\.svelte\.js$/ }, async ({ path }) => {
      const { js } = compileModule(await Bun.file(path).text(), { filename: path, generate: generate() });
      return { contents: js.code, loader: "js" };
    });
  },
});
