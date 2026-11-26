// Critiqs the code already has decides how setup connects the app, whatever
// its framework: a React island in an Astro app keeps critiqs-react and gets
// the new project ID, and two different Critiqs packages in one app are
// refused rather than one of them chosen. A small fake Astro adapter stands in
// for the real one, beside the real React and Next.js adapters.
import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { next } from "../bin/frameworks/next.mjs";
import { react } from "../bin/frameworks/react.mjs";
import type { FrameworkAdapter, Plan, Settings, Usage } from "../bin/frameworks/types.d.mts";

const OLD = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const NEW = "k57a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";
const LAYOUT = "src/layouts/Layout.astro";
const ISLAND = "src/components/Feedback.tsx";

const depends = (root: string, name: string) => {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return name in { ...manifest.dependencies, ...manifest.devDependencies };
  } catch {
    return false;
  }
};

/** Astro: `<Critiqs />` from critiqs-astro inside `<body>` in the layout. */
const astro: FrameworkAdapter = {
  id: "astro",
  name: "Astro",
  install: { ecosystem: "npm", packages: ["critiqs-astro"] },
  detect: (root) => depends(root, "astro"),
  env: () => null,
  find(root): Usage[] {
    const file = join(root, LAYOUT);
    const source = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!source.includes("critiqs-astro")) return [];
    const id = /<Critiqs projectId="([^"]*)"/.exec(source)?.[1];
    return [{ file, line: source.slice(0, source.indexOf("<Critiqs")).split("\n").length, projectId: id === undefined ? null : { kind: "literal", value: id }, backend: null, requireProjectId: false }];
  },
  plan(root, settings: Settings): Plan {
    const file = join(root, LAYOUT);
    const original = readFileSync(file, "utf8");
    const id = "literal" in settings.projectId ? settings.projectId.literal : "";
    const tag = `<Critiqs projectId="${id}" />`;
    const source = original.includes("<Critiqs")
      ? original.replace(/<Critiqs projectId="[^"]*" \/>/, tag)
      : original.replace("---\n", '---\nimport { Critiqs } from "critiqs-astro";\n').replace("<body>\n", `<body>\n    ${tag}\n`);
    const action = source === original ? "unchanged" : original.includes("<Critiqs") ? "update" : "install";
    return { ok: true, action, writes: action === "unchanged" ? [] : [{ file, original, source }], file, line: 1, changed: action === "unchanged" ? [] : ["projectId"], preview: tag, next: [] };
  },
  manual: (settings) => `Add <Critiqs /> from critiqs-astro to ${LAYOUT} with ${JSON.stringify(settings.projectId)}.`,
};

// Detection order as in the real registry: a meta-framework before the library it builds on.
const FRAMEWORKS = [next, astro, react];
mock.module("../bin/frameworks/index.mjs", () => ({
  FRAMEWORKS,
  detectApp: (root: string) => FRAMEWORKS.find((adapter) => adapter.detect(root)) ?? null,
}));
const { runInit } = await import("../bin/init.mjs");
const { beginSetup, doctor } = await import("../bin/setup.mjs");
const { chooseWiring, readUsage } = await import("../bin/app.mjs");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder with these files; a `.git` folder makes it a repository root. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-existing-"));
  folders.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const init = (root: string, ...args: string[]) => {
  const lines: string[] = [];
  const code = runInit(["init", ...args], { cwd: root, print: (line) => void lines.push(line), env: {} });
  return { code, output: lines.join("\n") };
};
const noFetch = (async () => {
  throw new Error("A project the code already names needs no network.");
}) as unknown as typeof fetch;

const LAYOUT_SOURCE = `---\nconst { title } = Astro.props;\n---\n<html lang="en">\n  <body>\n    <slot />\n  </body>\n</html>\n`;
const ASTRO_LAYOUT = `---\nimport { Critiqs } from "critiqs-astro";\n---\n<html lang="en">\n  <body>\n    <Critiqs projectId="${OLD}" />\n    <slot />\n  </body>\n</html>\n`;
const island = (id: string) => `import { Critiqs } from "critiqs-react";\n\nexport default function Feedback() {\n  return <Critiqs projectId="${id}" />;\n}\n`;
/** An Astro app (as `npm create astro` with the React integration makes it) whose React island renders Critiqs. */
const astroWithIsland = (layout = LAYOUT_SOURCE) =>
  tree({
    "package.json": JSON.stringify({ name: "site", dependencies: { astro: "^6.0.0", "@astrojs/react": "^5.0.0", react: "^19.3.0", "react-dom": "^19.3.0", "critiqs-react": "0.3.0" } }),
    "astro.config.mjs": 'import react from "@astrojs/react";\nexport default { integrations: [react()] };\n',
    [LAYOUT]: layout,
    [ISLAND]: island(OLD),
    "src/pages/index.astro": '---\nimport Layout from "../layouts/Layout.astro";\nimport Feedback from "../components/Feedback";\n---\n<Layout title="Home"><Feedback client:load /></Layout>\n',
  });

test("a React island's Critiqs in an Astro app is the one init updates; no critiqs-astro is added", () => {
  const root = astroWithIsland();
  expect(chooseWiring(root).adapter.id).toBe("react");
  const { code, output } = init(root, NEW);
  expect(code).toBe(0);
  expect(read(root, ISLAND)).toBe(island(NEW));
  expect(read(root, LAYOUT)).toBe(LAYOUT_SOURCE);
  expect(output).toBe(`Set the project ID in ${ISLAND}:4.`);
  // A second run changes nothing.
  expect(init(root, NEW)).toEqual({ code: 0, output: `${ISLAND}:4 already uses this project ID.` });
});

test("doctor and the setup flow find the island's Critiqs and keep its project", async () => {
  const root = astroWithIsland();
  const fetchFn = (async (url: string) => {
    if (url.endsWith("/critiqs/config")) return Response.json({ signInUrl: "https://brazen-snail-591.convex.site", protocol: 5 });
    const asked = new URL(url).searchParams.get("projectId");
    return Response.json({ protocol: 5, signIn: "email", email: true, mentionEmails: {}, ...(asked === null ? {} : { project: asked === OLD ? "found" : "missing" }) });
  }) as unknown as typeof fetch;
  const checks = await doctor({ root, fetchFn, env: {} });
  expect(checks.find((check) => check.name === "Component")).toMatchObject({ status: "pass", detail: `Critiqs is set up at ${ISLAND}:4.` });
  expect(checks.find((check) => check.name === "Project")).toMatchObject({ status: "pass", detail: `${OLD} exists on this backend.` });
  const setup = await beginSetup({ root, fetchFn: noFetch, env: {} });
  expect(setup.connected).toEqual({ projectId: OLD, backendUrl: "https://brazen-snail-591.convex.cloud" });
});

test("Critiqs from two different framework packages is refused, with both named and nothing written", async () => {
  const root = astroWithIsland(ASTRO_LAYOUT);
  const { code, output } = init(root, NEW);
  expect(code).toBe(1);
  expect(output).toBe(
    `Critiqs is set up with more than one framework package, so nothing was changed:\n  critiqs-react at ${ISLAND}:4\n  critiqs-astro at ${LAYOUT}:6\nKeep one, where the app renders, then run setup again.`,
  );
  expect(read(root, LAYOUT)).toBe(ASTRO_LAYOUT);
  expect(read(root, ISLAND)).toBe(island(OLD));
  await expect(beginSetup({ root, fetchFn: noFetch, env: {} })).rejects.toThrow("Critiqs is set up with more than one framework package");
  const checks = await doctor({ root, fetchFn: noFetch, env: {} });
  expect(checks).toEqual([expect.objectContaining({ status: "fail", name: "Component", detail: expect.stringContaining(`critiqs-react at ${ISLAND}:4\n  critiqs-astro at ${LAYOUT}:6`) })]);
});

test("without Critiqs in the code, the app's framework decides where it goes", () => {
  const root = astroWithIsland();
  rmSync(join(root, ISLAND));
  const { code } = init(root, NEW);
  expect(code).toBe(0);
  expect(read(root, LAYOUT)).toContain(`<Critiqs projectId="${NEW}" />`);
});

test("adapters that read the same Critiqs are one setup: a Next.js app's component is updated", () => {
  const layout = (id: string) => `import { Critiqs } from "critiqs-react";\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Critiqs projectId="${id}" />\n      </body>\n    </html>\n  );\n}\n`;
  const root = tree({ "package.json": JSON.stringify({ name: "web", dependencies: { next: "^16.0.0", react: "^19.3.0", "react-dom": "^19.3.0", "critiqs-react": "0.3.0" } }), "app/layout.tsx": layout(OLD) });
  expect(chooseWiring(root).adapter.id).toBe("next");
  expect(init(root, NEW).code).toBe(0);
  expect(read(root, "app/layout.tsx")).toBe(layout(NEW));
});

test("an adapter that sees every Critiqs in the code connects the app; two setups it sees are still two", () => {
  // As a Vue adapter scanning every .vue file might, where a Nuxt one reads only the root component.
  const wide: FrameworkAdapter = { ...astro, id: "vue", name: "Vue", install: { ecosystem: "npm", packages: ["critiqs-vue"] }, detect: () => false, find: (root) => [...astro.find(root), ...react.find(root)] };
  FRAMEWORKS.push(wide);
  try {
    const one = astroWithIsland(ASTRO_LAYOUT);
    rmSync(join(one, ISLAND));
    expect(chooseWiring(one)).toMatchObject({ adapter: { id: "astro" }, problem: null, usages: [{ file: join(one, LAYOUT), line: 6 }] });
    const two = astroWithIsland(ASTRO_LAYOUT);
    expect(chooseWiring(two)).toMatchObject({ adapter: { id: "vue" }, problem: null, usages: [{ line: 6 }, { line: 4 }] });
    expect(readUsage(two)).toEqual({ error: `Critiqs is set up in 2 places (${LAYOUT}:6, ${ISLAND}:4), so nothing was changed. Keep one, where the app renders.` });
  } finally {
    FRAMEWORKS.pop();
  }
});

const aliased = (id: string) => `import { Critiqs as Review } from 'critiqs-react';\n\nexport default function Feedback() {\n  return <Review projectId="${id}" />;\n}\n`;

test("a React island that imports Critiqs under another name is updated; no critiqs-astro is added beside it", () => {
  const root = astroWithIsland();
  writeFileSync(join(root, ISLAND), aliased(OLD));
  expect(chooseWiring(root).adapter.id).toBe("react");
  expect(init(root, NEW)).toEqual({ code: 0, output: `Set the project ID in ${ISLAND}:4.` });
  expect(read(root, ISLAND)).toBe(aliased(NEW));
  expect(read(root, LAYOUT)).toBe(LAYOUT_SOURCE);
});

test("a critiqs-* import no adapter reads stops setup from adding a second Critiqs, naming the file", async () => {
  for (const [text, module] of [
    [`import * as critiqs from "critiqs-react";\n\nexport default function Feedback() {\n  return <critiqs.Critiqs />;\n}\n`, "critiqs-react"],
    [`import { followRouter } from "critiqs-vue/router";\nexport { followRouter };\n`, "critiqs-vue/router"],
    [`const { Critiqs } = await import("critiqs-react");\nexport default Critiqs;\n`, "critiqs-react"],
  ]) {
    const root = astroWithIsland();
    writeFileSync(join(root, ISLAND), text!);
    const { code, output } = init(root, NEW);
    expect(code).toBe(1);
    expect(output).toBe(
      `${ISLAND} already loads ${module} in a way setup can't read, so nothing was changed: adding Critiqs where the app renders would run a second one. Give that Critiqs project ${NEW} yourself, or remove it and run setup again.`,
    );
    expect(read(root, LAYOUT)).toBe(LAYOUT_SOURCE);
    expect(read(root, ISLAND)).toBe(text!);
    // The setup flow stops there before anyone signs in.
    await expect(beginSetup({ root, fetchFn: noFetch, env: {} })).rejects.toThrow(`${ISLAND} already loads ${module} in a way setup can't read`);
  }
});

test("type imports, MASK_ATTRIBUTE and a server handler from a Critiqs package aren't a Critiqs on the page", () => {
  const root = astroWithIsland();
  writeFileSync(join(root, ISLAND), `import type { CritiqsProps } from "critiqs-react";\nimport { MASK_ATTRIBUTE, type HostContext } from "critiqs-react";\nexport const mask = { [MASK_ATTRIBUTE]: "" };\nexport type P = CritiqsProps & HostContext;\n`);
  writeFileSync(join(root, "src/pages/critiqs.ts"), `import { createCritiqsHandler } from "critiqs-react/server";\nexport const ALL = createCritiqsHandler();\n`);
  expect(init(root, NEW).code).toBe(0);
  expect(read(root, LAYOUT)).toContain(`<Critiqs projectId="${NEW}" />`);
});

test("several config files for one framework stop setup, naming them, since it can't tell which one the framework uses", () => {
  const root = astroWithIsland();
  rmSync(join(root, ISLAND));
  // astro.config.mjs, which Astro loads first, already runs critiqs-astro; the adapter read astro.config.ts.
  writeFileSync(join(root, "astro.config.mjs"), 'import react from "@astrojs/react";\nimport critiqs from "critiqs-astro";\nexport default { integrations: [react(), critiqs()] };\n');
  writeFileSync(join(root, "astro.config.ts"), 'import react from "@astrojs/react";\nexport default { integrations: [react()] };\n');
  const { code, output } = init(root, NEW);
  expect(code).toBe(1);
  expect(output).toBe("This app has several astro config files (astro.config.mjs, astro.config.ts), and setup can't tell which one the framework uses, so nothing was changed. Remove the ones the app doesn't use, then run setup again.");
  expect(read(root, LAYOUT)).toBe(LAYOUT_SOURCE);
});
