import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findCritiqsElements, findSourceFiles, isValidProjectId, planProjectId, runInit } from "../bin/init.mjs";

const ID = "k57a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";
const IMPORT = 'import { Critiqs } from "critiqs-react";\n';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "critiqs-init-"));
  directories.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function run(dir: string, ...args: string[]) {
  const messages: string[] = [];
  const code = runInit(["init", ID, ...args], { cwd: dir, print: (message) => messages.push(message) });
  return { code, output: messages.join("\n") };
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

test("project IDs are Convex document IDs", () => {
  expect(isValidProjectId(ID)).toBe(true);
  expect(isValidProjectId("short")).toBe(false);
  expect(isValidProjectId("K57A2B3C4D5E6F7G8H9J0K1M2N3P4Q5R")).toBe(false);
  expect(isValidProjectId("k57a2b3c-4d5e-6f7g-8h9j")).toBe(false);
  const messages: string[] = [];
  expect(runInit(["init", "nope"], { cwd: project({}), print: (message) => messages.push(message) })).toBe(2);
  expect(messages.join("")).toContain('"nope" is not a Critiqs project ID');
});

test("inserts the project ID right after <Critiqs", () => {
  const app = `${IMPORT}export function App() {\n  return (\n    <main>\n      <Routes />\n      <Critiqs version="1.2" />\n    </main>\n  );\n}\n`;
  const dir = project({ "src/App.tsx": app });
  const { code, output } = run(dir);
  expect(code).toBe(0);
  expect(output).toBe("Set the project ID in src/App.tsx:6.");
  expect(read(dir, "src/App.tsx")).toBe(app.replace("<Critiqs version", `<Critiqs projectId="${ID}" version`));
});

test("replaces a string literal value, keeping its quotes", () => {
  const cases = [
    [`<Critiqs projectId="old" />`, `<Critiqs projectId="${ID}" />`],
    [`<Critiqs projectId='old' />`, `<Critiqs projectId='${ID}' />`],
    [`<Critiqs projectId={"old"} />`, `<Critiqs projectId={"${ID}"} />`],
    [`<Critiqs projectId={ 'old' } />`, `<Critiqs projectId={ '${ID}' } />`],
    [`<Critiqs projectId={\`old\`} />`, `<Critiqs projectId={\`${ID}\`} />`],
    [`<Critiqs projectId />`, `<Critiqs projectId="${ID}" />`],
  ];
  for (const [before, after] of cases) {
    const dir = project({ "App.jsx": `${IMPORT}export const App = () => ${before};\n` });
    expect(run(dir).code).toBe(0);
    expect(read(dir, "App.jsx")).toBe(`${IMPORT}export const App = () => ${after};\n`);
  }

  const dir = project({ "App.tsx": `${IMPORT}export const App = () => <Critiqs projectId="${ID}" />;\n` });
  expect(run(dir)).toEqual({ code: 0, output: "App.tsx:2 already uses this project ID." });
});

test("does not edit a project ID that comes from code", () => {
  for (const value of ["{import.meta.env.VITE_CRITIQS_PROJECT}", "{`${prefix}x`}", "{id ?? 'fallback'}"]) {
    const app = `${IMPORT}export const App = () => <Critiqs\n  projectId=${value}\n/>;\n`;
    const dir = project({ "App.tsx": app });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("App.tsx:3 sets projectId from code");
    expect(output).toContain(ID);
    expect(read(dir, "App.tsx")).toBe(app);
  }
});

test("handles multi-line props with nested braces, strings, and arrow functions", () => {
  const app = `${IMPORT}
export function App() {
  const label = "<Critiqs inside a string />";
  return (
    <Layout>
      {items.length > 0 && <List items={items} />}
      <Critiqs
        backend={{ url: "https://example.convex.cloud", headers: { "x-a": "}" } }}
        version="1.2"
        getContext={() => ({ screen: route.name, record: { id: user?.id ?? "{none}" } })}
        restoreContext={async (context) => {
          if (context.screen === "users" && /<\\/a>/.test(path)) await navigate(\`/users/\${context.record}\`);
        }}
        label={<span className="hint">Don't panic</span>}
      >
        <p>Text with an apostrophe's and a // slash</p>
      </Critiqs>
    </Layout>
  );
}
`;
  const dir = project({ "src/App.tsx": app });
  const [element] = findCritiqsElements(app);
  expect(findCritiqsElements(app)).toHaveLength(1);
  expect(element?.attributes.map((attribute) => attribute.name)).toEqual([
    "backend",
    "version",
    "getContext",
    "restoreContext",
    "label",
  ]);
  expect(run(dir).code).toBe(0);
  expect(read(dir, "src/App.tsx")).toBe(app.replace("<Critiqs\n", `<Critiqs projectId="${ID}"\n`));
});

test("ignores other components, files without the import, and comments", () => {
  const dir = project({
    "src/providers.tsx": `import { CritiqsProvider } from "critiqs-react";\nexport const P = () => <CritiqsProvider><Critiqs.Item /></CritiqsProvider>;\n`,
    "src/other.tsx": `import { Critiqs } from "./local-critiqs";\nexport const O = () => <Critiqs />;\n`,
    "src/commented.tsx": `// import { Critiqs } from "critiqs-react";\nexport const C = () => <Critiqs />;\n`,
    "src/App.tsx": `${IMPORT}export const App = () => (\n  <>\n    {/* <Critiqs projectId="old" /> */}\n    {/*\n      <Critiqs />\n    */}\n    <Critiqs />\n  </>\n);\n// <Critiqs />\n/* <Critiqs /> */\n`,
  });
  const { code, output } = run(dir);
  expect(code).toBe(0);
  expect(output).toBe("Set the project ID in src/App.tsx:8.");
  expect(read(dir, "src/App.tsx")).toContain(`    <Critiqs projectId="${ID}" />\n`);
  expect(read(dir, "src/App.tsx")).toContain(`{/* <Critiqs projectId="old" /> */}`);
});

test("skips dependencies, build output, and dot-directories", () => {
  const usage = `${IMPORT}export const X = () => <Critiqs />;\n`;
  const dir = project({
    "node_modules/pkg/index.js": usage,
    "dist/app.js": usage,
    "build/app.jsx": usage,
    ".next/app.js": usage,
    ".cache/app.tsx": usage,
    "coverage/app.js": usage,
    "src/App.tsx": usage,
    "src/styles.css": usage,
  });
  expect(findSourceFiles(dir).map((file) => file.slice(dir.length + 1))).toEqual(["src/App.tsx"]);
});

test("prints the snippet when there is no Critiqs component", () => {
  const dir = project({ "src/App.tsx": `export const App = () => <main />;\n` });
  const { code, output } = run(dir, "--dir", "src");
  expect(code).toBe(1);
  expect(output).toContain(`No <Critiqs /> component found in src.`);
  expect(output).toContain(`<Critiqs projectId="${ID}" />`);
});

test("lists several Critiqs components without editing them", () => {
  const usage = `${IMPORT}export const X = () => <Critiqs />;\n`;
  const dir = project({ "a/App.tsx": usage, "b/App.tsx": usage });
  const { code, output } = run(dir);
  expect(code).toBe(1);
  expect(output).toContain("Found 2 <Critiqs /> components, so nothing was changed:\n  a/App.tsx:2\n  b/App.tsx:2");
  expect(read(dir, "a/App.tsx")).toBe(usage);
  expect(read(dir, "b/App.tsx")).toBe(usage);
});

test("a dry run reports the change without writing it", () => {
  const app = `${IMPORT}export const App = () => <Critiqs projectId="old" />;\n`;
  const dir = project({ "App.tsx": app });
  const { code, output } = run(dir, "--dry-run");
  expect(code).toBe(0);
  expect(output).toBe("Would set the project ID in App.tsx:2 (dry run, nothing written).");
  expect(read(dir, "App.tsx")).toBe(app);
});

test("plans keep the rest of the file byte-for-byte", () => {
  const source = `﻿${IMPORT.replace("\n", "\r\n")}export const App = () =>\r\n\t<Critiqs\tversion="1"/>;\r\n`;
  const [element] = findCritiqsElements(source);
  if (element === undefined) throw new Error("expected a Critiqs element");
  const plan = planProjectId(source, element, ID);
  expect(plan).toEqual({
    action: "insert",
    line: 3,
    source: source.replace("<Critiqs\t", `<Critiqs projectId="${ID}"\t`),
  });
});

test("TypeScript generics and comparisons are not mistaken for JSX", () => {
  const source = `${IMPORT}const pick = <T extends object>(value: T) => value;\nconst less = a < b && c > d;\nconst list: Array<string> = [];\nexport const App = () => <Critiqs />;\n`;
  expect(findCritiqsElements(source).map((element) => element.line)).toEqual([5]);
  expect(findCritiqsElements(source, { jsx: false })).toEqual([]);
});

test("the CLI runs under Node", () => {
  const dir = project({ "App.tsx": `${IMPORT}export const App = () => <Critiqs />;\n` });
  const cli = join(import.meta.dir, "../bin/critiqs.mjs");
  const help = Bun.spawnSync(["node", cli, "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("critiqs init <projectId>     Write an existing project's ID into the prototype");
  const init = Bun.spawnSync(["node", cli, "init", ID, "--dir", dir]);
  expect(init.exitCode).toBe(0);
  expect(read(dir, "App.tsx")).toContain(`<Critiqs projectId="${ID}" />`);
});

test("an import written inside a string does not count", () => {
  const source = `const docs = 'import { Critiqs } from "critiqs-react"';\nexport const App = () => <Critiqs />;\n`;
  expect(findCritiqsElements(source)).toEqual([]);
});

test("with spread props, the ID goes after the last spread so it wins", () => {
  const source = `import { Critiqs } from "critiqs-react";\nexport const App = (props) => <Critiqs {...props} />;\n`;
  const [element] = findCritiqsElements(source);
  const plan = planProjectId(source, element!, ID);
  expect(plan.action === "insert" && plan.source).toContain(`<Critiqs {...props} projectId="${ID}" />`);
});

test("a projectId before spread props is left alone, since they could override it", () => {
  const before = `import { Critiqs } from "critiqs-react";\nexport const A = (p) => <Critiqs projectId="old" {...p} />;\n`;
  expect(planProjectId(before, findCritiqsElements(before)[0]!, ID).action).toBe("spread");
  const after = `import { Critiqs } from "critiqs-react";\nexport const B = (p) => <Critiqs {...p} projectId="old" />;\n`;
  expect(planProjectId(after, findCritiqsElements(after)[0]!, ID).action).toBe("replace");
});

test("an import written in a JSX attribute or text does not count", () => {
  const attribute = `import { Critiqs } from "./local";\nexport const A = () => <Critiqs title='import { Critiqs } from "critiqs-react"' />;\n`;
  expect(findCritiqsElements(attribute)).toEqual([]);
  const text = `import { Critiqs } from "./local";\nexport const B = () => <p>Use import { Critiqs } from "critiqs-react" here <Critiqs /></p>;\n`;
  expect(findCritiqsElements(text)).toEqual([]);
});

test("an import written on its own line of JSX text does not count", () => {
  const source = `import { Critiqs } from "./local";\nexport const C = () => (\n  <p>\nimport { Critiqs } from "critiqs-react"\n    <Critiqs />\n  </p>\n);\n`;
  expect(findCritiqsElements(source)).toEqual([]);
});

test("a TypeScript generic before the import does not hide it", () => {
  const source = `const pick = <T extends object>(value: T) => value;\nimport { Critiqs } from "critiqs-react";\nexport const App = () => <Critiqs />;\n`;
  expect(findCritiqsElements(source).map((element) => element.line)).toEqual([3]);
});

// Adding <Critiqs /> where the app renders, when the code has none

const VITE_MAIN = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;

test("adds Critiqs inside a Vite app's root, keeping its quotes and other code", () => {
  const dir = project({ "src/main.tsx": VITE_MAIN, "src/App.tsx": "export default function App() { return <main />; }\n" });
  const { code, output } = run(dir);
  expect(code).toBe(0);
  expect(output).toContain("(React root), importing it from critiqs-react:");
  expect(read(dir, "src/main.tsx")).toBe(
    VITE_MAIN.replace("import App from './App.tsx'\n", "import { Critiqs } from 'critiqs-react'\nimport App from './App.tsx'\n")
      .replace("<StrictMode>", "<><StrictMode>")
      .replace("</StrictMode>", `</StrictMode><Critiqs projectId="${ID}" /></>`),
  );
  expect(read(dir, "src/App.tsx")).toBe("export default function App() { return <main />; }\n");
  // Running again changes nothing.
  expect(run(dir)).toMatchObject({ code: 0, output: expect.stringContaining("already uses this project ID.") });
});

test("adds Critiqs beside a Create React App or legacy ReactDOM.render root", () => {
  const legacy = `import React from "react";\nimport ReactDOM from "react-dom";\nimport App from "./App";\n\nReactDOM.render(<App />, document.getElementById("root"));\n`;
  const dir = project({ "src/index.js": legacy });
  expect(run(dir).code).toBe(0);
  expect(read(dir, "src/index.js")).toBe(
    legacy
      .replace('import App from "./App";\n', 'import { Critiqs } from "critiqs-react";\nimport App from "./App";\n')
      .replace("render(<App />,", `render(<><App /><Critiqs projectId="${ID}" /></>,`),
  );
  const cra = `import ReactDOM from 'react-dom/client';\nimport App from './App';\nconst root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n`;
  const craDir = project({ "src/index.jsx": cra });
  expect(run(craDir).code).toBe(0);
  expect(read(craDir, "src/index.jsx")).toContain(`<><React.StrictMode>\n    <App />\n  </React.StrictMode><Critiqs projectId="${ID}" /></>`);
});

test("adds Critiqs to a Next.js root layout's body, keeping it a server component", () => {
  const layout = `import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n`;
  const dir = project({ "app/layout.tsx": layout, "app/page.tsx": "export default function Page() { return <h1>Hi</h1>; }\n", "app/blog/layout.tsx": layout });
  const { code, output } = run(dir);
  expect(code).toBe(0);
  expect(output).toContain("(Next.js root layout)");
  const edited = read(dir, "app/layout.tsx");
  expect(edited).toContain(`        {children}\n        <Critiqs projectId="${ID}" />\n      </body>`);
  expect(edited).not.toContain("use client");
  expect(read(dir, "app/blog/layout.tsx")).toBe(layout);
  const src = project({ "src/app/layout.jsx": layout.replace(": { children: React.ReactNode }", "") });
  expect(run(src).code).toBe(0);
});

test("adds Critiqs beside a Next.js custom App's page", () => {
  const custom = `import type { AppProps } from "next/app";\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />;\n}\n`;
  const dir = project({ "pages/_app.tsx": custom, "pages/index.tsx": "export default function Home() { return <main />; }\n" });
  expect(run(dir).code).toBe(0);
  expect(read(dir, "pages/_app.tsx")).toContain(`return <><Component {...pageProps} /><Critiqs projectId="${ID}" /></>;`);
});

test("server-rendered roots, and a chosen entry and element for custom apps", () => {
  const hydrate = `import { hydrateRoot } from "react-dom/client";\nimport { App } from "./App";\n\nhydrateRoot(document.getElementById("root")!, <App />);\n`;
  const client = project({ "src/entry-client.tsx": hydrate });
  expect(run(client).code).toBe(0);
  expect(read(client, "src/entry-client.tsx")).toContain(`<><App /><Critiqs projectId="${ID}" /></>`);

  const shell = `"use client";\n\nexport function Shell() {\n  return (\n    <div>\n      <Header />\n      <Outlet />\n    </div>\n  );\n}\n`;
  const custom = project({ "src/Shell.tsx": shell });
  // Nothing recognizable without a choice, and the manual fallback says how to choose.
  const unchosen = run(custom);
  expect(unchosen.code).toBe(1);
  expect(unchosen.output).toContain("--entry <file>");
  expect(run(custom, "--entry", "src/Shell.tsx").output).toContain("--mount <Element>");
  expect(run(custom, "--entry", "src/missing.tsx")).toMatchObject({ code: 2, output: expect.stringContaining("is not a file") });
  const dry = run(custom, "--entry", "src/Shell.tsx", "--mount", "Outlet", "--dry-run");
  expect(dry.code).toBe(0);
  expect(dry.output).toContain("Would add <Critiqs /> to src/Shell.tsx");
  expect(dry.output).toContain(`+       <><Outlet /><Critiqs projectId="${ID}" /></>`);
  expect(read(custom, "src/Shell.tsx")).toBe(shell);
  expect(run(custom, "--entry", "src/Shell.tsx", "--mount", "Outlet").code).toBe(0);
  expect(read(custom, "src/Shell.tsx")).toBe(
    shell.replace('"use client";\n', `"use client";\nimport { Critiqs } from "critiqs-react";\n`).replace("<Outlet />", `<><Outlet /><Critiqs projectId="${ID}" /></>`),
  );
});

test("refuses, changing nothing, when where to add Critiqs is unclear", () => {
  const main = `import { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(<App />);\n`;
  // Two apps' roots.
  const two = project({ "a/main.tsx": main, "b/main.tsx": main });
  const several = run(two);
  expect(several.code).toBe(1);
  expect(several.output).toContain("Found 2 places the app could render Critiqs, so nothing was changed:\n  a/main.tsx:2 (React root)\n  b/main.tsx:2 (React root)");
  expect(read(two, "a/main.tsx")).toBe(main);
  // Critiqs used under another name or re-exported: adding one would make two.
  for (const other of [
    `import { Critiqs as Feedback } from "critiqs-react";\nexport const F = () => <Feedback />;\n`,
    `export { Critiqs } from "critiqs-react";\n`,
    `import * as critiqs from "critiqs-react";\nexport const F = () => <critiqs.Critiqs />;\n`,
  ]) {
    const dir = project({ "src/main.tsx": main, "src/feedback.tsx": other });
    expect(run(dir).output).toContain("uses Critiqs under another name or loads it another way");
    expect(read(dir, "src/main.tsx")).toBe(main);
  }
  // The name Critiqs already means something else in the root's file.
  const taken = project({ "src/main.tsx": `import { Critiqs } from "./critiqs";\n${main}` });
  expect(run(taken).output).toContain("already uses the name Critiqs for something else");
});

test("tests, stories, and fixtures aren't the app's root", () => {
  const main = `import { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(<App />);\n`;
  const dir = project({
    "src/main.tsx": main,
    "src/main.test.tsx": main,
    "src/__tests__/root.tsx": main,
    "src/Button.stories.tsx": main,
    "e2e/app.tsx": main,
  });
  expect(run(dir).output).toContain("src/main.tsx:");
  expect(read(dir, "src/main.test.tsx")).toBe(main);
});

test("a file with no imports gets the import after its directives and comments", () => {
  const source = `// Copyright\n"use client";\nReactDOM.render(<App />, root);\nimport ReactDOM from "react-dom";\n`;
  // An import below the call still counts; insert before it without splitting its declaration.
  const dir = project({ "index.jsx": source });
  expect(run(dir).code).toBe(0);
  expect(read(dir, "index.jsx")).toContain('import { Critiqs } from "critiqs-react";\nimport ReactDOM from "react-dom";');
  const plain = project({ "index.jsx": `// Copyright\n"use client";\nconst { render } = require("react-dom");\nrender(<App />, root);\n` });
  expect(run(plain).code).toBe(0);
  expect(read(plain, "index.jsx")).toBe(`// Copyright\n"use client";\nimport { Critiqs } from "critiqs-react";\n\nconst { render } = require("react-dom");\nrender(<><App /><Critiqs projectId="${ID}" /></>, root);\n`);
});

test("installing Critiqs preserves JSON import attributes at runtime", () => {
  const source = 'import { createRoot } from "react-dom/client";\nimport data from "./data.json" with { type: "json" };\ncreateRoot(document.body).render(<main>{data.name}</main>);\n';
  const dir = project({
    "main.jsx": source,
    "data.json": JSON.stringify({ name: "Host" }),
    "node_modules/react-dom/package.json": JSON.stringify({ type: "module", exports: { "./client": "./client.mjs" } }),
    "node_modules/react-dom/client.mjs": "export const createRoot = () => {};",
    "node_modules/critiqs-react/package.json": JSON.stringify({ type: "module", exports: "./index.mjs" }),
    "node_modules/critiqs-react/index.mjs": "export const Critiqs = () => {};",
  });
  expect(run(dir).code).toBe(0);
  const edited = read(dir, "main.jsx");
  expect(edited).toContain('import data from "./data.json" with { type: "json" };');
  writeFileSync(join(dir, "imports.mjs"), edited.slice(0, edited.indexOf("createRoot(document")) + "console.log(data.name);");
  const child = Bun.spawnSync(["node", "imports.mjs"], { cwd: dir });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("Host");
});

test("a non-self-closing app that ignores children still renders Critiqs as its sibling", () => {
  const dir = project({ "main.jsx": 'import { render } from "react-dom";\nrender(<App><span>Original child</span></App>, container);\n' });
  expect(run(dir).code).toBe(0);
  const edited = read(dir, "main.jsx");
  expect(edited).toContain(`<><App><span>Original child</span></App><Critiqs projectId="${ID}" /></>`);
  const code = new Bun.Transpiler({ loader: "jsx", tsconfig: { compilerOptions: { jsx: "react" } } })
    .transformSync(edited.replace(/^import[^\n]*\n/gm, ""));
  let mounted = 0;
  let markup = "";
  new Function("React", "render", "App", "Critiqs", "container", code)(
    React,
    (element: React.ReactNode) => { markup = renderToStaticMarkup(element); },
    () => React.createElement("main", null, "Host"),
    () => { mounted++; return React.createElement("i", null, "Critiqs mounted"); },
    null,
  );
  expect(mounted).toBe(1);
  expect(markup).toBe("<main>Host</main><i>Critiqs mounted</i>");
});
