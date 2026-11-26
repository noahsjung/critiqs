// SvelteKit setup: <Critiqs /> from critiqs-svelte/kit, which reports routes
// and restores them with SvelteKit's router, in src/routes/+layout.svelte, the
// layout every page renders, created when the app has none. The component
// renders nothing on the server, so server rendering and prerendering are
// unaffected. Editing is shared with Svelte setup (./svelte.mjs).
//
// A project ID set per deployment is the public variable
// PUBLIC_CRITIQS_PROJECT_ID, read when the app runs rather than inlined when
// it is built:
// - SvelteKit 3 reads only variables `src/env.ts` declares, from
//   `$app/env/public`; setup declares it public and optional (`static` left
//   off). Its `$env/*` modules are deprecated aliases of the same thing.
// - SvelteKit 2 reads it from `$env/dynamic/public`, in the browser only
//   (`browser ? env.NAME : undefined`): SvelteKit 2 fails a prerendered page
//   that reads it while rendering, and Critiqs renders nothing on the server
//   anyway. `$env/static/public` fails the build wherever the variable is
//   unset, which is exactly how a deployment turns Critiqs off.
// Read at run time, one build serves every deployment, each with its own
// project or none; a prerendered or static site takes the value its build had.
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { dependsOn, readPackageJson, readText } from "./shared.mjs";
import { attributeText, chosenEntry, configFile, findUsages, KIT_MODULE, PACKAGE, planSvelte, shown, wantedAttributes } from "./svelte.mjs";

const DECLARED_MODULE = "$app/env/public";
const DYNAMIC_MODULE = "$env/dynamic/public";
const ENVIRONMENT_MODULE = "$app/environment";
const ENV_FILES = ["src/env.ts", "src/env.js", "src/env/index.ts", "src/env/index.js"];
const DESCRIPTION = "The Critiqs project for this deployment. Critiqs stays hidden where it is unset.";

/** The installed SvelteKit's version as [major, minor], or the lowest one package.json allows; the current one when neither says. */
function kitVersion(root) {
  let version = null;
  try {
    version = createRequire(join(resolve(root), "package.json"))("@sveltejs/kit/package.json").version;
  } catch {
    const manifest = readPackageJson(root) ?? {};
    version = manifest.devDependencies?.["@sveltejs/kit"] ?? manifest.dependencies?.["@sveltejs/kit"] ?? "";
  }
  const match = /(\d+)(?:\.(\d+))?/.exec(version);
  return match === null ? [3, 0] : [Number(match[1]), Number(match[2] ?? 0)];
}

/** critiqs-svelte/kit, with SvelteKit's router, needs `$app/state` and `resolve` (SvelteKit 2.26); older apps get the component without it. */
function componentModule(root) {
  const [major, minor] = kitVersion(root);
  return major > 2 || (major === 2 && minor >= 26) ? KIT_MODULE : PACKAGE;
}

const configText = (root) => [configFile(root, "svelte"), configFile(root, "vite")].map((file) => (file === null ? "" : (readText(file) ?? ""))).join("\n");

/** "declared" (SvelteKit 3, or 2 with explicit environment variables) or "dynamic" (SvelteKit 2). */
function envStyle(root) {
  if (kitVersion(root)[0] >= 3) return "declared";
  return /\bexplicitEnvironmentVariables\s*:\s*true\b/.test(configText(root)) ? "declared" : "dynamic";
}

/** Which style an `EnvConvention` from `env` describes: its expression is the bare variable when declared. */
const styleOf = (convention) => (convention.expression === convention.variable ? "declared" : "dynamic");

/** The local name a component's value import of `name` from `from` has, or `name` when it has none. */
const localName = (parsed, name, from) =>
  parsed.imports.filter((entry) => entry.from === from).flatMap((entry) => entry.bindings).find((candidate) => candidate.imported === name)?.local ?? name;

/** The code that reads the variable in one component, reusing imports it already has. */
function binding(parsed, convention) {
  if (styleOf(convention) === "declared") {
    return { code: localName(parsed, convention.variable, DECLARED_MODULE), imports: [{ name: convention.variable, from: DECLARED_MODULE }] };
  }
  return {
    code: `${localName(parsed, "browser", ENVIRONMENT_MODULE)} ? ${localName(parsed, "env", DYNAMIC_MODULE)}.${convention.variable} : undefined`,
    imports: [
      { name: "env", from: DYNAMIC_MODULE },
      { name: "browser", from: ENVIRONMENT_MODULE },
    ],
    // `env.NAME` alone reads it while prerendering too, so it is rewritten.
    exact: true,
  };
}

/** src/env.ts as `sv create` would write it, declaring one public, optional variable. */
function envModule(variable, unit = "\t", quote = "'") {
  return [
    `import { defineEnvVars } from ${quote}@sveltejs/kit/env${quote};`,
    "",
    "export const variables = defineEnvVars({",
    declaration(variable, unit, unit, quote),
    "});",
    "",
  ].join("\n");
}

function declaration(variable, indent, unit, quote) {
  return [
    `${indent}${variable}: {`,
    `${indent}${unit}public: true,`,
    `${indent}${unit}// Optional, so a deployment without it builds and shows no Critiqs.`,
    `${indent}${unit}schema: (value) => value,`,
    `${indent}${unit}description: ${quote}${DESCRIPTION}${quote}`,
    `${indent}}`,
  ].join("\n");
}

const lineIndent = (source, index) => /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", index - 1) + 1))[0];

/** A property's name when it is written as one (`NAME:` or `'NAME':`); null for a computed key or a spread. */
const keyOf = (property) => (property.type !== "Property" || property.computed ? null : property.key.type === "Identifier" ? property.key.name : typeof property.key.value === "string" ? property.key.value : null);

/** Whether a spread or computed key follows `index` in an object's properties (all of them for -1). */
const replaceable = (properties, index) => properties.slice(index + 1).some((property) => property.type === "SpreadElement" || property.computed);

/**
 * The write that declares `variable` in src/env.ts (SvelteKit 3): a new file,
 * or one more entry in its `defineEnvVars({ … })`. None when it is already
 * declared public; a refusal when it is declared otherwise or the file isn't
 * one setup can follow.
 */
function declareVariable(root, variable, compiler) {
  const existing = ENV_FILES.map((name) => join(root, name)).find((file) => readText(file) !== null);
  if (existing === undefined) {
    const file = join(root, readText(join(root, "tsconfig.json")) === null ? "src/env.js" : "src/env.ts");
    return { writes: [{ file, original: null, source: envModule(variable) }] };
  }
  const where = shown(root, existing);
  const unreadable = {
    refusal: {
      ok: false,
      reason: "manual",
      message: `${where} doesn't declare its variables as export const variables = defineEnvVars({ … }), so setup didn't change it. Add this entry there yourself:\n\n${declaration(variable, "  ", "  ", "'")}`,
    },
  };
  const written = readText(existing);
  // Windows line endings: edit the text with \n, and write it back with \r\n.
  const crlf = written.includes("\r\n");
  const source = crlf ? written.replaceAll("\r\n", "\n") : written;
  const prefix = '<script lang="ts">';
  if (source.includes("</script")) return unreadable;
  let ast;
  try {
    ast = compiler.parse(`${prefix}${source}</script>`, { modern: true }).instance;
  } catch {
    return unreadable;
  }
  const at = (index) => index - prefix.length;
  let object = null;
  for (const node of ast?.content.body ?? []) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of node.declaration.declarations) {
      let init = declarator.init;
      while (init && (init.type === "TSSatisfiesExpression" || init.type === "TSAsExpression")) init = init.expression;
      if (declarator.id.name === "variables" && init?.type === "CallExpression" && init.arguments[0]?.type === "ObjectExpression") object = init.arguments[0];
    }
  }
  if (object === null) return unreadable;
  const declaredAt = object.properties.findLastIndex((property) => keyOf(property) === variable);
  const declared = object.properties[declaredAt];
  if (declared !== undefined) {
    const inner = declared.value.type === "ObjectExpression" ? declared.value.properties : [];
    const publicAt = inner.findLastIndex((property) => keyOf(property) === "public");
    // A spread or computed key after the declaration can replace it, and one after its `public` can turn that off.
    if (replaceable(object.properties, declaredAt) || replaceable(inner, publicAt)) {
      return {
        refusal: {
          ok: false,
          reason: "expression",
          message: `${where} declares ${variable} before a spread or computed key that could replace it or make it private, so setup didn't change it. Make it the last entry, public and optional:\n\n${declaration(variable, "  ", "  ", "'")}`,
        },
      };
    }
    const isPublic = publicAt !== -1 && inner[publicAt].value.type === "Literal" && inner[publicAt].value.value === true;
    if (isPublic) return { writes: [] };
    return {
      refusal: {
        ok: false,
        reason: "manual",
        message: `${where} declares ${variable}, but not as public: true, so the browser can't read it and setup didn't change it. Make it public and optional:\n\n${declaration(variable, "  ", "  ", "'")}`,
      },
    };
  }
  const quote = /from\s*(["'])/.exec(source)?.[1] ?? "'";
  const last = object.properties.at(-1);
  let edited;
  if (last === undefined) {
    const indent = lineIndent(source, at(object.start));
    const unit = /^[ \t]+/m.exec(source)?.[0] ?? "\t";
    const inside = source.slice(at(object.start) + 1, at(object.end) - 1);
    // An empty object becomes one entry; one holding only comments keeps them, after the entry.
    edited =
      inside.trim() === ""
        ? `${source.slice(0, at(object.start))}{\n${declaration(variable, indent + unit, unit, quote)}\n${indent}}${source.slice(at(object.end))}`
        : `${source.slice(0, at(object.start) + 1)}\n${declaration(variable, indent + unit, unit, quote)},${source.slice(at(object.start) + 1)}`;
  } else {
    const indent = lineIndent(source, at(last.start));
    const unit = indent.slice(lineIndent(source, at(object.start)).length) || "\t";
    // After the last entry, keeping a trailing comma where the file has one.
    const comma = /^\s*,/.exec(source.slice(at(last.end), at(object.end) - 1));
    const insertAt = at(last.end) + (comma?.[0].length ?? 0);
    const text = comma === null ? `,\n${declaration(variable, indent, unit, quote)}` : `\n${declaration(variable, indent, unit, quote)},`;
    edited = `${source.slice(0, insertAt)}${text}${source.slice(insertAt)}`;
  }
  return { writes: [{ file: existing, original: written, source: crlf ? edited.replaceAll("\n", "\r\n") : edited }] };
}

/** The root layout setup creates when the app has none, like `sv create`'s. */
function layoutTemplate(typescript) {
  return typescript
    ? "<script lang=\"ts\">\n\timport type { LayoutProps } from './$types';\n\n\tlet { children }: LayoutProps = $props();\n</script>\n\n{@render children()}\n"
    : "<script>\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n";
}

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const sveltekit = {
  id: "sveltekit",
  name: "SvelteKit",
  install: { ecosystem: "npm", packages: [PACKAGE] },
  detect: (root) => dependsOn(root, "@sveltejs/kit"),
  env(root, suffix) {
    // A custom env folder or public prefix is configuration setup doesn't follow.
    if (/\benv\s*:\s*\{[^}]*\b(dir|publicPrefix)\b/.test(configText(root))) return null;
    const variable = `PUBLIC_CRITIQS_PROJECT_ID${suffix}`;
    return {
      variable,
      expression: envStyle(root) === "declared" ? variable : `browser ? env.${variable} : undefined`,
      readsAt: "runtime",
      localFile: ".env.local",
      deploymentAdvice:
        `Set ${variable} in each deployment's environment to that deployment's project ID: a SvelteKit server reads it when it starts, and a prerendered or static site when it's built. ` +
        "Leave it unset where Critiqs shouldn't appear.",
    };
  },
  find: (root) => findUsages(root),
  plan(root, settings, options) {
    const declared = "env" in settings.projectId && styleOf(settings.projectId.env) === "declared";
    const module = componentModule(root);
    return planSvelte(root, settings, options, {
      manual: (wanted) => instructions(wanted, module),
      module,
      entry(appRoot, _compiler, chosen) {
        if (chosen !== null) return chosenEntry(appRoot, chosen);
        const file = join(appRoot, "src/routes/+layout.svelte");
        const source = readText(file);
        if (source !== null) return { file, source };
        let routes = false;
        try {
          routes = statSync(join(appRoot, "src/routes")).isDirectory();
        } catch {}
        if (!routes) return { problem: "Setup didn't find src/routes, so nothing was changed. Name the layout every page renders with an entry, relative to the app." };
        return { file, source: null, template: layoutTemplate(readText(join(appRoot, "tsconfig.json")) !== null) };
      },
      binding,
      extraWrites: (appRoot, _settings, compiler) => (declared ? declareVariable(appRoot, settings.projectId.env.variable, compiler) : { writes: [] }),
    });
  },
  manual: (settings) => instructions(settings, KIT_MODULE),
};

/** Complete instructions for adding Critiqs by hand, importing it from `module` (critiqs-svelte before SvelteKit 2.26). */
function instructions(settings, module) {
  const env = "env" in settings.projectId ? settings.projectId.env : null;
  const style = env === null ? null : styleOf(env);
  const attributes = wantedAttributes(settings, { code: env?.expression ?? "" }).map(([name, value]) => attributeText(name, value));
  const lines = [
    `To add Critiqs by hand, install ${PACKAGE} (npm install ${PACKAGE}) and add it to src/routes/+layout.svelte, the layout every page renders:`,
    "",
    "  <script>",
    `    import { Critiqs } from '${module}';`,
    ...(style === "declared" ? [`    import { ${env.variable} } from '${DECLARED_MODULE}';`] : style === "dynamic" ? [`    import { env } from '${DYNAMIC_MODULE}';`, `    import { browser } from '${ENVIRONMENT_MODULE}';`] : []),
    "",
    "    let { children } = $props();",
    "  </script>",
    "",
    "  {@render children()}",
    `  <Critiqs ${attributes.join(" ")} />`,
  ];
  if (module === KIT_MODULE) lines.push("", `Before SvelteKit 2.26, import it from '${PACKAGE}' instead, which leaves out SvelteKit's router.`);
  if (style === "declared") {
    lines.push("", `Declare the variable in src/env.ts (SvelteKit 3), public and optional:`, "", ...envModule(env.variable, "  ").trimEnd().split("\n").map((line) => `  ${line}`));
  }
  if (env !== null) {
    lines.push("", `Then set ${env.variable}=<project ID> in ${env.localFile ?? ".env.local"} for this computer, and in each deployment's environment.`);
  }
  return lines.join("\n");
}
