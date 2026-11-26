import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";
import type { EnvConvention, Plan, PlanOptions, Settings } from "../bin/frameworks/types.d.mts";

const astro = FRAMEWORKS.find((adapter) => adapter.id === "astro")!;

const PROJECT = "j12345678901234567890123456789012";
const OTHER = "k98765432109876543210987654321098";
const BACKEND = "https://critiqs.example.com/critiqs";

// What `npm create astro@latest -- --template minimal` (create-astro 5.3.2, Astro 7.4) writes.
const STARTER_PACKAGE = JSON.stringify({ name: "starter", type: "module", version: "0.0.1", scripts: { dev: "astro dev", build: "astro build" }, dependencies: { astro: "^7.4.13" } }, null, 2);
const STARTER_CONFIG = `// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({});
`;

function app(files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-astro-"));
  for (const [name, text] of Object.entries({ "package.json": STARTER_PACKAGE, ...files })) writeFileSync(join(root, name), text);
  return root;
}

const literal = (projectId = PROJECT, extra: Partial<Settings> = {}): Settings => ({ projectId: { literal: projectId }, requireProjectId: false, ...extra });
const fromEnv = (root: string, suffix = "", extra: Partial<Settings> = {}): Settings => ({ projectId: { env: astro.env(root, suffix)! }, requireProjectId: true, ...extra });
const none: PlanOptions = { entry: null };

function ok(plan: Plan) {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  return plan;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Writes the plan, checks every written config parses, still has its one critiqs() call, and a second plan changes nothing, and returns the config's text. */
function apply(root: string, settings: Settings, options = none, file = "astro.config.mjs") {
  const plan = ok(astro.plan(root, settings, options));
  for (const write of plan.writes) {
    expect(() => transpiler.transformSync(write.source)).not.toThrow();
    writeFileSync(write.file, write.source);
  }
  // find() reads the one config Astro loads; a config chosen with --entry among several is checked by planning again.
  if (options.entry === null) expect(astro.find(root)).toHaveLength(1);
  const again = ok(astro.plan(root, settings, options));
  expect(again.action).toBe("unchanged");
  expect(again.writes).toEqual([]);
  return { plan, text: readFileSync(join(root, file), "utf8") };
}

test("detects Astro apps before the libraries they use", () => {
  expect(detectApp(app({}))?.id).toBe("astro");
  const withReact = JSON.stringify({ dependencies: { astro: "^7.4.13", "@astrojs/react": "^5", react: "^19", "react-dom": "^19" } });
  expect(detectApp(app({ "package.json": withReact }))?.id).toBe("astro");
});

test("the project ID comes from PUBLIC_CRITIQS_PROJECT_ID in .env, read when the site builds", () => {
  const env = astro.env(app({}), "");
  expect(env).toMatchObject({ variable: "PUBLIC_CRITIQS_PROJECT_ID", expression: "import.meta.env.PUBLIC_CRITIQS_PROJECT_ID", readsAt: "build", localFile: ".env" });
  expect(env?.deploymentAdvice).toContain("build");
  expect(astro.env(app({}), "_WEB")?.variable).toBe("PUBLIC_CRITIQS_PROJECT_ID_WEB");
});

describe("where this computer's project ID goes", () => {
  const VARIABLE = "PUBLIC_CRITIQS_PROJECT_ID";
  test("the .env file that already sets it for both dev and build", () => {
    expect(astro.env(app({ ".env": `${VARIABLE}=old\n` }), "")?.localFile).toBe(".env");
    // Astro (Vite) reads .env.local over .env in every mode.
    expect(astro.env(app({ ".env": `${VARIABLE}=old\n`, ".env.local": `export ${VARIABLE}="old"\n` }), "")?.localFile).toBe(".env.local");
    expect(astro.env(app({ ".env.local": `OTHER=1\n` }), "")?.localFile).toBe(".env");
  });

  test("a mode's own file that sets it stops setup, naming that file", () => {
    for (const file of [".env.development.local", ".env.development", ".env.production", ".env.production.local"]) {
      const root = app({ "astro.config.mjs": STARTER_CONFIG, ".env": `${VARIABLE}=old\n`, [file]: `# old project\n${VARIABLE}=old\n` });
      // `problem` tells the setup CLI to change nothing.
      const env = astro.env(root, "") as EnvConvention & { problem?: string | null };
      expect(env.problem).toContain(file);
      const plan = astro.plan(root, fromEnv(root), none);
      if (plan.ok) throw new Error(`Expected a refusal for ${file}, got ${plan.action}`);
      expect(plan.reason).toBe("ambiguous");
      expect(plan.message).toContain(`${VARIABLE} is already set in ${file}`);
      expect(plan.message).toContain("npm install critiqs-astro");
      // A project ID written into the config doesn't read the variable, so nothing stops it.
      expect(ok(astro.plan(root, literal(), none)).action).toBe("install");
    }
  });
});

describe("the starter's config", () => {
  test("gets the import and a critiqs() integration with a written project ID", () => {
    const root = app({ "astro.config.mjs": STARTER_CONFIG });
    const { plan, text } = apply(root, literal(PROJECT, { backend: BACKEND, requireProjectId: true }));
    expect(plan).toMatchObject({ action: "install", line: 7, changed: ["projectId", "requireProjectId", "backend"] });
    expect(text).toBe(`// @ts-check
import { defineConfig } from 'astro/config';
import critiqs from 'critiqs-astro';

// https://astro.build/config
export default defineConfig({
  integrations: [critiqs({ projectId: '${PROJECT}', requireProjectId: true, backend: '${BACKEND}' })],
});
`);
    expect(plan.preview).toContain("import critiqs from 'critiqs-astro';");
    expect(plan.preview).toContain("integrations: [critiqs(");
    expect(astro.find(root)).toEqual([
      { file: join(root, "astro.config.mjs"), line: 7, projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: BACKEND }, requireProjectId: true },
    ]);
  });

  test("reads the project ID from the environment with a bare critiqs()", () => {
    const root = app({ "astro.config.mjs": STARTER_CONFIG });
    const { text } = apply(root, fromEnv(root));
    expect(text).toContain("  integrations: [critiqs()],\n");
    expect(astro.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "PUBLIC_CRITIQS_PROJECT_ID" }, backend: null, requireProjectId: true }]);
  });

  test("names a workspace app's own variable", () => {
    const root = app({ "astro.config.mjs": STARTER_CONFIG });
    const { text } = apply(root, fromEnv(root, "_WEB"));
    expect(text).toContain("integrations: [critiqs({ projectIdVariable: 'PUBLIC_CRITIQS_PROJECT_ID_WEB' })],");
    expect(astro.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "PUBLIC_CRITIQS_PROJECT_ID_WEB" }, requireProjectId: true }]);
  });
});

describe("configs that already have settings", () => {
  test("joins an integrations list on one line", () => {
    const root = app({
      "astro.config.mjs": `// @ts-check\nimport { defineConfig } from 'astro/config';\nimport react from '@astrojs/react';\n\n// https://astro.build/config\nexport default defineConfig({\n  integrations: [react()],\n});\n`,
    });
    const { text } = apply(root, literal());
    expect(text).toBe(
      `// @ts-check\nimport { defineConfig } from 'astro/config';\nimport react from '@astrojs/react';\nimport critiqs from 'critiqs-astro';\n\n// https://astro.build/config\nexport default defineConfig({\n  integrations: [react(), critiqs({ projectId: '${PROJECT}' })],\n});\n`,
    );
  });

  test("adds a line to a list written one item per line, keeping its indent and trailing comma", () => {
    const config = `import { defineConfig } from "astro/config"\nimport mdx from "@astrojs/mdx"\nimport sitemap from "@astrojs/sitemap"\n\nexport default defineConfig({\n\tsite: "https://example.com",\n\tintegrations: [\n\t\tmdx(),\n\t\tsitemap({ filter: (page) => page !== "https://example.com/secret/" }),\n\t],\n})\n`;
    const root = app({ "astro.config.ts": config });
    const { text } = apply(root, fromEnv(root), none, "astro.config.ts");
    expect(text).toBe(
      `import { defineConfig } from "astro/config"\nimport mdx from "@astrojs/mdx"\nimport sitemap from "@astrojs/sitemap"\nimport critiqs from "critiqs-astro"\n\nexport default defineConfig({\n\tsite: "https://example.com",\n\tintegrations: [\n\t\tmdx(),\n\t\tsitemap({ filter: (page) => page !== "https://example.com/secret/" }),\n\t\tcritiqs(),\n\t],\n})\n`,
    );
  });

  test("adds integrations after the other settings", () => {
    const config = `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n    site: 'https://example.com', // the live site\n    output: 'static'\n});\n`;
    const root = app({ "astro.config.mjs": config });
    const { text } = apply(root, fromEnv(root));
    expect(text).toBe(
      `import { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro';\n\nexport default defineConfig({\n    site: 'https://example.com', // the live site\n    output: 'static',\n    integrations: [critiqs()]\n});\n`,
    );
  });

  test("ignores critiqs() in comments and strings", () => {
    const config = `import { defineConfig } from 'astro/config';\n// Later: critiqs({ projectId: 'x' })\nexport default defineConfig({ site: 'https://example.com/critiqs(' });\n`;
    const root = app({ "astro.config.mjs": config });
    const { text } = apply(root, literal());
    expect(text).toContain(`export default defineConfig({ site: 'https://example.com/critiqs(', integrations: [critiqs({ projectId: '${PROJECT}' })] });`);
  });

  test("joins an integrations list under a quoted key", () => {
    for (const key of [`"integrations"`, `'integrations'`]) {
      const root = app({ "astro.config.mjs": `import react from '@astrojs/react';\nexport default {\n  ${key}: [react()],\n};\n` });
      expect(apply(root, fromEnv(root)).text).toBe(`import react from '@astrojs/react';\nimport critiqs from 'critiqs-astro';\nexport default {\n  ${key}: [react(), critiqs()],\n};\n`);
    }
  });

  test("joins the last integrations list, the one Astro gets, after any spread before it", () => {
    const config = `import base from './base.config.mjs';\nimport react from '@astrojs/react';\nexport default {\n  ...base,\n  integrations: [],\n  integrations: [react()],\n};\n`;
    const root = app({ "astro.config.mjs": config });
    expect(apply(root, fromEnv(root)).text).toContain("  integrations: [],\n  integrations: [react(), critiqs()],\n");
  });

  test("works in a config that exports a plain object", () => {
    const root = app({ "astro.config.mjs": `export default {\n  site: 'https://example.com',\n};\n` });
    const { text } = apply(root, literal());
    expect(text).toBe(`import critiqs from 'critiqs-astro';\nexport default {\n  site: 'https://example.com',\n  integrations: [critiqs({ projectId: '${PROJECT}' })],\n};\n`);
  });
});

describe("comments, line endings and regular expressions in the config", () => {
  test("a comment after the last setting stays on its line, with the comma before it", () => {
    const config = `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  site: 'https://example.com',\n  output: 'static' // for now\n});\n`;
    const root = app({ "astro.config.mjs": config });
    const { text } = apply(root, fromEnv(root));
    expect(text).toBe(`import { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro';\n\nexport default defineConfig({\n  site: 'https://example.com',\n  output: 'static', // for now\n  integrations: [critiqs()]\n});\n`);
  });

  test("a comment after the last integration stays with it", () => {
    const list = (items: string) => `import { defineConfig } from 'astro/config';\nimport mdx from '@astrojs/mdx';\n\nexport default defineConfig({\n  integrations: [\n${items}  ],\n});\n`;
    const withImport = (text: string) => text.replace("import mdx from '@astrojs/mdx';\n", "import mdx from '@astrojs/mdx';\nimport critiqs from 'critiqs-astro';\n");
    const root = app({ "astro.config.mjs": list("    mdx() // the docs\n") });
    expect(apply(root, fromEnv(root)).text).toBe(withImport(list("    mdx(), // the docs\n    critiqs()\n")));
    const trailing = app({ "astro.config.mjs": list("    mdx(), // the docs\n") });
    expect(apply(trailing, fromEnv(trailing)).text).toBe(withImport(list("    mdx(), // the docs\n    critiqs(),\n")));
    const inline = app({ "astro.config.mjs": `import mdx from '@astrojs/mdx';\nexport default { integrations: [mdx() /* docs */] };\n` });
    expect(apply(inline, fromEnv(inline)).text).toContain("integrations: [mdx(), critiqs() /* docs */]");
  });

  test("a list or config holding only comments gets the integration as its only item", () => {
    const emptyList = app({ "astro.config.mjs": `export default {\n  integrations: [/* none yet */],\n};\n` });
    expect(apply(emptyList, fromEnv(emptyList)).text).toBe(`import critiqs from 'critiqs-astro';\nexport default {\n  integrations: [/* none yet */ critiqs()],\n};\n`);
    const commentedOut = app({ "astro.config.mjs": `export default {\n  integrations: [\n    // react(),\n  ],\n};\n` });
    expect(apply(commentedOut, fromEnv(commentedOut)).text).toBe(`import critiqs from 'critiqs-astro';\nexport default {\n  integrations: [\n    // react(),\n    critiqs(),\n  ],\n};\n`);
    const emptyConfig = app({ "astro.config.mjs": `import { defineConfig } from 'astro/config';\nexport default defineConfig({ /* empty */ });\n` });
    expect(apply(emptyConfig, fromEnv(emptyConfig)).text).toBe(
      `import { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro';\nexport default defineConfig({ /* empty */\n  integrations: [critiqs()],\n});\n`,
    );
  });

  test("a config with Windows line endings keeps them", () => {
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    const root = app({ "astro.config.mjs": crlf(`import { defineConfig } from "astro/config"\nimport mdx from "@astrojs/mdx"\n\nexport default defineConfig({\n  integrations: [\n    mdx(), // the docs\n  ],\n})\n`) });
    const { text } = apply(root, literal());
    expect(text).toBe(crlf(`import { defineConfig } from "astro/config"\nimport mdx from "@astrojs/mdx"\nimport critiqs from "critiqs-astro"\n\nexport default defineConfig({\n  integrations: [\n    mdx(), // the docs\n    critiqs({ projectId: "${PROJECT}" }),\n  ],\n})\n`));
    const starter = app({ "astro.config.mjs": crlf(STARTER_CONFIG) });
    expect(apply(starter, fromEnv(starter)).text).toBe(crlf(`// @ts-check\nimport { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro';\n\n// https://astro.build/config\nexport default defineConfig({\n  integrations: [critiqs()],\n});\n`));
    const call = app({ "astro.config.mjs": crlf(`import critiqs from 'critiqs-astro';\nexport default {\n  integrations: [critiqs({\n    projectId: '${OTHER}',\n  })],\n};\n`) });
    const updated = apply(call, literal(PROJECT, { requireProjectId: true })).text;
    expect(updated).toBe(crlf(`import critiqs from 'critiqs-astro';\nexport default {\n  integrations: [critiqs({\n    projectId: '${PROJECT}',\n    requireProjectId: true,\n  })],\n};\n`));
    expect(astro.find(call)).toMatchObject([{ line: 3, projectId: { kind: "literal", value: PROJECT } }]);
  });

  test("a block comment running on past the last integration's line stays closed, with critiqs() in code", () => {
    const list = (items: string) => `import { defineConfig } from 'astro/config';\nimport mdx from '@astrojs/mdx';\n\nexport default defineConfig({\n  integrations: [\n${items}  ],\n});\n`;
    const withImport = (text: string) => text.replace("import mdx from '@astrojs/mdx';\n", "import mdx from '@astrojs/mdx';\nimport critiqs from 'critiqs-astro';\n");
    const trailing = app({ "astro.config.mjs": list("    mdx(), /* explanation\n       continues here */\n") });
    expect(apply(trailing, fromEnv(trailing)).text).toBe(withImport(list("    mdx(),\n    critiqs(), /* explanation\n       continues here */\n")));
    const bare = app({ "astro.config.mjs": list("    mdx() /* explanation\n       continues here */\n") });
    expect(apply(bare, fromEnv(bare)).text).toBe(withImport(list("    mdx(),\n    critiqs() /* explanation\n       continues here */\n")));
    const setting = app({ "astro.config.mjs": `export default {\n  site: 'https://example.com', /* the live\n     site */\n};\n` });
    expect(apply(setting, fromEnv(setting)).text).toBe(`import critiqs from 'critiqs-astro';\nexport default {\n  site: 'https://example.com',\n  integrations: [critiqs()], /* the live\n     site */\n};\n`);
  });

  test("an import line ending in a block comment that runs on keeps the new import out of it", () => {
    const config = `import { defineConfig } from 'astro/config'; /* settings\n   for the docs */\nexport default defineConfig({});\n`;
    const root = app({ "astro.config.mjs": config });
    expect(apply(root, fromEnv(root)).text).toBe(`import { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro'; /* settings\n   for the docs */\nexport default defineConfig({\n  integrations: [critiqs()],\n});\n`);
    const lineComment = app({ "astro.config.mjs": `import { defineConfig } from 'astro/config'; // settings\nexport default defineConfig({});\n` });
    expect(apply(lineComment, fromEnv(lineComment)).text).toStartWith(`import { defineConfig } from 'astro/config'; // settings\nimport critiqs from 'critiqs-astro';\n`);
  });

  test("brackets and quotes inside regular expressions don't count", () => {
    const config = `import { defineConfig } from 'astro/config';\nimport sitemap from '@astrojs/sitemap';\n\nexport default defineConfig({\n  integrations: [\n    sitemap({ filter: (page) => !/\\/(secret|draft['"\\]])\\//giu.test(page) }),\n  ],\n  site: 'https://example.com', // a / b\n});\n`;
    const root = app({ "astro.config.mjs": config });
    const { text } = apply(root, fromEnv(root));
    expect(text).toContain(`  integrations: [\n    sitemap({ filter: (page) => !/\\/(secret|draft['"\\]])\\//giu.test(page) }),\n    critiqs(),\n  ],\n`);
  });
});

describe("an existing critiqs()", () => {
  const configWith = (call: string) => `// @ts-check\nimport { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro';\n\nexport default defineConfig({\n  integrations: [${call}],\n});\n`;

  test("gets the new project ID and keeps its other options", () => {
    const root = app({ "astro.config.mjs": configWith(`critiqs({ projectId: '${OTHER}', version: process.env.COMMIT_SHA })`) });
    const { plan, text } = apply(root, literal());
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"], line: 6 });
    expect(text).toBe(configWith(`critiqs({ projectId: '${PROJECT}', version: process.env.COMMIT_SHA })`));
  });

  test("moves from a written project ID to the environment, keeping its backend", () => {
    const root = app({ "astro.config.mjs": configWith(`critiqs({ projectId: '${OTHER}', backend: '${BACKEND}' })`) });
    const { plan, text } = apply(root, fromEnv(root));
    expect(plan.changed).toEqual(["projectId"]);
    expect(text).toBe(configWith(`critiqs({ backend: '${BACKEND}' })`));
  });

  test("moves to the environment from a call whose only option has a trailing comma", () => {
    for (const call of [`critiqs({ projectId: '${OTHER}' },)`, `critiqs(\n    { projectId: '${OTHER}' },\n  )`]) {
      const root = app({ "astro.config.mjs": configWith(call) });
      const { plan, text } = apply(root, fromEnv(root));
      expect(plan.changed).toEqual(["projectId"]);
      expect(text).toBe(configWith("critiqs()"));
    }
  });

  test("updates the call in the last integrations list, the one Astro gets", () => {
    const config = `import react from '@astrojs/react';\nimport critiqs from 'critiqs-astro';\nexport default {\n  integrations: [react()],\n  'integrations': [critiqs({ projectId: '${OTHER}' })],\n};\n`;
    const root = app({ "astro.config.mjs": config });
    expect(apply(root, literal()).text).toBe(config.replace(OTHER, PROJECT));
  });

  test("a new project ID keeps a self-hosted backend the settings don't name", () => {
    const root = app({ "astro.config.mjs": configWith(`critiqs({ projectId: 'old', backend: 'https://my-backend.test' })`) });
    const { plan, text } = apply(root, literal());
    expect(plan.changed).toEqual(["projectId"]);
    expect(text).toBe(configWith(`critiqs({ projectId: '${PROJECT}', backend: 'https://my-backend.test' })`));
    expect(astro.find(root)).toMatchObject([{ backend: { kind: "literal", value: "https://my-backend.test" } }]);
    const fromCode = app({ "astro.config.mjs": configWith(`critiqs({ projectId: 'old', backend: process.env.BACKEND })`) });
    expect(apply(fromCode, literal()).text).toBe(configWith(`critiqs({ projectId: '${PROJECT}', backend: process.env.BACKEND })`));
    const replaced = app({ "astro.config.mjs": configWith(`critiqs({ projectId: 'old', backend: 'https://my-backend.test' })`) });
    expect(apply(replaced, literal(PROJECT, { backend: BACKEND })).text).toBe(configWith(`critiqs({ projectId: '${PROJECT}', backend: '${BACKEND}' })`));
  });

  test("keeps options written one per line", () => {
    const call = `critiqs({\n    projectId: '${OTHER}',\n    version: '1.2.0',\n  })`;
    const root = app({ "astro.config.mjs": configWith(call) });
    const { text } = apply(root, literal(PROJECT, { requireProjectId: true }));
    expect(text).toBe(configWith(`critiqs({\n    projectId: '${PROJECT}',\n    version: '1.2.0',\n    requireProjectId: true,\n  })`));
  });

  test("is unchanged when it already says the same thing another way", () => {
    const root = app({ "astro.config.mjs": configWith(`critiqs({ requireProjectId: true, projectIdVariable: "PUBLIC_CRITIQS_PROJECT_ID" })`) });
    expect(ok(astro.plan(root, fromEnv(root), none)).action).toBe("unchanged");
  });

  test("turns an explicit requireProjectId: false back on for the environment", () => {
    const root = app({ "astro.config.mjs": configWith("critiqs({ requireProjectId: false })") });
    const { plan, text } = apply(root, fromEnv(root));
    expect(plan.changed).toEqual(["requireProjectId"]);
    expect(text).toBe(configWith("critiqs()"));
  });

  test("under another name", () => {
    const config = `import { defineConfig } from 'astro/config';\nimport feedback from 'critiqs-astro';\nexport default defineConfig({ integrations: [feedback()] });\n`;
    const root = app({ "astro.config.mjs": config });
    const { text } = apply(root, literal());
    expect(text).toContain(`integrations: [feedback({ projectId: '${PROJECT}' })]`);
  });
});

describe("where setup refuses and says what to do by hand", () => {
  const refusal = (root: string, settings: Settings, options = none) => {
    const plan = astro.plan(root, settings, options);
    if (plan.ok) throw new Error(`Expected a refusal, got ${plan.action}`);
    expect(plan.message).toContain("npm install critiqs-astro");
    expect(plan.message).toContain("import critiqs from 'critiqs-astro';");
    return plan;
  };

  test("several config files", () => {
    const root = app({ "astro.config.mjs": STARTER_CONFIG, "astro.config.ts": STARTER_CONFIG });
    const plan = refusal(root, literal());
    expect(plan.reason).toBe("ambiguous");
    expect(plan.message).toContain("astro.config.mjs, astro.config.ts");
  });

  test("two critiqs() calls", () => {
    const config = `import critiqs from 'critiqs-astro';\nexport default { integrations: [critiqs(), critiqs()] };\n`;
    expect(refusal(app({ "astro.config.mjs": config }), literal()).reason).toBe("ambiguous");
  });

  test("options given as code", () => {
    const config = `import critiqs from 'critiqs-astro';\nconst options = { projectId: 'x' };\nexport default { integrations: [critiqs(options)] };\n`;
    expect(refusal(app({ "astro.config.mjs": config }), literal()).reason).toBe("expression");
  });

  test("a project ID read with code", () => {
    const config = `import critiqs from 'critiqs-astro';\nexport default { integrations: [critiqs({ projectId: process.env.ID })] };\n`;
    const root = app({ "astro.config.mjs": config });
    expect(refusal(root, literal()).reason).toBe("expression");
    expect(astro.find(root)).toMatchObject([{ projectId: { kind: "expression", text: "process.env.ID" } }]);
  });

  test("integrations kept in a variable", () => {
    const config = `import { defineConfig } from 'astro/config';\nconst integrations = [];\nexport default defineConfig({ integrations });\n`;
    expect(refusal(app({ "astro.config.mjs": config }), literal()).reason).toBe("unreadable");
  });

  test("settings spread from elsewhere", () => {
    const config = `import { defineConfig } from 'astro/config';\nimport base from './base.config.mjs';\nexport default defineConfig({ ...base, site: 'https://example.com' });\n`;
    expect(refusal(app({ "astro.config.mjs": config }), literal()).reason).toBe("expression");
  });

  test("settings spread, or named with code, after the integrations list, which may replace it", () => {
    for (const after of ["...other", "[key]: []", "...(dev ? { integrations: [] } : {})"]) {
      const config = `import react from '@astrojs/react';\nimport other from './other.mjs';\nconst key = 'integrations';\nconst dev = false;\nexport default {\n  integrations: [react()],\n  ${after},\n};\n`;
      const root = app({ "astro.config.mjs": config });
      const plan = refusal(root, literal());
      expect(plan.reason).toBe("expression");
      expect(plan.message).toContain("after `integrations`");
    }
  });

  test("a critiqs() in an integrations list Astro doesn't use", () => {
    const configs = [
      // A later spread may replace the list holding it.
      `import critiqs from 'critiqs-astro';\nimport overrides from './overrides.mjs';\nexport default {\n  integrations: [critiqs({ projectId: 'old' })],\n  ...overrides,\n};\n`,
      // A later integrations key replaces it.
      `import critiqs from 'critiqs-astro';\nexport default {\n  integrations: [critiqs({ projectId: 'old' })],\n  "integrations": [],\n};\n`,
      // Kept elsewhere, while the config sets integrations twice.
      `import critiqs from 'critiqs-astro';\nconst list = [critiqs({ projectId: 'old' })];\nexport default { integrations: list, integrations: [] };\n`,
      // Somewhere else in the config.
      `import critiqs from 'critiqs-astro';\nexport default { vite: { plugins: [critiqs({ projectId: 'old' })] } };\n`,
    ];
    for (const config of configs) {
      const root = app({ "astro.config.mjs": config });
      const plan = refusal(root, literal());
      expect(plan.reason).toBe("expression");
      expect(plan.message).toContain("integrations");
    }
  });

  test("a config built some other way", () => {
    const config = `import { defineConfig } from 'astro/config';\nconst config = defineConfig({});\nexport default config;\n`;
    expect(refusal(app({ "astro.config.mjs": config }), literal()).reason).toBe("unreadable");
  });

  test("a variable Astro doesn't give the browser", () => {
    const root = app({ "astro.config.mjs": STARTER_CONFIG });
    const env = { ...astro.env(root, "")!, variable: "CRITIQS_PROJECT_ID" };
    expect(refusal(root, { projectId: { env }, requireProjectId: true }).reason).toBe("manual");
  });
});

test("creates the config when the app has none", () => {
  const root = app({});
  const { plan, text } = apply(root, literal());
  expect(plan.writes[0]?.original).toBeNull();
  expect(text).toContain(`import critiqs from 'critiqs-astro';`);
  expect(text).toContain(`integrations: [critiqs({ projectId: '${PROJECT}' })],`);
});

test("edits the config the person chose", () => {
  const root = app({ "astro.config.mjs": STARTER_CONFIG, "astro.config.ts": STARTER_CONFIG });
  const { text } = apply(root, literal(), { entry: "astro.config.ts" }, "astro.config.ts");
  expect(text).toContain("critiqs({");
  expect(readFileSync(join(root, "astro.config.mjs"), "utf8")).toBe(STARTER_CONFIG);
  const missing = astro.plan(root, literal(), { entry: "site.config.mjs" });
  expect(missing.ok).toBe(false);
});

test("manual instructions are complete for each kind of project ID", () => {
  const root = app({});
  expect(astro.manual(literal(PROJECT, { requireProjectId: true }))).toContain(`integrations: [critiqs({ projectId: '${PROJECT}', requireProjectId: true })],`);
  const fromEnvironment = astro.manual(fromEnv(root));
  expect(fromEnvironment).toContain("integrations: [critiqs()],");
  expect(fromEnvironment).toContain("Set PUBLIC_CRITIQS_PROJECT_ID to your project ID in .env");
});

test("with two config files, find reports the integration in the one Astro loads (.mjs before .ts)", () => {
  const root = app({
    "astro.config.mjs": "import { defineConfig } from 'astro/config';\nimport critiqs from 'critiqs-astro';\n\nexport default defineConfig({\n  integrations: [critiqs({ projectId: 'j11111111111111111111111111111111' })],\n});\n",
    "astro.config.ts": "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n",
  });
  const found = astro.find(root);
  expect(found).toHaveLength(1);
  expect(found[0]!.file).toEndWith("astro.config.mjs");
  expect(found[0]!.projectId).toEqual({ kind: "literal", value: "j11111111111111111111111111111111" });
});
