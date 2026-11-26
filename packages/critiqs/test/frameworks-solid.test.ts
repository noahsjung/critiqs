// Solid setup against apps shaped like the official starters (create-solid
// 0.13: Solid 2 "basic" and "bare", SolidStart 2 "basic" and "bare", and the
// Solid 1.9 Vite template in TypeScript and JavaScript).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";
import { runInit } from "../bin/init.mjs";
import type { EnvConvention, FileWrite, Plan, Settings } from "../bin/frameworks/types.d.mts";

const solid = FRAMEWORKS.find((adapter) => adapter.id === "solid")!;

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-solid-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");
const pkg = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) => JSON.stringify({ type: "module", dependencies, devDependencies }, null, 2);
const write = (writes: FileWrite[]) => {
  for (const { file, source } of writes) writeFileSync(file, source);
};
/** Throws unless `source` parses as the TSX or JSX its file name says, as the app's build will read it. */
function parses({ file, source }: FileWrite) {
  new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") ? "ts" : "jsx" }).transformSync(source);
}
/** A plan, every file of which parses. */
function ok(plan: Plan) {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  for (const write of plan.writes) parses(write);
  return plan;
}
function refused(plan: Plan) {
  if (plan.ok) throw new Error(`Expected a refusal, got ${plan.action}`);
  return plan;
}

const SOLID2 = pkg({ "@solidjs/meta": "^2.0.0", "@solidjs/router": "^2.0.0", "@solidjs/web": "^2.0.0", "solid-js": "^2.0.0" }, { "@solidjs/vite-plugin": "^3.0.0", vite: "^8.1.5" });
const START2 = pkg({ "@solidjs/meta": "^0.29.4", "@solidjs/router": "^1.0.0", "@solidjs/start": "^2.0.0", "solid-js": "^1.9.14", vite: "^8.0.0" });
const START2_NO_ROUTER = pkg({ "@solidjs/start": "^2.0.0", "solid-js": "^1.9.14", vite: "^8.0.0" });
const SOLID2_NO_ROUTER = pkg({ "@solidjs/web": "^2.0.0", "solid-js": "^2.0.0" }, { "@solidjs/vite-plugin": "^3.0.0", vite: "^8.3.8" });
const VITE1 = pkg({ "solid-js": "^1.9.5" }, { vite: "^7.1.4", "vite-plugin-solid": "^2.11.8" });

const SOLID2_BASIC = `import { Title } from '@solidjs/meta';
import { Loading } from 'solid-js';
import { paths, Router } from './router';
import './App.css';

export default function App() {
  return (
    <Router>
      {(props) => (
        <>
          <Title>Solid App</Title>
          <nav>
            <a href={paths()}>Home</a>
            <a href={paths.users()}>Users</a>
          </nav>
          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>
        </>
      )}
    </Router>
  );
}
`;
const SOLID2_BARE = `import { createSignal } from 'solid-js';
import logo from './logo.svg';
import './App.css';

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <header class="header">
      <img src={logo} class="logo" alt="Solid logo" />
      <p>
        Edit <code>src/App.tsx</code> and save to reload.
      </p>
      <button class="increment" onClick={() => setCount(count() + 1)}>
        Clicks: {count()}
      </button>
    </header>
  );
}
`;
const START2_BASIC = `import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./app.css";

export default function App() {
  return (
    <Router
      root={props => (
        <MetaProvider>
          <Title>SolidStart - Basic</Title>
          <a href="/">Index</a>
          <a href="/about">About</a>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
`;
const START2_BARE = `import { createSignal } from "solid-js";
import "./app.css";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main>
      <h1>Hello world!</h1>
      <button class="increment" onClick={() => setCount(count() + 1)} type="button">
        Clicks: {count()}
      </button>
    </main>
  );
}
`;
const VITE1_TS = `import type { Component } from 'solid-js';
import Comp from './Comp';

const App: Component = () => {
  return (
    <>
      <h1>Hello world!!!!</h1>
      <Comp />
    </>
  );
};

export default App;
`;
const VITE1_JS = `
import Comp from './Comp';

const App = () => {
  return (
    <>
      <h1>Hello world!!!!</h1>
      <Comp />
    </>
  );
};

export default App;
`;

/** The Solid 2 basic starter's src/router.ts: its <Router> is the router createRouter makes. */
const SOLID2_ROUTER = `import { pageRoutes } from 'virtual:file-routes';
import { createRouter, intentPreload } from '@solidjs/router';
import { fileRoutes } from '@solidjs/router/fs';

// Link preloading is opt-in. intentPreload() warms a link's code and runs
// its preload when the pointer rests on it (or on focus/touch).
export const Router = createRouter({
  routes: fileRoutes(pageRoutes),
  preloadLinks: intentPreload(),
});

export const { paths } = Router;`;

const STARTERS = {
  "Solid 2 basic (router layout as children)": { "package.json": SOLID2, "src/App.tsx": SOLID2_BASIC, "src/router.ts": SOLID2_ROUTER },
  "Solid 2 bare": { "package.json": SOLID2_NO_ROUTER, "src/App.tsx": SOLID2_BARE },
  "SolidStart 2 basic (router root layout)": { "package.json": START2, "src/app.tsx": START2_BASIC, "src/entry-client.tsx": "// @refresh reload\nimport { mount, StartClient } from \"@solidjs/start/client\";\n\nmount(() => <StartClient />, document.getElementById(\"app\")!);\n" },
  "SolidStart 2 bare": { "package.json": START2_NO_ROUTER, "src/app.tsx": START2_BARE },
  "Vite Solid 1.9 (TypeScript)": { "package.json": VITE1, "src/App.tsx": VITE1_TS, "src/index.tsx": "import { render } from 'solid-js/web';\nimport App from './App';\n\nrender(() => <App />, document.getElementById('root')!);\n" },
  "Vite Solid 1.9 (JavaScript)": { "package.json": VITE1, "src/App.jsx": VITE1_JS },
} as const;

const PROJECT = "j12345678901234567890123456789012";
const envSettings = (root: string): Settings => ({ projectId: { env: solid.env(root, "")! }, requireProjectId: true });
const literal = (id = PROJECT, extra: Partial<Settings> = {}): Settings => ({ projectId: { literal: id }, requireProjectId: false, ...extra });

describe("detect and env", () => {
  test.each([
    ["Solid 2", SOLID2],
    ["SolidStart", START2],
    ["Solid 1.9 with Vite", VITE1],
  ])("detects %s apps as Solid", (_, manifest) => {
    expect(detectApp(app({ "package.json": manifest }))?.id).toBe("solid");
  });

  test("Vite and SolidStart apps read the project ID from VITE_ variables in .env.local", () => {
    for (const manifest of [SOLID2, START2, VITE1]) {
      const env = solid.env(app({ "package.json": manifest }), "_WEB") as EnvConvention;
      expect(env).toMatchObject({ variable: "VITE_CRITIQS_PROJECT_ID_WEB", expression: "import.meta.env.VITE_CRITIQS_PROJECT_ID_WEB", readsAt: "build", localFile: ".env.local" });
      expect(env.deploymentAdvice).toContain("VITE_CRITIQS_PROJECT_ID_WEB");
    }
  });

  test("setup writes the .env file Vite reads first: an ID already in .env.development.local is replaced there, not hidden by a new one in .env.local", () => {
    const old = "jold4567890123456789012345678901";
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], ".env.development.local": `VITE_CRITIQS_PROJECT_ID=${old}\n` });
    const lines: string[] = [];
    expect(runInit(["init", PROJECT, "--dir", root], { cwd: root, print: (line: string) => void lines.push(line) })).toBe(0);
    expect(read(root, ".env.development.local")).toBe(`VITE_CRITIQS_PROJECT_ID=${PROJECT}\n`);
    expect(() => read(root, ".env.local")).toThrow();
  });

  test.each([
    ["envDir", 'export default { envDir: process.env.ENV_DIR };\n'],
    ["envPrefix", 'export default { envPrefix: "PUBLIC_" };\n'],
  ])("a Vite config that sets %s is named, since setup can't tell which file or name Vite reads", (setting, config) => {
    const root = app({ "package.json": VITE1, "vite.config.ts": config });
    expect(solid.env(root, "")?.problem).toContain(`vite.config.ts sets ${setting}`);
  });

  test("an app built without Vite has no variable convention", () => {
    expect(solid.env(app({ "package.json": pkg({ "solid-js": "^1.9.0" }, { webpack: "^5.0.0" }) }), "")).toBeNull();
  });
});

describe("adding Critiqs to the official starters", () => {
  test.each(Object.entries(STARTERS))("%s: adds one import and one element, and a second run changes nothing", (_, files) => {
    const root = app(files);
    const [entry, before] = Object.entries(files).find(([name]) => /^src\/[Aa]pp\./.test(name))!;
    const settings = envSettings(root);
    const plan = ok(solid.plan(root, settings, { entry: null }));
    expect(plan).toMatchObject({ action: "install", file: join(root, entry), changed: ["projectId", "requireProjectId"], next: [] });
    expect(plan.writes.map((w) => w.file)).toEqual([join(root, entry)]);
    write(plan.writes);
    const after = read(root, entry);
    // Only the two new lines differ; everything the starter had is kept as written.
    const added = after.split("\n").filter((line) => !before.split("\n").includes(line));
    expect(added.map((line) => line.trim())).toEqual(
      expect.arrayContaining([expect.stringMatching(/^import \{ Critiqs \} from ['"]critiqs-solid(\/router)?['"];$/), "<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />"]),
    );
    expect(added).toHaveLength(2);
    expect(after.split("\n").filter((line) => !added.includes(line))).toEqual(before.split("\n"));
    expect(plan.line).toBe(after.split("\n").findIndex((line) => line.includes("<Critiqs")) + 1);
    expect(solid.find(root)).toEqual([{ file: join(root, entry), line: plan.line, projectId: { kind: "env", variable: "VITE_CRITIQS_PROJECT_ID" }, backend: null, requireProjectId: true }]);
    expect(ok(solid.plan(root, settings, { entry: null }))).toMatchObject({ action: "unchanged", writes: [], changed: [] });
  });

  test("SolidStart: inside the layout the router renders on every page, not among its routes", () => {
    const root = app(STARTERS["SolidStart 2 basic (router root layout)"]);
    write(ok(solid.plan(root, envSettings(root), { entry: null })).writes);
    expect(read(root, "src/app.tsx")).toBe(
      START2_BASIC.replace('import "./app.css";', 'import { Critiqs } from "critiqs-solid/router";\nimport "./app.css";').replace(
        "          <Suspense>{props.children}</Suspense>\n",
        "          <Suspense>{props.children}</Suspense>\n          <Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />\n",
      ),
    );
  });

  test("Solid 2: inside the fragment the router's children function returns, in the starter's quote style", () => {
    const root = app(STARTERS["Solid 2 basic (router layout as children)"]);
    write(ok(solid.plan(root, envSettings(root), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toBe(
      SOLID2_BASIC.replace("import './App.css';", "import { Critiqs } from 'critiqs-solid/router';\nimport './App.css';").replace(
        "          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>\n",
        "          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>\n          <Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />\n",
      ),
    );
  });

  test.each([
    ["Solid 2 basic (router layout as children)", "critiqs-solid/router"],
    ["SolidStart 2 basic (router root layout)", "critiqs-solid/router"],
    ["Solid 2 bare", "critiqs-solid"],
    ["SolidStart 2 bare", "critiqs-solid"],
    ["Vite Solid 1.9 (TypeScript)", "critiqs-solid"],
  ] as const)("%s imports Critiqs from %s: the router entry wherever the app has Solid Router", (starter, entry) => {
    const root = app(STARTERS[starter]);
    const plan = ok(solid.plan(root, envSettings(root), { entry: null }));
    expect(plan.writes[0]!.source).toMatch(new RegExp(`^import \\{ Critiqs \\} from ['"]${entry}['"];$`, "m"));
  });

  test("a project ID written into the code, with a team's own backend", () => {
    const root = app(STARTERS["Vite Solid 1.9 (TypeScript)"]);
    const settings = literal(PROJECT, { requireProjectId: true, backend: "https://convex.example.cloud" });
    const plan = ok(solid.plan(root, settings, { entry: null }));
    expect(plan.changed).toEqual(["projectId", "requireProjectId", "backend"]);
    write(plan.writes);
    expect(read(root, "src/App.tsx")).toContain(`      <Critiqs projectId="${PROJECT}" requireProjectId backend="https://convex.example.cloud" />\n    </>`);
    expect(solid.find(root)[0]).toMatchObject({ projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: "https://convex.example.cloud" }, requireProjectId: true });
    expect(ok(solid.plan(root, settings, { entry: null })).action).toBe("unchanged");
  });

  test("--entry chooses the file, even with a root component present", () => {
    const layout = `export function Layout(props) {\n  return <div class="layout">{props.children}</div>;\n}\n`;
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], "src/Layout.tsx": layout });
    const plan = ok(solid.plan(root, envSettings(root), { entry: "src/Layout.tsx" }));
    expect(plan.file).toBe(join(root, "src/Layout.tsx"));
    write(plan.writes);
    expect(read(root, "src/Layout.tsx")).toBe(
      `import { Critiqs } from "critiqs-solid";\n\nexport function Layout(props) {\n  return <div class="layout">{props.children}<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId /></div>;\n}\n`,
    );
    expect(read(root, "src/App.tsx")).toBe(VITE1_TS);
    expect(ok(solid.plan(root, envSettings(root), { entry: "src/Layout.tsx" })).action).toBe("unchanged");
  });

  test("a root component that returns a component with no children gets a fragment", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": "import Shell from './Shell';\n\nexport default function App() {\n  return <Shell />;\n}\n" });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toContain(`return <><Shell /><Critiqs projectId="${PROJECT}" /></>;`);
  });
});

describe("updating the Critiqs already there", () => {
  const installed = (element: string, file = "src/App.tsx") =>
    app({ "package.json": VITE1, [file]: `import { Critiqs } from "critiqs-solid";\n\nexport default function App() {\n  return (\n    <main>\n      ${element}\n    </main>\n  );\n}\n` });

  test("a new project ID replaces only the old one", () => {
    const root = installed(`<Critiqs projectId="jold4567890123456789012345678901" />`);
    const plan = ok(solid.plan(root, literal(), { entry: null }));
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"], line: 6 });
    expect(plan.preview).toBe(`-       <Critiqs projectId="jold4567890123456789012345678901" />\n+       <Critiqs projectId="${PROJECT}" />`);
  });

  test("switches a written ID to the app's variable, and adds requireProjectId", () => {
    const root = installed(`<Critiqs projectId="${PROJECT}" />`);
    const plan = ok(solid.plan(root, envSettings(root), { entry: null }));
    expect(plan.changed).toEqual(["projectId", "requireProjectId"]);
    write(plan.writes);
    expect(read(root, "src/App.tsx")).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />");
  });

  test("requireProjectId off removes it; a backend not given is left alone", () => {
    const root = installed(`<Critiqs projectId="${PROJECT}" requireProjectId backend="https://mine.example" />`);
    const plan = ok(solid.plan(root, literal(), { entry: null }));
    expect(plan.changed).toEqual(["requireProjectId"]);
    write(plan.writes);
    expect(read(root, "src/App.tsx")).toContain(`<Critiqs projectId="${PROJECT}" backend="https://mine.example" />`);
  });

  test("attributes one per line stay one per line", () => {
    const root = installed(`<Critiqs\n        projectId="${PROJECT}"\n        version="1.0"\n      />`);
    write(ok(solid.plan(root, literal(PROJECT, { requireProjectId: true, backend: "https://mine.example" }), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toContain(`<Critiqs\n        projectId="${PROJECT}"\n        version="1.0"\n        requireProjectId\n        backend="https://mine.example"\n      />`);
  });

  test("Critiqs in another component is updated there instead of adding a second", () => {
    const root = installed(`<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />`, "src/Layout.tsx");
    writeFileSync(join(root, "src/App.tsx"), VITE1_TS);
    expect(ok(solid.plan(root, envSettings(root), { entry: null }))).toMatchObject({ action: "unchanged", file: join(root, "src/Layout.tsx") });
  });

  test("Critiqs from critiqs-solid/router is found and updated, keeping its import", () => {
    const root = installed(`<Critiqs projectId="jold4567890123456789012345678901" />`);
    writeFileSync(join(root, "src/App.tsx"), read(root, "src/App.tsx").replace('"critiqs-solid"', '"critiqs-solid/router"'));
    const plan = ok(solid.plan(root, literal(), { entry: null }));
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"] });
    expect(plan.writes[0]!.source).toContain('import { Critiqs } from "critiqs-solid/router";');
    expect(solid.find(root)).toHaveLength(1);
  });

  test("a project ID set by other code is left to the person", () => {
    const root = installed(`<Critiqs projectId={config.critiqs} />`);
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.reason).toBe("expression");
    expect(plan.message).toContain("src/App.tsx at line 6");
    expect(plan.message).toContain(`<Critiqs projectId="${PROJECT}" />`);
    expect(solid.find(root)[0]?.projectId).toEqual({ kind: "expression", text: "config.critiqs" });
  });

  test("a setting before a spread that could override it is left to the person", () => {
    const root = installed(`<Critiqs projectId="jold4567890123456789012345678901" {...props} />`);
    expect(refused(solid.plan(root, literal(), { entry: null })).reason).toBe("expression");
  });

  test("an import in a comment doesn't count", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `// import { Critiqs } from "critiqs-solid";\n${VITE1_TS}` });
    expect(solid.find(root)).toEqual([]);
  });
});

describe("refusing rather than guessing", () => {
  test("Critiqs in two places", () => {
    const root = app({
      "package.json": VITE1,
      "src/App.tsx": `import { Critiqs } from "critiqs-solid";\nexport default () => <><Critiqs projectId="a" /><Critiqs projectId="b" /></>;\n`,
    });
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.reason).toBe("ambiguous");
    expect(plan.message).toContain("src/App.tsx:2, src/App.tsx:2");
  });

  test("two root components", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": VITE1_TS, "src/App.jsx": VITE1_JS });
    expect(refused(solid.plan(root, literal(), { entry: null })).reason).toBe("ambiguous");
  });

  test("no root component", () => {
    const plan = refused(solid.plan(app({ "package.json": START2, "src/main.tsx": START2_BARE }), literal(), { entry: null }));
    expect(plan.reason).toBe("manual");
    expect(plan.message).toContain("src/app.tsx");
  });

  test("a router whose layout is another component", () => {
    const root = app({ "package.json": START2, "src/app.tsx": `import { Router } from "@solidjs/router";\nimport Layout from "./Layout";\n\nexport default function App() {\n  return <Router root={Layout}><FileRoutes /></Router>;\n}\n` });
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.reason).toBe("manual");
    expect(plan.message).toContain("<Router> renders no layout");
  });

  test("a root component that returns in several places", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": "export default (props) => {\n  if (props.loading) return <p>Loading</p>;\n  return <main />;\n};\n" });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("it returns in 2 places");
  });

  test("JSX kept in a variable doesn't count: Critiqs goes in the element the component returns", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": "export default () => {\n  const side = <aside />;\n  return <main>{side}</main>;\n};\n" });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toContain(`  const side = <aside />;\n  return <main>{side}<Critiqs projectId="${PROJECT}" /></main>;`);
  });

  test("the name Critiqs already taken", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": "import Critiqs from './Critiqs';\nexport default () => <main><Critiqs /></main>;\n" });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("already uses the name Critiqs");
  });

  test("critiqs-solid imported under another name", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `import { Critiqs as Feedback } from "critiqs-solid";\nexport default () => <main><Feedback /></main>;\n` });
    expect(refused(solid.plan(root, literal(), { entry: null })).reason).toBe("manual");
  });

  test("critiqs-solid re-exported from another file", () => {
    const root = app({ ...STARTERS["Solid 2 bare"], "src/feedback.ts": `export { Critiqs } from "critiqs-solid";\n` });
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.reason).toBe("manual");
    expect(plan.message).toContain("src/feedback.ts uses critiqs-solid in a way setup can't follow");
  });

  test("an --entry that doesn't exist", () => {
    const root = app(STARTERS["Solid 2 bare"]);
    expect(refused(solid.plan(root, literal(), { entry: "src/Missing.tsx" })).message).toContain("src/Missing.tsx isn't a file");
  });
});

describe("where Critiqs goes in the root component", () => {
  test("a router inside another element: Critiqs goes in the router's layout, not beside the router", () => {
    const before = `import { Router } from "@solidjs/router";\nimport { FileRoutes } from "@solidjs/start/router";\n\nexport default function App() {\n  return (\n    <main>\n      <Router root={(props) => <div class="layout">{props.children}</div>}>\n        <FileRoutes />\n      </Router>\n    </main>\n  );\n}\n`;
    const root = app({ "package.json": START2, "src/app.tsx": before });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/app.tsx")).toBe(
      before.replace('import { FileRoutes }', 'import { Critiqs } from "critiqs-solid/router";\nimport { FileRoutes }').replace("{props.children}</div>", `{props.children}<Critiqs projectId="${PROJECT}" /></div>`),
    );
  });

  test("a router imported under another name: Critiqs goes in its layout, not among its routes", () => {
    const before = `import { Router as R } from "@solidjs/router";\nimport { FileRoutes } from "@solidjs/start/router";\n\nexport default function App() {\n  return (\n    <R\n      root={(props) => (\n        <>\n          {props.children}\n        </>\n      )}\n    >\n      <FileRoutes />\n    </R>\n  );\n}\n`;
    const root = app({ "package.json": START2, "src/app.tsx": before });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/app.tsx")).toContain(`          {props.children}\n          <Critiqs projectId="${PROJECT}" />\n        </>`);
    expect(read(root, "src/app.tsx")).toContain("      <FileRoutes />\n    </R>");
  });

  test("a renamed router with no layout function is refused, not filled with Critiqs", () => {
    const root = app({ "package.json": START2, "src/app.tsx": `import { Router as R } from "@solidjs/router";\nimport Layout from "./Layout";\n\nexport default function App() {\n  return <R root={Layout}><FileRoutes /></R>;\n}\n` });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("<R> renders no layout");
  });

  test("a router in a component the default export defines but doesn't render is ignored: Critiqs goes in what it returns", () => {
    const before = `import { Router } from "@solidjs/router";\n\nexport default function App() {\n  const Unused = () => <Router>{(props) => <main>{props.children}</main>}</Router>;\n  return (\n    <section>\n      Actual\n    </section>\n  );\n}\n`;
    const root = app({ "package.json": SOLID2, "src/App.tsx": before });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toBe(
      before.replace('import { Router }', 'import { Critiqs } from "critiqs-solid/router";\nimport { Router }').replace("      Actual\n", `      Actual\n      <Critiqs projectId="${PROJECT}" />\n`),
    );
  });

  test("a router's fallback isn't its layout: with no root or children function, setup refuses", () => {
    const root = app({ "package.json": START2, "src/app.tsx": `import { Router } from "@solidjs/router";\nimport { FileRoutes } from "@solidjs/start/router";\n\nexport default function App() {\n  return <Router fallback={() => <p>Loading</p>}><FileRoutes /></Router>;\n}\n` });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("renders no layout setup can find");
  });

  test("a router's fallback beside its root: Critiqs goes in the root layout", () => {
    const before = `import { Router } from "@solidjs/router";\nimport { FileRoutes } from "@solidjs/start/router";\n\nexport default function App() {\n  return <Router fallback={() => <p>Loading</p>} root={(props) => <main>{props.children}</main>}><FileRoutes /></Router>;\n}\n`;
    const root = app({ "package.json": START2, "src/app.tsx": before });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/app.tsx")).toContain(`<p>Loading</p>} root={(props) => <main>{props.children}<Critiqs projectId="${PROJECT}" /></main>}>`);
  });

  test("a router rendered from a function inside the returned tree is refused", () => {
    const root = app({ "package.json": SOLID2, "src/App.tsx": `import { Show } from "solid-js";\nimport { Router } from "@solidjs/router";\n\nexport default function App(props) {\n  return <main><Show when={props.ready}>{() => <Router>{(p) => <div>{p.children}</div>}</Router>}</Show></main>;\n}\n` });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("is inside a function");
  });

  test("JSX outside the default export doesn't count: a default export that renders no JSX of its own is refused", () => {
    const imported = app({ "package.json": VITE1, "src/App.tsx": `import Shell from "./Shell";\n\nconst template = <aside />;\n\nexport default Shell;\n` });
    expect(refused(solid.plan(imported, literal(), { entry: null })).message).toContain("its default export, Shell, isn't a function this file defines");
    const noJsx = app({ "package.json": VITE1, "src/App.tsx": `import Shell from "./Shell";\n\nconst template = <aside />;\n\nexport default function App() {\n  return Shell();\n}\n` });
    expect(refused(solid.plan(noJsx, literal(), { entry: null })).message).toContain("it returns no JSX");
  });

  test("a helper component's JSX is left alone; Critiqs goes in what the default export renders", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `const Side = () => <aside />;\n\nconst App = () => (\n  <main>\n    <Side />\n  </main>\n);\n\nexport default App;\n` });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toContain(`const Side = () => <aside />;\n`);
    expect(read(root, "src/App.tsx")).toContain(`    <Side />\n    <Critiqs projectId="${PROJECT}" />\n  </main>`);
  });
});

describe("routers are known by what they are, and Critiqs goes only in JSX that renders", () => {
  const renamed = {
    "package.json": SOLID2,
    "src/App.tsx": SOLID2_BASIC.replace("import { paths, Router } from './router';", "import { paths, Routing } from './router';").replace("<Router>", "<Routing>").replace("</Router>", "</Routing>"),
    "src/router.ts": SOLID2_ROUTER.replace("export const Router =", "export const Routing =").replace("= Router;", "= Routing;"),
  };

  test("the starter's router renamed Routing is still createRouter's: Critiqs goes in the layout its children function returns, not beside the function", () => {
    const root = app(renamed);
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    const after = read(root, "src/App.tsx");
    expect(after).toContain(`          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>\n          <Critiqs projectId="${PROJECT}" />\n        </>\n      )}\n    </Routing>`);
    expect(ok(solid.plan(root, literal(), { entry: null })).action).toBe("unchanged");
  });

  test.each([
    ["exported under another name", `import { createRouter as make } from "@solidjs/router";\n\nconst routing = make({ routes: [] });\n\nexport { routing as Routing };\n`],
    ["made in a file imported with its extension", null],
  ])("a router createRouter makes, %s, is found", (_, router) => {
    const files: Record<string, string> = router === null ? { ...renamed, "src/App.tsx": renamed["src/App.tsx"].replace("'./router'", "'./router.js'") } : { ...renamed, "src/router.ts": router };
    const root = app(files);
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toContain(`{props.children}</Loading>\n          <Critiqs projectId="${PROJECT}" />\n        </>`);
  });

  test("a router made in the root component's own file is found", () => {
    const before = `import { createRouter } from "@solidjs/router";\n\nconst Shell = createRouter({ routes: [] });\n\nexport default function App() {\n  return <Shell>{(props) => <main>{props.children}</main>}</Shell>;\n}\n`;
    const root = app({ "package.json": SOLID2, "src/App.tsx": before });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/App.tsx")).toContain(`{(props) => <main>{props.children}<Critiqs projectId="${PROJECT}" /></main>}</Shell>`);
  });

  test.each([
    ["a component from a module setup can't trace", `import { Routing } from "my-router";\n\nexport default function App() {\n  return <Routing>{(props) => <main>{props.children}</main>}</Routing>;\n}\n`, "renders its children from a function"],
    ["a local component that isn't a router", `import { Routing } from "./router";\n\nexport default function App() {\n  return <Routing>{(props) => <main>{props.children}</main>}</Routing>;\n}\n`, "renders its children from a function"],
    ["a component with a root layout", `import { Shell } from "my-router";\n\nexport default function App() {\n  return <Shell root={(props) => <main>{props.children}</main>}><Pages /></Shell>;\n}\n`, "takes a root layout as a router does"],
    ["a …Router setup can't trace, inside the returned element", `import { AppRouter } from "my-router";\n\nexport default function App() {\n  return <main><AppRouter /></main>;\n}\n`, "can't tell whether its <AppRouter> is Solid Router's router"],
  ])("%s is refused rather than given Critiqs beside what it renders", (_, source, message) => {
    const root = app({ "package.json": SOLID2, "src/App.tsx": source, "src/router.tsx": `export const Routing = (props) => props.children({ children: null });\n` });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain(message);
  });

  test("a layout function that defines a component and returns its children: refused, not added to the component it never renders", () => {
    const source = `import { Router } from "@solidjs/router";\nimport { FileRoutes } from "@solidjs/start/router";\n\nexport default function App() {\n  return (\n    <Router\n      root={(props) => {\n        const Hidden = () => <div>unused</div>;\n        return props.children;\n      }}\n    >\n      <FileRoutes />\n    </Router>\n  );\n}\n`;
    const root = app({ "package.json": START2, "src/app.tsx": source });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("its <Router> layout returns no JSX");
  });

  test("a component whose only JSX is kept in a variable it never returns: refused", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `export default function App() {\n  const view = <main>Hello</main>;\n  return "Hello";\n}\n` });
    expect(refused(solid.plan(root, literal(), { entry: null })).message).toContain("it returns no JSX");
  });

  test("a layout that returns its element after other statements gets Critiqs there", () => {
    const before = `import { Router } from "@solidjs/router";\n\nexport default function App() {\n  return (\n    <Router\n      root={(props) => {\n        const title = "Shop";\n        return <main title={title}>{props.children}</main>;\n      }}\n    />\n  );\n}\n`;
    const root = app({ "package.json": START2, "src/app.tsx": before });
    write(ok(solid.plan(root, literal(), { entry: null })).writes);
    expect(read(root, "src/app.tsx")).toContain(`return <main title={title}>{props.children}<Critiqs projectId="${PROJECT}" /></main>;`);
  });
});

describe("type annotations don't hide a function's body", () => {
  test.each([
    ["an object return type", `export function island(Critiqs: typeof ReactCritiqs): { element: ReturnType<typeof ReactCritiqs> } {\n  return { element: <Critiqs projectId="${PROJECT}" /> };\n}`],
    ["type parameters with an object constraint", `export function island<T extends { element: unknown }>(Critiqs: typeof ReactCritiqs, value: T): T {\n  return { ...value, element: <Critiqs projectId="${PROJECT}" /> };\n}`],
    ["an arrow with an object return type", `export const island = (Critiqs: typeof ReactCritiqs): { element: unknown } => ({ element: <Critiqs projectId="${PROJECT}" /> });`],
    ["a function return type", `export function island(Critiqs: typeof ReactCritiqs): () => { element: unknown } {\n  return () => ({ element: <Critiqs projectId="${PROJECT}" /> });\n}`],
  ])("a parameter named Critiqs with %s is the parameter, so a React Critiqs it renders isn't counted as Solid's", (_, fn) => {
    const island = `import { Critiqs } from "critiqs-solid";\nimport { Critiqs as ReactCritiqs } from "critiqs-react";\n\n${fn}\n`;
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], "src/island.tsx": island });
    expect(solid.find(root)).toEqual([]);
  });
});

describe("symbolic links", () => {
  test.each([
    ["--entry naming a link", "src/App.tsx"],
    ["the root component as a link", null],
  ])("%s to a shared file is refused, and the shared file is left alone", (_, entry) => {
    const shared = app({ "Shared.tsx": VITE1_TS });
    const root = app({ "package.json": VITE1, "src/index.tsx": "export {};\n" });
    symlinkSync(join(shared, "Shared.tsx"), join(root, "src/App.tsx"));
    const plan = refused(solid.plan(root, literal(), { entry }));
    expect(plan.reason).toBe("manual");
    expect(plan.message).toContain("src/App.tsx is reached through a symbolic link");
    expect(read(shared, "Shared.tsx")).toBe(VITE1_TS);
  });

  test("a root component inside a linked folder is refused", () => {
    const shared = app({ "src/App.tsx": VITE1_TS });
    const root = app({ "package.json": VITE1 });
    symlinkSync(join(shared, "src"), join(root, "src"));
    expect(refused(solid.plan(root, literal(), { entry: "src/App.tsx" })).message).toContain("symbolic link");
  });
});

describe("what the name Critiqs means", () => {
  test("a component's own Critiqs parameter isn't critiqs-solid's, so setup neither finds nor edits it", () => {
    const card = `import type { Component } from "solid-js";\nimport { Critiqs } from "critiqs-solid";\n\nexport function Card({ Critiqs }: { Critiqs: Component<{ projectId: string }> }) {\n  return <Critiqs projectId="jold4567890123456789012345678901" />;\n}\n`;
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], "src/Card.tsx": card });
    expect(solid.find(root)).toEqual([]);
    const plan = ok(solid.plan(root, literal(), { entry: null }));
    expect(plan).toMatchObject({ action: "install", file: join(root, "src/App.tsx") });
    expect(plan.writes.map((w) => w.file)).toEqual([join(root, "src/App.tsx")]);
  });

  test("an arrow's Critiqs parameter and a destructured Critiqs variable shadow the import too", () => {
    const list = `import { For } from "solid-js";\nimport { Critiqs } from "critiqs-solid";\n\nexport const List = (props) => <For each={props.items}>{(Critiqs) => <Critiqs projectId="a" />}</For>;\n\nexport function Panel(props) {\n  const { Critiqs } = props;\n  return <Critiqs projectId="b" />;\n}\n`;
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], "src/List.tsx": list });
    expect(solid.find(root)).toEqual([]);
  });

  test.each([
    ["a later declarator", "const n = 1, Critiqs = props.Custom;"],
    ["a later declarator on its own line", "let n = 1,\n    Critiqs = props.Custom;"],
    ["a destructured later declarator", "const n = 1, { Custom: Critiqs } = props;"],
    ["a nested destructured later declarator", "const [a] = [1], { parts: [Critiqs] } = props;"],
    ["a var in an inner block, which the whole function sees", "if (props.custom) {\n    var Critiqs = props.Custom;\n  }"],
  ])("%s that takes the name shadows the import: setup neither finds nor edits the app's element", (_, declaration) => {
    const source = `import { Critiqs } from "critiqs-solid";\n\nexport default function App(props) {\n  ${declaration}\n  return (\n    <main>\n      <Critiqs projectId="jold4567890123456789012345678901" />\n    </main>\n  );\n}\n`;
    const root = app({ "package.json": VITE1, "src/App.tsx": source });
    expect(solid.find(root)).toEqual([]);
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.message).toContain("means the component's own parameter or variable");
  });

  test("a comma in a call or an object doesn't declare anything: the imported Critiqs is still found", () => {
    const source = `import { Critiqs } from "critiqs-solid";\n\nexport default function App(props) {\n  const pair = [props.a, Critiqs], options = { a: 1, Critiqs };\n  console.log(props.a, Critiqs);\n  return (\n    <main>\n      <Critiqs projectId="jold4567890123456789012345678901" />\n    </main>\n  );\n}\n`;
    const root = app({ "package.json": VITE1, "src/App.tsx": source });
    expect(solid.find(root)).toHaveLength(1);
    expect(ok(solid.plan(root, literal(), { entry: null })).action).toBe("update");
  });

  test("a root component whose parameter takes the name is refused rather than given a Critiqs that means the prop", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `import { Critiqs } from "critiqs-solid";\n\nexport default function App({ Critiqs }) {\n  return <main></main>;\n}\n` });
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.reason).toBe("manual");
    expect(plan.message).toContain("means the component's own parameter or variable");
  });

  test("an alias written with a comment inside is still an alias: refused, rather than adding a second Critiqs", () => {
    const layout = `import { Critiqs as /* the toolbar */ Feedback } from "critiqs-solid";\n\nexport function Layout(props) {\n  return <div>{props.children}<Feedback projectId="${PROJECT}" /></div>;\n}\n`;
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], "src/Layout.tsx": layout });
    const plan = refused(solid.plan(root, literal(), { entry: null }));
    expect(plan.reason).toBe("manual");
    expect(plan.message).toContain("src/Layout.tsx uses critiqs-solid in a way setup can't follow");
  });

  test("an import with comments among its names is found and updated, not imported again", () => {
    const root = app({
      "package.json": VITE1,
      "src/App.tsx": `import {\n  // the review toolbar\n  Critiqs /* from critiqs-solid */,\n} from "critiqs-solid";\n\nexport default function App() {\n  return (\n    <main>\n      <Critiqs projectId="jold4567890123456789012345678901" />\n    </main>\n  );\n}\n`,
    });
    const plan = ok(solid.plan(root, literal(), { entry: null }));
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"] });
    expect(plan.writes[0]!.source.match(/import/g)).toHaveLength(1);
  });
});

describe("spread props", () => {
  const spread = (element: string) => app({ "package.json": VITE1, "src/App.tsx": `import { Critiqs } from "critiqs-solid";\n\nexport default function App(props) {\n  return (\n    <main>\n      ${element}\n    </main>\n  );\n}\n` });

  test.each([
    ["requireProjectId: false", false],
    ["requireProjectId: true", false],
    ["requireProjectId: true", true],
  ])("a spread after the settings ({...{ %s }}) makes them unknown, so setup refuses rather than calls them unchanged", (inside, require) => {
    const root = spread(`<Critiqs projectId="${PROJECT}" {...{ ${inside} }} />`);
    const plan = refused(solid.plan(root, literal(PROJECT, { requireProjectId: require }), { entry: null }));
    expect(plan.reason).toBe("expression");
    expect(solid.find(root)[0]?.projectId).toEqual({ kind: "expression", text: "" });
  });

  test("settings written after a spread win, and a setting setup adds goes after it", () => {
    const root = spread(`<Critiqs {...props} projectId="${PROJECT}" />`);
    const plan = ok(solid.plan(root, literal(PROJECT, { requireProjectId: true }), { entry: null }));
    expect(plan.changed).toEqual(["requireProjectId"]);
    expect(plan.writes[0]!.source).toContain(`<Critiqs {...props} projectId="${PROJECT}" requireProjectId />`);
  });
});

describe("imports go where statements begin", () => {
  const body = `export default function App() {\n  return <main></main>;\n}\n`;

  test("a file starting with a string expression gets the import before it, not inside it", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `"use strict".toString();\n\n${body}` });
    const [written] = ok(solid.plan(root, literal(), { entry: null })).writes;
    expect(written!.source.startsWith(`import { Critiqs } from "critiqs-solid";\n\n"use strict".toString();\n`)).toBe(true);
  });

  test.each([
    ["with a semicolon", `"use client";\n\n`],
    ["without one", `'use client'\n`],
    ["two of them, after a comment", `// @refresh reload\n"use client";\n"use strict";\n`],
  ])("after the directive prologue (%s)", (_, prologue) => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `${prologue}${body}` });
    const [written] = ok(solid.plan(root, literal(), { entry: null })).writes;
    expect(written!.source.startsWith(`${prologue.trimEnd()}\nimport { Critiqs } from "critiqs-solid";\n`)).toBe(true);
  });

  test("two imports on one line: the new one ends with its own semicolon", () => {
    const root = app({ "package.json": VITE1, "src/App.tsx": `import Shell from "./Shell"; import "./App.css"\n\n${body}` });
    const [written] = ok(solid.plan(root, literal(), { entry: null })).writes;
    expect(written!.source).toContain(`import Shell from "./Shell"; import { Critiqs } from "critiqs-solid"; import "./App.css"\n`);
  });

  test("every starter's written file parses as TSX or JSX", () => {
    for (const files of Object.values(STARTERS)) {
      const root = app(files);
      for (const settings of [envSettings(root), literal(PROJECT, { backend: "https://convex.example.cloud" })]) ok(solid.plan(root, settings, { entry: null }));
    }
  });
});

describe("--entry", () => {
  test("names a file other than the one Critiqs is already in: refused, naming both", () => {
    const layout = `import { Critiqs } from "critiqs-solid";\n\nexport function Layout(props) {\n  return <div>{props.children}<Critiqs projectId="${PROJECT}" /></div>;\n}\n`;
    const root = app({ ...STARTERS["Vite Solid 1.9 (TypeScript)"], "src/Layout.tsx": layout });
    const plan = refused(solid.plan(root, literal(), { entry: "src/App.tsx" }));
    expect(plan.reason).toBe("ambiguous");
    expect(plan.message).toContain("src/Layout.tsx:4");
    expect(plan.message).toContain("src/App.tsx");
    expect(ok(solid.plan(root, literal(), { entry: "src/Layout.tsx" })).action).toBe("unchanged");
  });
});

test("manual instructions name the package, the file, the code, and the variable", () => {
  const root = app(STARTERS["SolidStart 2 basic (router root layout)"]);
  const text = solid.manual(envSettings(root));
  expect(text).toContain("npm install critiqs-solid");
  expect(text).toContain('import { Critiqs } from "critiqs-solid";');
  expect(text).toContain('import it from "critiqs-solid/router" instead');
  expect(text).toContain("src/app.tsx in SolidStart");
  expect(text).toContain("<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />");
  expect(text).toContain("Set VITE_CRITIQS_PROJECT_ID to the project ID from project setup in the Critiqs sidebar, in .env.local");
  expect(solid.manual(literal())).not.toContain("VITE_");
});
