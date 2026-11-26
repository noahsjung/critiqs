import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";

const angular = FRAMEWORKS.find((adapter) => adapter.id === "angular")!;

const PROJECT = "j12345678901234567890123456789012";
const OTHER = "k12345678901234567890123456789012";
const BACKEND = "https://critiqs.example.com/critiqs";

// Files as `ng new` (Angular CLI 22.3) writes them.
const PACKAGE = JSON.stringify({
  name: "shop",
  dependencies: { "@angular/common": "^22.3.0", "@angular/core": "^22.3.0", "@angular/platform-browser": "^22.3.0", "@angular/router": "^22.3.0" },
  devDependencies: { "@angular/build": "^22.3.0", "@angular/cli": "^22.3.0" },
});
const WORKSPACE = JSON.stringify({ version: 1, projects: { shop: { projectType: "application", root: "", sourceRoot: "src" } } });
const CONFIG = `import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes)
  ]
};
`;
// `ng new --ssr` puts hydration on the router's line.
const SSR_CONFIG = `import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideClientHydration } from '@angular/platform-browser';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes), provideClientHydration()
  ]
};
`;

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-angular-"));
  for (const [name, text] of Object.entries({ "package.json": PACKAGE, "angular.json": WORKSPACE, ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const literal = (projectId = PROJECT, extra: { requireProjectId?: boolean; backend?: string } = {}) => ({
  projectId: { literal: projectId },
  requireProjectId: extra.requireProjectId ?? false,
  ...(extra.backend === undefined ? {} : { backend: extra.backend }),
});
const noEntry: { entry: string | null } = { entry: null };
const config = (root: string) => readFileSync(join(root, "src/app/app.config.ts"), "utf8");

/** Plans, writes the plan, and checks that planning again changes nothing. */
function apply(root: string, settings: ReturnType<typeof literal>, options = noEntry) {
  const plan = angular.plan(root, settings, options);
  if (!plan.ok) throw new Error(plan.message);
  for (const write of plan.writes) writeFileSync(write.file, write.source);
  const again = angular.plan(root, settings, options);
  expect(again).toMatchObject({ ok: true, action: "unchanged", writes: [] });
  return plan;
}

test("detects Angular apps; Angular has no public environment variable convention", () => {
  const root = app({ "src/app/app.config.ts": CONFIG });
  expect(detectApp(root)?.id).toBe("angular");
  expect(angular.env(root, "")).toBeNull();
  expect(angular.find(root)).toEqual([]);
});

describe("adding Critiqs", () => {
  test("adds provideCritiqs to the providers of an ng new app, with its import", () => {
    const root = app({ "src/app/app.config.ts": CONFIG });
    const plan = apply(root, literal());
    expect(plan).toMatchObject({ action: "install", changed: ["projectId"], line: 10, file: join(root, "src/app/app.config.ts") });
    expect(config(root)).toBe(`import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideCritiqs } from 'critiqs-angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideCritiqs({ projectId: '${PROJECT}' })
  ]
};
`);
    if (plan.ok) expect(plan.preview).toContain(`+     provideCritiqs({ projectId: '${PROJECT}' })`);
    expect(angular.find(root)).toEqual([
      { file: join(root, "src/app/app.config.ts"), line: 10, projectId: { kind: "literal", value: PROJECT }, backend: null, requireProjectId: false },
    ]);
  });

  test("splits a call longer than the line width across lines", () => {
    const root = app({ "src/app/app.config.ts": CONFIG });
    apply(root, literal(PROJECT, { requireProjectId: true, backend: BACKEND }));
    expect(config(root)).toContain(`    provideRouter(routes),
    provideCritiqs({
      projectId: '${PROJECT}',
      requireProjectId: true,
      backend: '${BACKEND}',
    })
  ]`);
    expect(angular.find(root)[0]).toMatchObject({ projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: BACKEND }, requireProjectId: true });
  });

  test("an SSR app: adds the call on its own line, indented like the others", () => {
    const root = app({ "src/app/app.config.ts": SSR_CONFIG });
    apply(root, literal());
    expect(config(root)).toContain(`    provideRouter(routes), provideClientHydration(),
    provideCritiqs({ projectId: '${PROJECT}' })
  ]`);
  });

  test("keeps the file's quotes, semicolons, trailing commas and tabs", () => {
    const root = app({
      "src/app/app.config.ts": `import { ApplicationConfig } from "@angular/core"
import { provideRouter } from "@angular/router"

export const appConfig: ApplicationConfig = {
\tproviders: [
\t\tprovideRouter([]),
\t],
}
`,
    });
    apply(root, literal());
    expect(config(root)).toBe(`import { ApplicationConfig } from "@angular/core"
import { provideRouter } from "@angular/router"
import { provideCritiqs } from "critiqs-angular"

export const appConfig: ApplicationConfig = {
\tproviders: [
\t\tprovideRouter([]),
\t\tprovideCritiqs({ projectId: "${PROJECT}" }),
\t],
}
`);
  });

  test("fills an empty providers list", () => {
    const root = app({ "src/app/app.config.ts": "import { ApplicationConfig } from '@angular/core';\n\nexport const appConfig: ApplicationConfig = { providers: [] };\n" });
    apply(root, literal());
    expect(config(root)).toContain(`{ providers: [provideCritiqs({ projectId: '${PROJECT}' })] }`);
  });

  test("ignores providers lists in comments and strings", () => {
    const root = app({
      "src/app/app.config.ts": CONFIG.replace("export const", "// providers: [old()]\nconst note = 'providers: [';\n/* providers: [] */\nexport const"),
    });
    apply(root, literal());
    expect(angular.find(root)).toHaveLength(1);
  });

  test("honours --entry: a config written inline in main.ts", () => {
    const main = `import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';

bootstrapApplication(App, {
  providers: [],
}).catch((err) => console.error(err));
`;
    const root = app({ "src/main.ts": main });
    const plan = apply(root, literal(), { entry: "src/main.ts" });
    expect(plan.file).toBe(join(root, "src/main.ts"));
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toContain(`  providers: [provideCritiqs({ projectId: '${PROJECT}' })],`);
  });

  test("planning writes nothing", () => {
    const root = app({ "src/app/app.config.ts": CONFIG });
    angular.plan(root, literal(), noEntry);
    expect(config(root)).toBe(CONFIG);
  });
});

describe("updating Critiqs", () => {
  test("changes only the project ID's text", () => {
    const root = app({ "src/app/app.config.ts": CONFIG });
    apply(root, literal(PROJECT, { backend: BACKEND }));
    const before = config(root);
    const plan = apply(root, literal(OTHER, { backend: BACKEND }));
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"] });
    expect(config(root)).toBe(before.replace(PROJECT, OTHER));
  });

  test("adds missing settings, turns on requireProjectId, and keeps the rest", () => {
    const root = app({
      "src/app/app.config.ts": CONFIG.replace("provideRouter(routes)\n", `provideRouter(routes),\n    provideCritiqs({\n      projectId: '${PROJECT}', // the shop\n      requireProjectId: false,\n      version: '1.2',\n    }),\n`).replace(
        "import { routes }",
        "import { provideCritiqs } from 'critiqs-angular';\nimport { routes }",
      ),
    });
    const plan = apply(root, literal(PROJECT, { requireProjectId: true, backend: BACKEND }));
    expect(plan).toMatchObject({ action: "update", changed: ["requireProjectId", "backend"] });
    expect(config(root)).toContain(`    provideCritiqs({
      projectId: '${PROJECT}', // the shop
      requireProjectId: true,
      version: '1.2',
      backend: '${BACKEND}',
    }),`);
  });

  test("edits a function that returns the settings, and follows an aliased import", () => {
    const root = app({
      "src/app/app.config.ts": `import { ApplicationConfig } from '@angular/core';
import { provideCritiqs as critiqs } from 'critiqs-angular';

export const appConfig: ApplicationConfig = {
  providers: [critiqs(() => ({ projectId: '${OTHER}', getContext: () => ({ screen: location.pathname }) }))],
};
`,
    });
    apply(root, literal());
    expect(config(root)).toContain(`critiqs(() => ({ projectId: '${PROJECT}', getContext: () => ({ screen: location.pathname }) }))`);
  });

  test("fills an empty settings object, and leaves the same ID in other quotes alone", () => {
    const root = app({ "src/app/app.config.ts": "import { provideCritiqs } from 'critiqs-angular';\n\nexport const appConfig = { providers: [provideCritiqs({})] };\n" });
    apply(root, literal());
    expect(config(root)).toContain(`[provideCritiqs({ projectId: '${PROJECT}' })]`);
    writeFileSync(join(root, "src/app/app.config.ts"), config(root).replace(`'${PROJECT}'`, `"${PROJECT}"`));
    expect(angular.plan(root, literal(), noEntry)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("refuses a project ID set from code", () => {
    const root = app({
      "src/app/app.config.ts": CONFIG.replace("provideRouter(routes)\n", "provideRouter(routes),\n    provideCritiqs({ projectId: environment.critiqs })\n").replace(
        "import { routes }",
        "import { provideCritiqs } from 'critiqs-angular';\nimport { routes }",
      ),
    });
    const plan = angular.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "expression" });
    if (!plan.ok) expect(plan.message).toContain(`src/app/app.config.ts:10 sets projectId from code`);
    expect(angular.find(root)[0]?.projectId).toEqual({ kind: "expression", text: "environment.critiqs" });
  });

  test.each([
    ["settings passed by name", "provideCritiqs(critiqsSettings)"],
    ["a project ID before a spread", `provideCritiqs({ projectId: '${PROJECT}', ...shared })`],
    ["a shorthand project ID", "provideCritiqs({ projectId })"],
    ["a project ID joined from strings", "provideCritiqs({ projectId: 'j1234' + 'rest' })"],
  ])("refuses %s", (_, call) => {
    const root = app({
      "src/app/app.config.ts": `import { provideCritiqs } from 'critiqs-angular';\n\nexport const appConfig = { providers: [${call}] };\n`,
    });
    const plan = angular.plan(root, literal(OTHER), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "expression" });
    if (!plan.ok) expect(plan.message).toContain("provideCritiqs({ projectId: '");
  });

  test("follows a namespace import, critiqs.provideCritiqs(…)", () => {
    const root = app({
      "src/app/app.config.ts": `import * as critiqs from 'critiqs-angular';\n\nexport const appConfig = { providers: [critiqs.provideCritiqs({ projectId: '${OTHER}' })] };\n`,
    });
    expect(angular.find(root)).toEqual([{ file: join(root, "src/app/app.config.ts"), line: 3, projectId: { kind: "literal", value: OTHER }, backend: null, requireProjectId: false }]);
    expect(apply(root, literal())).toMatchObject({ action: "update", changed: ["projectId"] });
    expect(config(root)).toBe(`import * as critiqs from 'critiqs-angular';\n\nexport const appConfig = { providers: [critiqs.provideCritiqs({ projectId: '${PROJECT}' })] };\n`);
  });

  test.each([
    ["bracket notation", "critiqs['provideCritiqs']"],
    ["optional chaining", "critiqs?.provideCritiqs"],
  ])("follows a namespace import called with %s", (_, callee) => {
    const root = app({
      "src/app/app.config.ts": `import * as critiqs from 'critiqs-angular';\n\nexport const appConfig = { providers: [${callee}({ projectId: '${OTHER}' })] };\n`,
    });
    expect(angular.find(root)).toEqual([{ file: join(root, "src/app/app.config.ts"), line: 3, projectId: { kind: "literal", value: OTHER }, backend: null, requireProjectId: false }]);
    expect(apply(root, literal())).toMatchObject({ action: "update", changed: ["projectId"] });
    expect(config(root)).toBe(`import * as critiqs from 'critiqs-angular';\n\nexport const appConfig = { providers: [${callee}({ projectId: '${PROJECT}' })] };\n`);
  });

  test.each([
    ["destructured from a namespace import", "import * as critiqs from 'critiqs-angular';\n\nconst { provideCritiqs: provide } = critiqs;\nexport const appConfig = { providers: [provide({ projectId: 'X' })] };\n"],
    ["a namespace member held in a variable", "import * as critiqs from 'critiqs-angular';\n\nconst provide = critiqs.provideCritiqs;\nexport const appConfig = { providers: [provide({ projectId: 'X' })] };\n"],
    ["a computed namespace member", "import * as critiqs from 'critiqs-angular';\n\nexport const appConfig = { providers: [critiqs['provide' + 'Critiqs']({ projectId: 'X' })] };\n"],
    ["a named import held in a variable", "import { provideCritiqs } from 'critiqs-angular';\n\nconst provide = provideCritiqs;\nexport const appConfig = { providers: [provide({ projectId: 'X' })] };\n"],
  ])("refuses critiqs-angular %s rather than adding a second provideCritiqs", (_, source) => {
    const root = app({ "src/app/app.config.ts": source });
    const plan = angular.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "unreadable" });
    if (!plan.ok) expect(plan.message).toContain("src/app/app.config.ts:3");
    expect(angular.find(root)).toHaveLength(1);
    expect(config(root)).toBe(source);
  });

  test.each([
    ["under another name", "export { provideCritiqs as withFeedback } from 'critiqs-angular';\n", "{ withFeedback }", "withFeedback"],
    ["under its own name", "export { type CritiqsAngularOptions, provideCritiqs } from 'critiqs-angular';\n", "{ provideCritiqs as withFeedback }", "withFeedback"],
    ["with export *", "export * from 'critiqs-angular';\n", "{ provideCritiqs }", "provideCritiqs"],
    ["as a namespace", "export * as feedback from 'critiqs-angular';\n", "{ feedback }", "feedback.provideCritiqs"],
  ])("refuses a local module that re-exports provideCritiqs %s rather than adding a second one", (_, reexport, imported, callee) => {
    const source = `import { provideRouter } from '@angular/router';\nimport ${imported} from './feedback';\n\nexport const appConfig = { providers: [provideRouter([]), ${callee}({ projectId: '${OTHER}' })] };\n`;
    const root = app({ "src/app/feedback.ts": reexport, "src/app/app.config.ts": source });
    const plan = angular.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "unreadable" });
    if (!plan.ok) expect(plan.message).toContain("src/app/feedback.ts:1");
    expect(angular.find(root)).toMatchObject([{ file: join(root, "src/app/feedback.ts"), line: 1 }]);
    expect(config(root)).toBe(source);
  });

  test("a module that re-exports only critiqs-angular's types doesn't stop setup", () => {
    const root = app({ "src/app/feedback.ts": "export type { CritiqsAngularOptions } from 'critiqs-angular';\nexport { type RestoreRequest } from 'critiqs-angular';\n", "src/app/app.config.ts": CONFIG });
    expect(angular.find(root)).toEqual([]);
    expect(apply(root, literal())).toMatchObject({ action: "install" });
  });

  test("other members of a namespace import, such as its types, are not calls", () => {
    const root = app({
      "src/app/app.config.ts": `import * as critiqs from 'critiqs-angular';\n\nconst settings: critiqs.CritiqsAngularOptions = { projectId: '${OTHER}' };\nexport const appConfig = { providers: [critiqs.provideCritiqs({ projectId: '${OTHER}' })] };\n`,
    });
    expect(angular.find(root).map((usage) => usage.line)).toEqual([4]);
    expect(apply(root, literal())).toMatchObject({ action: "update", line: 4 });
  });

  test("adds the call through a namespace import already there, without a second import", () => {
    const root = app({ "src/app/app.config.ts": CONFIG.replace("import { routes }", "import * as critiqs from 'critiqs-angular';\nimport { routes }") });
    apply(root, literal());
    expect(config(root)).toContain(`    provideRouter(routes),\n    critiqs.provideCritiqs({ projectId: '${PROJECT}' })\n`);
    expect(config(root).match(/critiqs-angular/g)).toHaveLength(1);
  });

  test.each([
    ["from code", "requireProjectId: isProd"],
    ["by shorthand", "requireProjectId"],
  ])("refuses requireProjectId set %s rather than reading it as true", (_, setting) => {
    const root = app({
      "src/app/app.config.ts": `import { provideCritiqs } from 'critiqs-angular';\n\nexport const appConfig = { providers: [provideCritiqs({ projectId: '${PROJECT}', ${setting} })] };\n`,
    });
    const plan = angular.plan(root, literal(PROJECT, { requireProjectId: true }), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "expression" });
    if (!plan.ok) expect(plan.message).toContain("src/app/app.config.ts:3 sets requireProjectId from code");
    expect(angular.find(root)[0]?.requireProjectId).toBe(false);
  });

  test("refuses two calls", () => {
    const call = `provideCritiqs({ projectId: '${PROJECT}' })`;
    const root = app({
      "src/app/app.config.ts": `import { provideCritiqs } from 'critiqs-angular';\n\nexport const appConfig = { providers: [${call}] };\n`,
      "src/app/admin.config.ts": `import { provideCritiqs } from 'critiqs-angular';\n\nexport const adminConfig = { providers: [${call}] };\n`,
    });
    const plan = angular.plan(root, literal(OTHER), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!plan.ok) expect(plan.message).toContain("src/app/admin.config.ts:3");
  });
});

describe("apps setup leaves to the person", () => {
  test("an NgModule app gets complete instructions", () => {
    const root = app({
      "src/app/app.module.ts": "import { NgModule } from '@angular/core';\n\n@NgModule({ declarations: [AppComponent], providers: [], bootstrap: [AppComponent] })\nexport class AppModule {}\n",
    });
    const plan = angular.plan(root, literal(PROJECT, { requireProjectId: true }), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    if (!plan.ok) {
      expect(plan.message).toContain("src/app/app.config.ts");
      expect(plan.message).toContain("import { provideCritiqs } from 'critiqs-angular';");
      expect(plan.message).toContain(`provideCritiqs({ projectId: '${PROJECT}', requireProjectId: true }),`);
      expect(plan.message).toContain("NgModule");
    }
  });

  test("a workspace with two apps asks which", () => {
    const root = app({
      "angular.json": JSON.stringify({
        version: 1,
        projects: {
          shop: { projectType: "application", root: "projects/shop", sourceRoot: "projects/shop/src" },
          admin: { projectType: "application", root: "projects/admin", sourceRoot: "projects/admin/src" },
          ui: { projectType: "library", root: "projects/ui", sourceRoot: "projects/ui/src" },
        },
      }),
      "projects/shop/src/app/app.config.ts": CONFIG,
      "projects/admin/src/app/app.config.ts": CONFIG,
    });
    const plan = angular.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!plan.ok) expect(plan.message).toContain("--entry");
    apply(root, literal(), { entry: "projects/admin/src/app/app.config.ts" });
    expect(angular.find(root).map((usage) => usage.file)).toEqual([join(root, "projects/admin/src/app/app.config.ts")]);
  });

  test("--entry wins over a Critiqs that another app in the workspace has", () => {
    const root = app({
      "angular.json": JSON.stringify({
        version: 1,
        projects: {
          shop: { projectType: "application", root: "", sourceRoot: "src" },
          admin: { projectType: "application", root: "projects/admin", sourceRoot: "projects/admin/src" },
        },
      }),
      "src/app/app.config.ts": CONFIG,
      "projects/admin/src/app/app.config.ts": `import { provideCritiqs } from 'critiqs-angular';\n\nexport const adminConfig = { providers: [provideCritiqs({ projectId: '${OTHER}' })] };\n`,
    });
    const admin = readFileSync(join(root, "projects/admin/src/app/app.config.ts"), "utf8");
    const plan = apply(root, literal(), { entry: "src/app/app.config.ts" });
    expect(plan).toMatchObject({ action: "install", file: join(root, "src/app/app.config.ts") });
    expect(readFileSync(join(root, "projects/admin/src/app/app.config.ts"), "utf8")).toBe(admin);
    expect(angular.find(root).map((usage) => usage.projectId)).toEqual([{ kind: "literal", value: OTHER }, { kind: "literal", value: PROJECT }]);
    // Each app's own call is updated through its --entry.
    expect(apply(root, literal(PROJECT), { entry: "projects/admin/src/app/app.config.ts" })).toMatchObject({ action: "update", file: join(root, "projects/admin/src/app/app.config.ts") });
  });

  test("--entry in an app whose Critiqs is in another file refuses rather than adding a second", () => {
    const main = "import { bootstrapApplication } from '@angular/platform-browser';\nimport { App } from './app/app';\n\nbootstrapApplication(App, { providers: [] });\n";
    const root = app({
      "src/main.ts": main,
      "src/app/app.config.ts": CONFIG.replace("provideRouter(routes)\n", `provideRouter(routes),\n    provideCritiqs({ projectId: '${OTHER}' })\n`).replace("import { routes }", "import { provideCritiqs } from 'critiqs-angular';\nimport { routes }"),
    });
    const plan = angular.plan(root, literal(), { entry: "src/main.ts" });
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!plan.ok) expect(plan.message).toContain("src/app/app.config.ts:10");
  });

  test("--entry in an app whose owner can't be told (no angular.json) refuses when the checkout already has Critiqs", () => {
    const main = "import { bootstrapApplication } from '@angular/platform-browser';\nimport { mergeApplicationConfig } from '@angular/core';\nimport { appConfig } from './app/app.config';\nimport { App } from './app/app';\n\nbootstrapApplication(App, mergeApplicationConfig(appConfig, { providers: [] }));\n";
    const root = app({
      "src/main.ts": main,
      "src/app/app.config.ts": CONFIG.replace("provideRouter(routes)\n", `provideRouter(routes),\n    provideCritiqs({ projectId: '${OTHER}' })\n`).replace("import { routes }", "import { provideCritiqs } from 'critiqs-angular';\nimport { routes }"),
    });
    rmSync(join(root, "angular.json"));
    const plan = angular.plan(root, literal(), { entry: "src/main.ts" });
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!plan.ok) expect(plan.message).toContain("src/app/app.config.ts:10");
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toBe(main);
    // Its own --entry still updates it.
    expect(apply(root, literal(), { entry: "src/app/app.config.ts" })).toMatchObject({ action: "update" });
  });

  test("--entry counts a Critiqs outside every app's folder, as in a shared library, as possibly the app's own", () => {
    const root = app({
      "angular.json": JSON.stringify({
        version: 1,
        projects: {
          shop: { projectType: "application", root: "projects/shop", sourceRoot: "projects/shop/src" },
          ui: { projectType: "library", root: "projects/ui", sourceRoot: "projects/ui/src" },
        },
      }),
      "projects/shop/src/app/app.config.ts": CONFIG,
      "projects/ui/src/lib/review.ts": `import { provideCritiqs } from 'critiqs-angular';\n\nexport const review = [provideCritiqs({ projectId: '${OTHER}' })];\n`,
    });
    const plan = angular.plan(root, literal(), { entry: "projects/shop/src/app/app.config.ts" });
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!plan.ok) expect(plan.message).toContain("projects/ui/src/lib/review.ts:3");
  });

  test("--entry naming a missing file, or a component", () => {
    const root = app({
      "src/app/app.config.ts": CONFIG,
      "src/app/app.ts": "import { Component } from '@angular/core';\n\n@Component({ selector: 'app-root', providers: [], template: '' })\nexport class App {}\n",
    });
    expect(angular.plan(root, literal(), { entry: "src/nope.ts" })).toMatchObject({ ok: false, reason: "manual" });
    expect(angular.plan(root, literal(), { entry: "src/app/app.ts" })).toMatchObject({ ok: false, reason: "manual" });
  });

  test("a config with no providers list, or another provideCritiqs", () => {
    const empty = app({ "src/app/app.config.ts": "export const appConfig = {};\n" });
    expect(angular.plan(empty, literal(), noEntry)).toMatchObject({ ok: false, reason: "manual" });
    const taken = app({ "src/app/app.config.ts": CONFIG.replace("export const", "function provideCritiqs() {}\nexport const") });
    expect(angular.plan(taken, literal(), noEntry)).toMatchObject({ ok: false, reason: "unreadable" });
  });
});
