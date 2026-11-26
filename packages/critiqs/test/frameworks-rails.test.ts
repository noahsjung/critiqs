import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FRAMEWORKS } from "../bin/frameworks/index.mjs";
import { runInit } from "../bin/init.mjs";
import type { FileWrite, Plan, PlanOptions, Settings } from "../bin/frameworks/types.d.mts";

const rails = FRAMEWORKS.find((adapter) => adapter.id === "rails")!;

const PROJECT = "j12345678901234567890123456789012";

// What `rails new` (Rails 8.1) writes, trimmed to the lines setup reads.
const GEMFILE = `source "https://rubygems.org"

# Bundle edge Rails instead: gem "rails", github: "rails/rails", branch: "main"
gem "rails", "~> 8.1.4", ">= 8.1.4.1"
# The modern asset pipeline for Rails [https://github.com/rails/propshaft]
gem "propshaft"
gem "importmap-rails"

group :development, :test do
  gem "debug", platforms: %i[ mri windows ], require: "debug/prelude"
end
`;
const LAYOUT = `<!DOCTYPE html>
<html>
  <head>
    <title><%= content_for(:title) || "App" %></title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <%= csrf_meta_tags %>
    <%= csp_meta_tag %>

    <%= yield :head %>

    <%# Includes all stylesheet files in app/assets/stylesheets %>
    <%= stylesheet_link_tag :app, "data-turbo-track": "reload" %>
    <%= javascript_importmap_tags %>
  </head>

  <body>
    <%= yield %>
  </body>
</html>
`;
const LAYOUT_PATH = "app/views/layouts/application.html.erb";

/** A Rails app from the starter's files, with `files` added or replaced (null leaves one out). */
// What `rails new` writes there, trimmed.
const DEVELOPMENT_PATH = "config/environments/development.rb";
const DEVELOPMENT = `require "active_support/core_ext/integer/time"

Rails.application.configure do
  # Make code changes take effect immediately without server restart.
  config.enable_reloading = true
end
`;

function app(files: Record<string, string | null> = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-rails-"));
  for (const [name, text] of Object.entries({ Gemfile: GEMFILE, [LAYOUT_PATH]: LAYOUT, ...files })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");

// ERB as Rails's Erubi reads it: a tag runs from <% to the first %>, whatever the Ruby inside says.
const ERUBI_TAG = /<%(={1,2}|-|#|%)?([\s\S]*?)([-=])?%>/g;

/**
 * Checks a layout setup wrote the way Rails will read it: every ERB tag
 * closes, and each critiqs_tag call starts its own output tag. With
 * CRITIQS_ERB_OUT set (the gem's test task sets it), the layout is also
 * saved there, where the gem's tests compile it with Rails's own ERB handler
 * and parse the Ruby.
 */
function checkLayout(source: string) {
  const text = source.replace(ERUBI_TAG, "");
  expect(text).not.toContain("<%");
  for (const [, indicator, code] of source.matchAll(ERUBI_TAG)) {
    if (!/\bcritiqs_tag\b/.test(code!) || indicator === "#" || indicator === "%") continue;
    expect(indicator).toBe("=");
    expect(code!.trim()).toMatch(/^critiqs_tag\b/);
  }
  const out = process.env.CRITIQS_ERB_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.html.erb`), source);
  }
}

const apply = (writes: FileWrite[]) =>
  writes.forEach((write) => {
    if (write.file.endsWith(".erb")) checkLayout(write.source);
    writeFileSync(write.file, write.source);
  });
const env = (root: string, suffix = ""): Settings => ({ projectId: { env: rails.env(root, suffix)! }, requireProjectId: true });
const literal = (extra: Partial<Settings> = {}): Settings => ({ projectId: { literal: PROJECT }, requireProjectId: true, ...extra });
const noEntry: PlanOptions = { entry: null };

function ok(plan: Plan) {
  if (!plan.ok) throw new Error(`Expected a plan, got ${plan.reason}: ${plan.message}`);
  return plan;
}

/** Applies the plan, then checks that planning again changes nothing. */
function applyAndReplan(root: string, settings: Settings, options: PlanOptions = noEntry) {
  const plan = ok(rails.plan(root, settings, options));
  apply(plan.writes);
  const again = ok(rails.plan(root, settings, options));
  expect(again.action).toBe("unchanged");
  expect(again.writes).toEqual([]);
  return plan;
}

describe("env", () => {
  test("reads CRITIQS_PROJECT_ID from the server's environment at runtime", () => {
    const convention = rails.env(app(), "")!;
    expect(convention).toMatchObject({ variable: "CRITIQS_PROJECT_ID", expression: 'ENV["CRITIQS_PROJECT_ID"]', readsAt: "runtime", localFile: null });
    expect(convention.deploymentAdvice).toContain("CRITIQS_PROJECT_ID");
  });

  test("names one app of a workspace with the suffix", () => {
    expect(rails.env(app(), "_WEB")!.variable).toBe("CRITIQS_PROJECT_ID_WEB");
  });

  test("a local .env file where the app loads one with dotenv, otherwise the development environment's configuration", () => {
    expect(rails.env(app({ Gemfile: `${GEMFILE}gem "dotenv-rails", groups: [:development, :test]\n`, [DEVELOPMENT_PATH]: DEVELOPMENT }), "")!.localFile).toBe(".env");
    expect(rails.env(app({ [DEVELOPMENT_PATH]: DEVELOPMENT }), "")!.localFile).toBe(DEVELOPMENT_PATH);
  });

  test("init sets a default in config/environments/development.rb, which the environment overrides, and keeps it on a second run", () => {
    const root = app({ Gemfile: `${GEMFILE}gem "critiqs-rails"\n`, [DEVELOPMENT_PATH]: DEVELOPMENT });
    const messages: string[] = [];
    const run = (projectId: string) => {
      messages.length = 0;
      const code = runInit(["init", projectId], { cwd: root, print: (message) => messages.push(message), env: {} });
      return { code, output: messages.join("\n") };
    };
    const first = run(PROJECT);
    expect(first.code).toBe(0);
    const development =
      `${DEVELOPMENT}\n# Critiqs project for this app in development; the environment wins. Each deployment sets its own.\n` +
      `ENV["CRITIQS_PROJECT_ID"] ||= "${PROJECT}"\n`;
    expect(read(root, DEVELOPMENT_PATH)).toBe(development);
    expect(first.output).toContain(`Set CRITIQS_PROJECT_ID=${PROJECT} in ${DEVELOPMENT_PATH} for development.`);
    expect(run(PROJECT).output).toStartWith(`${LAYOUT_PATH}:`);
    expect(messages.join("\n")).toContain(`already uses this project ID (CRITIQS_PROJECT_ID in ${DEVELOPMENT_PATH})`);
    expect(read(root, DEVELOPMENT_PATH)).toBe(development);
    const other = "k98765432109876543210987654321098";
    expect(run(other).code).toBe(0);
    expect(read(root, DEVELOPMENT_PATH)).toBe(development.replace(PROJECT, other));
  });

  test("init updates an older plain ENV[…] = line in development.rb instead of adding a default it would override", () => {
    const older = DEVELOPMENT.replace("Rails.application.configure do\n", 'ENV["CRITIQS_PROJECT_ID"] = "k98765432109876543210987654321098"\nRails.application.configure do\n');
    expect(older).not.toBe(DEVELOPMENT);
    const root = app({ Gemfile: `${GEMFILE}gem "critiqs-rails"\n`, [DEVELOPMENT_PATH]: older });
    const messages: string[] = [];
    expect(runInit(["init", PROJECT], { cwd: root, print: (message) => messages.push(message), env: {} })).toBe(0);
    expect(read(root, DEVELOPMENT_PATH)).toBe(older.replace("k98765432109876543210987654321098", PROJECT));
    expect(messages.join("\n")).toContain(`Set CRITIQS_PROJECT_ID=${PROJECT} in ${DEVELOPMENT_PATH} for development.`);
  });

  const OLD = "k98765432109876543210987654321098";
  const PLAIN_GEMFILE = `${GEMFILE}gem "critiqs-rails"\n`;
  const DOTENV_GEMFILE = `${PLAIN_GEMFILE}gem "dotenv-rails", groups: [:development, :test]\n`;
  /** development.rb with `written` first in its configure block, from line 4. */
  const withLine = (written: string) => DEVELOPMENT.replace("Rails.application.configure do\n", `Rails.application.configure do\n${written}\n`);
  const ours = (value: string) =>
    `  # Critiqs project for this app in development; the environment wins. Each deployment sets its own.\n  ENV["CRITIQS_PROJECT_ID"] ||= "${value}"\n`;
  const initIn = (root: string, args: string[] = []) => {
    const messages: string[] = [];
    const code = runInit(["init", PROJECT, ...args], { cwd: root, print: (message) => messages.push(message), env: {} });
    return { code, output: messages.join("\n") };
  };

  test("init edits a hand-written line only when it sets one string, with at most a comment after it", () => {
    for (const [written, updated] of [
      [`  ENV["CRITIQS_PROJECT_ID"] = "${OLD}"`, `  ENV["CRITIQS_PROJECT_ID"] = "${PROJECT}"`],
      [`  ENV['CRITIQS_PROJECT_ID'] = '${OLD}' # staging`, `  ENV["CRITIQS_PROJECT_ID"] = "${PROJECT}" # staging`],
      [`  ENV["CRITIQS_PROJECT_ID"] ||= "${OLD}"`, `  ENV["CRITIQS_PROJECT_ID"] ||= "${PROJECT}"`],
    ]) {
      const root = app({ Gemfile: PLAIN_GEMFILE, [DEVELOPMENT_PATH]: withLine(written!) });
      const { code, output } = initIn(root);
      expect([written, code, output.includes("Warning:")]).toEqual([written, 0, false]);
      expect(read(root, DEVELOPMENT_PATH)).toBe(withLine(updated!));
    }
  });

  test("init leaves a conditional or computed line alone, sets the ID before it, and says which value the app uses", () => {
    // [the line as written, whether it only sets the variable when nothing set it before]
    const cases: [string, boolean][] = [
      [`  ENV["CRITIQS_PROJECT_ID"] = "${OLD}" + "-x"`, false],
      [`  ENV["CRITIQS_PROJECT_ID"] = "${OLD}" if ENV["CI"].nil? # hand-written`, false],
      [`  ENV["CRITIQS_PROJECT_ID"] = "${OLD}" unless ENV["CRITIQS_PROJECT_ID"]`, true],
      [`  ENV['CRITIQS_PROJECT_ID'] ||= '${OLD}' unless Rails.env.test?`, true],
      [`  if Rails.env.development?\n    ENV["CRITIQS_PROJECT_ID"] = "${OLD}"\n  end`, false],
      [`  unless ENV.key?("CRITIQS_PROJECT_ID")\n    ENV["CRITIQS_PROJECT_ID"] = "${OLD}"\n  end`, true],
    ];
    for (const [written, yields] of cases) {
      const root = app({ Gemfile: PLAIN_GEMFILE, [DEVELOPMENT_PATH]: withLine(written) });
      const first = initIn(root);
      expect([written, first.code]).toEqual([written, 0]);
      // The line stays as written; the ID is set just before it (before the block around it), so it is read first.
      expect(read(root, DEVELOPMENT_PATH)).toBe(withLine(`${ours(PROJECT)}${written}`));
      const at = written.trimStart().startsWith("ENV") ? 6 : 7;
      const text = (written.split("\n").find((line) => line.includes(OLD)) ?? "").trim();
      const said = yields
        ? `${DEVELOPMENT_PATH}:${at} sets CRITIQS_PROJECT_ID only when nothing set it before (\`${text}\`), and ${DEVELOPMENT_PATH} sets it first, so the app uses ${PROJECT}. Setup left that line as it is.`
        : `Warning: ${DEVELOPMENT_PATH}:${at} sets CRITIQS_PROJECT_ID itself (\`${text}\`) and runs after ${DEVELOPMENT_PATH} sets it, so whenever that line runs the app uses the value it sets, not ${PROJECT}. Change or remove that line to use this project.`;
      expect([written, first.output]).toEqual([written, expect.stringContaining(said)]);
      // A second run changes nothing and says the same.
      const again = initIn(root);
      expect(read(root, DEVELOPMENT_PATH)).toBe(withLine(`${ours(PROJECT)}${written}`));
      expect([written, again.output]).toEqual([written, expect.stringContaining(said)]);
    }
  });

  test("with dotenv, a line that only fills an unset variable gives way to .env, so init writes .env and leaves the line alone", () => {
    const written = `  ENV["CRITIQS_PROJECT_ID"] = "${OLD}" unless ENV["CRITIQS_PROJECT_ID"]`;
    const root = app({ Gemfile: DOTENV_GEMFILE, [DEVELOPMENT_PATH]: withLine(written), ".env": `CRITIQS_PROJECT_ID=${OLD}\n` });
    const { code, output } = initIn(root);
    expect(code).toBe(0);
    expect(read(root, ".env")).toBe(`CRITIQS_PROJECT_ID=${PROJECT}\n`);
    expect(read(root, DEVELOPMENT_PATH)).toBe(withLine(written));
    expect(output).toContain(`Set CRITIQS_PROJECT_ID=${PROJECT} in .env for this computer.`);
    expect(output).toContain(
      `${DEVELOPMENT_PATH}:4 sets CRITIQS_PROJECT_ID only when nothing set it before (\`${written.trim()}\`), and .env sets it first, so the app uses ${PROJECT}. Setup left that line as it is.`,
    );
    expect(output).not.toContain("Warning:");
  });

  test("with dotenv, a computed line wins over .env: init writes .env, leaves the line alone, and says the line wins", () => {
    const written = `  ENV["CRITIQS_PROJECT_ID"] = "${OLD}" + "-x"`;
    const root = app({ Gemfile: DOTENV_GEMFILE, [DEVELOPMENT_PATH]: withLine(written) });
    const { code, output } = initIn(root);
    expect(code).toBe(0);
    expect(read(root, ".env")).toContain(`CRITIQS_PROJECT_ID=${PROJECT}`);
    expect(read(root, DEVELOPMENT_PATH)).toBe(withLine(written));
    expect(output).toContain(
      `Warning: ${DEVELOPMENT_PATH}:4 sets CRITIQS_PROJECT_ID itself (\`${written.trim()}\`) and runs after .env sets it, so whenever that line runs the app uses the value it sets, not ${PROJECT}. Change or remove that line to use this project.`,
    );
  });

  test("with dotenv and --project-env-file .env, init writes .env without saying Rails doesn't load it, and says a plain line still wins", () => {
    const written = `  ENV["CRITIQS_PROJECT_ID"] = "${OLD}"`;
    const root = app({ Gemfile: DOTENV_GEMFILE, [DEVELOPMENT_PATH]: withLine(written) });
    const { code, output } = initIn(root, ["--project-env-file", ".env"]);
    expect(code).toBe(0);
    expect(read(root, ".env")).toContain(`CRITIQS_PROJECT_ID=${PROJECT}`);
    expect(read(root, DEVELOPMENT_PATH)).toBe(withLine(written));
    expect(output).not.toContain("doesn't load");
    expect(output).toContain(
      `Warning: ${DEVELOPMENT_PATH}:4 sets CRITIQS_PROJECT_ID itself (\`${written.trim()}\`) and runs after .env sets it, so whenever that line runs the app uses the value it sets, not ${PROJECT}. Change or remove that line to use this project, or run init again without --project-env-file to update it.`,
    );
  });

  test("with dotenv, init updates a plain ENV[…] = line in development.rb, which wins over .env, and otherwise writes .env", () => {
    const OLD = "k98765432109876543210987654321098";
    const Gemfile = `${GEMFILE}gem "critiqs-rails"\ngem "dotenv-rails", groups: [:development, :test]\n`;
    const plain = DEVELOPMENT.replace("Rails.application.configure do\n", `ENV["CRITIQS_PROJECT_ID"] = "${OLD}"\nRails.application.configure do\n`);
    const root = app({ Gemfile, [DEVELOPMENT_PATH]: plain });
    const messages: string[] = [];
    expect(runInit(["init", PROJECT], { cwd: root, print: (message) => messages.push(message), env: {} })).toBe(0);
    expect(read(root, DEVELOPMENT_PATH)).toBe(plain.replace(OLD, PROJECT));
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(messages.join("\n")).toContain(`Set CRITIQS_PROJECT_ID=${PROJECT} in ${DEVELOPMENT_PATH} for development.`);

    // A default (||=) gives way to .env, so .env is the file to write, and the default stays as it was.
    const defaulted = DEVELOPMENT.replace("end\n", `  ENV["CRITIQS_PROJECT_ID"] ||= "${OLD}"\nend\n`);
    const other = app({ Gemfile, [DEVELOPMENT_PATH]: defaulted });
    expect(runInit(["init", PROJECT], { cwd: other, print: () => {}, env: {} })).toBe(0);
    expect(read(other, ".env")).toContain(`CRITIQS_PROJECT_ID=${PROJECT}`);
    expect(read(other, DEVELOPMENT_PATH)).toBe(defaulted);
  });

  test("init warns that Rails without dotenv doesn't load a chosen .env file", () => {
    const root = app({ Gemfile: `${GEMFILE}gem "critiqs-rails"\n`, [DEVELOPMENT_PATH]: DEVELOPMENT });
    const messages: string[] = [];
    expect(runInit(["init", PROJECT, "--project-env-file", ".env"], { cwd: root, print: (message) => messages.push(message), env: {} })).toBe(0);
    expect(read(root, ".env")).toContain(`CRITIQS_PROJECT_ID=${PROJECT}`);
    expect(messages.join("\n")).toContain(
      `Warning: Ruby on Rails doesn't load .env by itself, so the app reads CRITIQS_PROJECT_ID from it only if its own code loads that file (with a dotenv library, for example). Otherwise run init again without --project-env-file: it sets a development default in ${DEVELOPMENT_PATH}.`,
    );
  });
});

describe("plan", () => {
  test("adds the gem and <%= critiqs_tag %> to a new Rails app, without writing anything itself", () => {
    const root = app();
    const plan = ok(rails.plan(root, env(root), noEntry));
    expect(read(root, LAYOUT_PATH)).toBe(LAYOUT);
    expect(plan.action).toBe("install");
    expect(plan.writes.map((write) => write.file)).toEqual([join(root, "Gemfile"), join(root, LAYOUT_PATH)]);
    expect(plan.writes[0]!.source).toBe(`${GEMFILE}\ngem "critiqs-rails"\n`);
    expect(plan.writes[1]!.source).toBe(LAYOUT.replace("    <%= yield %>\n", '    <%= yield %>\n    <%= critiqs_tag %>\n'));
    expect(plan).toMatchObject({ file: join(root, LAYOUT_PATH), line: 18, preview: "<%= critiqs_tag %>" });
    expect(plan.changed).toEqual(["projectId", "requireProjectId"]);
    // Setup itself says what each deployment sets.
    expect(plan.next).toEqual(["Run bundle install."]);
  });

  test("a second plan changes nothing", () => {
    const root = app();
    applyAndReplan(root, env(root));
    expect(read(root, "Gemfile").match(/critiqs-rails/g)).toHaveLength(1);
    expect(read(root, LAYOUT_PATH).match(/critiqs_tag/g)).toHaveLength(1);
  });

  test("writes a literal project ID and a team's backend into the call", () => {
    const root = app();
    applyAndReplan(root, literal({ backend: "https://team.example/critiqs" }));
    expect(read(root, LAYOUT_PATH)).toContain(`    <%= critiqs_tag(project_id: "${PROJECT}", backend: "https://team.example/critiqs") %>\n  </body>`);
  });

  test("a literal ID without requireProjectId says so, since the helper requires it by default", () => {
    const root = app();
    applyAndReplan(root, literal({ requireProjectId: false }));
    expect(read(root, LAYOUT_PATH)).toContain(`<%= critiqs_tag(project_id: "${PROJECT}", require_project_id: false) %>`);
  });

  test("a workspace app's own variable is read in the call", () => {
    const root = app();
    applyAndReplan(root, env(root, "_WEB"));
    expect(read(root, LAYOUT_PATH)).toContain('<%= critiqs_tag(project_id: ENV["CRITIQS_PROJECT_ID_WEB"]) %>');
  });

  test("updates the call already there, keeping arguments setup doesn't manage", () => {
    const root = app({ Gemfile: `${GEMFILE}gem "critiqs-rails", "~> 0.3"\n`, [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", '<%= yield %>\n    <%= critiqs_tag id: "critiqs", version: ENV["GIT_SHA"] %>') });
    const plan = applyAndReplan(root, literal());
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"], line: 18 });
    expect(plan.writes.map((write) => write.file)).toEqual([join(root, LAYOUT_PATH)]);
    expect(read(root, LAYOUT_PATH)).toContain(`<%= critiqs_tag id: "critiqs", version: ENV["GIT_SHA"], project_id: "${PROJECT}" %>`);
  });

  test("going back to the environment drops arguments the helper's defaults cover", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", `<%= yield %>\n    <%= critiqs_tag(project_id: "${PROJECT}", require_project_id: false, backend: "https://team.example") %>`) });
    const plan = applyAndReplan(root, env(root));
    expect(plan.changed).toEqual(["projectId", "requireProjectId"]);
    expect(read(root, LAYOUT_PATH)).toContain('<%= critiqs_tag(backend: "https://team.example") %>');
  });

  test("a call that already says the same in other words is unchanged", () => {
    const root = app({
      Gemfile: `${GEMFILE}gem 'critiqs-rails'\n`,
      [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %>\n    <%= critiqs_tag project_id: ENV.fetch('CRITIQS_PROJECT_ID', nil), require_project_id: true -%>"),
    });
    const plan = ok(rails.plan(root, env(root), noEntry));
    expect(plan).toMatchObject({ action: "unchanged", writes: [], changed: [] });
  });

  test("keeps tabs and Windows line endings", () => {
    const root = app({ Gemfile: GEMFILE.replaceAll("\n", "\r\n"), [LAYOUT_PATH]: "<html>\r\n\t<body>\r\n\t\t<%= yield %>\r\n\t</body>\r\n</html>\r\n" });
    applyAndReplan(root, env(root));
    expect(read(root, LAYOUT_PATH)).toBe("<html>\r\n\t<body>\r\n\t\t<%= yield %>\r\n\t\t<%= critiqs_tag %>\r\n\t</body>\r\n</html>\r\n");
    expect(read(root, "Gemfile").endsWith('end\r\n\r\ngem "critiqs-rails"\r\n')).toBe(true);
  });

  test("a Gemfile without a final newline", () => {
    const root = app({ Gemfile: 'source "https://rubygems.org"\ngem "rails"' });
    applyAndReplan(root, env(root));
    expect(read(root, "Gemfile")).toBe('source "https://rubygems.org"\ngem "rails"\n\ngem "critiqs-rails"\n');
  });

  test("</body> on a line with other markup gets the tag right before it", () => {
    const root = app({ [LAYOUT_PATH]: "<html><body><%= yield %></body></html>\n" });
    applyAndReplan(root, env(root));
    expect(read(root, LAYOUT_PATH)).toBe("<html><body><%= yield %><%= critiqs_tag %></body></html>\n");
  });

  test("honours the layout the person chose", () => {
    const admin = "app/views/layouts/admin.html.erb";
    const root = app({ [admin]: LAYOUT });
    const plan = applyAndReplan(root, env(root), { entry: admin });
    expect(plan.file).toBe(join(root, admin));
    expect(read(root, admin)).toContain("<%= critiqs_tag %>");
    expect(read(root, LAYOUT_PATH)).toBe(LAYOUT);
  });

  test("refuses a chosen layout when Critiqs is already set up in another", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %><%= critiqs_tag %>"), "app/views/layouts/admin.html.erb": LAYOUT });
    const plan = rails.plan(root, env(root), { entry: "app/views/layouts/admin.html.erb" });
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(!plan.ok && plan.message).toContain(`${LAYOUT_PATH}:17`);
  });

  test("refuses when critiqs_tag appears more than once", () => {
    const root = app({ "app/views/pages/home.html.erb": "<%= critiqs_tag %>\n", [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %><%= critiqs_tag %>") });
    const plan = rails.plan(root, env(root), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(!plan.ok && plan.message).toContain("app/views/pages/home.html.erb:1");
  });

  test("refuses to replace a project ID the code computes", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %>\n    <%= critiqs_tag(project_id: Rails.application.credentials.critiqs_project) %>") });
    const plan = rails.plan(root, literal(), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "expression" });
    expect(!plan.ok && plan.message).toContain(`${LAYOUT_PATH}:18 sets project_id from code (Rails.application.credentials.critiqs_project)`);
    expect(!plan.ok && plan.message).toContain(`critiqs_tag(project_id: "${PROJECT}")`);
  });

  test("refuses arguments it can't read", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %>\n    <%= critiqs_tag(**critiqs_options) %>") });
    expect(rails.plan(root, env(root), noEntry)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test.each<[string, Record<string, string | null>]>([
    ["the layout is Haml", { [LAYOUT_PATH]: null, "app/views/layouts/application.html.haml": "%html\n  %body\n    = yield\n" }],
    ["the layout has two </body>", { [LAYOUT_PATH]: "<body></body>\n<body></body>\n" }],
  ])("gives complete instructions instead when %s", (_, files) => {
    const root = app(files);
    const plan = rails.plan(root, env(root), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    const message = !plan.ok ? plan.message : "";
    for (const part of ['gem "critiqs-rails"', "bundle install", LAYOUT_PATH, "<%= critiqs_tag %>", "CRITIQS_PROJECT_ID"]) expect(message).toContain(part);
  });

  test("rewrites a call that spans lines in place", () => {
    const call = '<%= critiqs_tag project_id: "jold",\n                  version: ENV["GIT_SHA"] %>';
    const root = app({ Gemfile: `${GEMFILE}gem "critiqs-rails"\n`, [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", `<%= yield %>\n    ${call}`) });
    const plan = applyAndReplan(root, literal());
    expect(plan).toMatchObject({ action: "update", changed: ["projectId"], line: 18 });
    expect(read(root, LAYOUT_PATH)).toBe(LAYOUT.replace("<%= yield %>", `<%= yield %>\n    <%= critiqs_tag project_id: "${PROJECT}",\n                  version: ENV["GIT_SHA"] %>`));
  });

  test("a call written with -%> and parentheses across lines keeps its delimiters", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", '<%= yield %>\n    <%= critiqs_tag(\n      backend: "https://team.example"\n    ) -%>') });
    applyAndReplan(root, literal());
    expect(read(root, LAYOUT_PATH)).toContain(`    <%= critiqs_tag(\n      backend: "https://team.example",\n      project_id: "${PROJECT}"\n    ) -%>\n  </body>`);
  });

  test("a value holding %> can't end the ERB tag early", () => {
    const root = app();
    applyAndReplan(root, literal({ backend: "https://team.example/a%>b" }));
    expect(read(root, LAYOUT_PATH)).toContain(`<%= critiqs_tag(project_id: "${PROJECT}", backend: "https://team.example/a%\\>b") %>`);
  });

  test("adds the tag before the real </body>, not one inside ERB code, an ERB comment, an HTML comment or a script", () => {
    const layout = LAYOUT.replace("<%= yield %>", '<%= yield %>\n    <%= content_for?(:footer) ? "</body>" : "" %>\n    <%# </body> %>\n    <!-- </body> -->\n    <script>document.write("</body>")</script>');
    const root = app({ [LAYOUT_PATH]: layout });
    applyAndReplan(root, env(root));
    expect(read(root, LAYOUT_PATH)).toBe(layout.replace("</script>\n", "</script>\n    <%= critiqs_tag %>\n"));
  });

  test("refuses when the only </body> is inside ERB code", () => {
    const root = app({ [LAYOUT_PATH]: '<html>\n  <body>\n    <%= yield %>\n  <%= "</body>".html_safe %>\n</html>\n' });
    const plan = rails.plan(root, env(root), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    expect(!plan.ok && plan.message).toContain("<%= critiqs_tag %>");
  });

  test("refuses a layout with an ERB tag that never closes", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield") });
    expect(rails.plan(root, env(root), noEntry)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("critiqs_tag in an ERB comment or the page's text isn't Critiqs set up", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %>\n    <%# critiqs_tag goes here %>\n    <p>critiqs_tag</p>") });
    expect(rails.find(root)).toEqual([]);
    const plan = applyAndReplan(root, env(root));
    expect(plan.action).toBe("install");
  });

  test("refuses a critiqs_tag call inside other code", () => {
    const root = app({ [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", '<%= yield %>\n    <%= Rails.env.staging? ? critiqs_tag : "" %>') });
    expect(rails.plan(root, env(root), noEntry)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("a chosen layout outside app/views is read again on the next run", () => {
    const engine = "engines/admin/app/views/layouts/application.html.erb";
    const root = app({ [engine]: LAYOUT });
    const plan = applyAndReplan(root, env(root), { entry: engine });
    expect(plan.file).toBe(join(root, engine));
    expect(read(root, engine).match(/critiqs_tag/g)).toHaveLength(1);
    expect(read(root, LAYOUT_PATH)).toBe(LAYOUT);
    expect(ok(rails.plan(root, literal(), { entry: engine }))).toMatchObject({ action: "update", changed: ["projectId"] });
  });

  test.each([
    ["a development group block", `${GEMFILE}\ngroup :development do\n  gem "critiqs-rails"\nend\n`],
    ["the starter's development and test group", GEMFILE.replace('  gem "debug"', '  gem "critiqs-rails"\n  gem "debug"')],
    ["a group: option", `${GEMFILE}gem "critiqs-rails", group: :test\n`],
    ["a groups: option", `${GEMFILE}gem "critiqs-rails", groups: [:development, :staging]\n`],
    ["require: false", `${GEMFILE}gem "critiqs-rails", require: false\n`],
    ["a platforms block", `${GEMFILE}platforms :jruby do\n  gem "critiqs-rails"\nend\n`],
    ["an if block", `${GEMFILE}if ENV["REVIEW"]\n  gem "critiqs-rails"\nend\n`],
    ["a trailing condition", `${GEMFILE}gem "critiqs-rails" unless ENV["CI"]\n`],
  ])("refuses to edit the layout when the Gemfile has the gem only in %s, since production wouldn't load the helper", (_, gemfile) => {
    const root = app({ Gemfile: gemfile });
    const plan = rails.plan(root, env(root), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    const message = !plan.ok ? plan.message : "";
    expect(message).toContain("Gemfile");
    for (const part of ['gem "critiqs-rails"', "bundle install", LAYOUT_PATH, "<%= critiqs_tag %>"]) expect(message).toContain(part);
    expect(read(root, LAYOUT_PATH)).toBe(LAYOUT);
  });

  test.each([
    ["after a group block ends", `${GEMFILE}\ngroup :test do\n  gem "capybara"\nend\n\ngem "critiqs-rails"\n`],
    ["inside a group :default block", `${GEMFILE}group :default do\n  gem "critiqs-rails"\nend\n`],
    ["inside a source block", `${GEMFILE}source "https://gems.example" do\n  gem "critiqs-rails"\nend\n`],
    ["with a version and require: true", `${GEMFILE}gem "critiqs-rails", "~> 0.3", require: true\n`],
  ])("a gem every environment loads, %s, is enough", (_, gemfile) => {
    const root = app({ Gemfile: gemfile });
    const plan = applyAndReplan(root, env(root));
    expect(plan.writes.map((write) => write.file)).toEqual([join(root, LAYOUT_PATH)]);
  });

  describe("edits a call's arguments in place, never joining lines", () => {
    const withCall = (call: string) => LAYOUT.replace("<%= yield %>", `<%= yield %>\n    ${call}`);
    const gemfile = `${GEMFILE}gem "critiqs-rails"\n`;

    test.each<[string, string, Settings | "env", string]>([
      [
        "a comment after the last argument stays before the closing parenthesis",
        '<%= critiqs_tag(\n      project_id: "jold",\n      version: ENV["GIT_SHA"] # the commit of this deploy\n    ) %>',
        literal(),
        `<%= critiqs_tag(\n      project_id: "${PROJECT}",\n      version: ENV["GIT_SHA"] # the commit of this deploy\n    ) %>`,
      ],
      [
        "a new argument goes on its own line after a commented last argument, whatever the comment says",
        '<%= critiqs_tag(\n      version: ENV["GIT_SHA"] # the deploy\'s commit\n    ) %>',
        literal(),
        `<%= critiqs_tag(\n      version: ENV["GIT_SHA"], # the deploy's commit\n      project_id: "${PROJECT}"\n    ) %>`,
      ],
      [
        "dropping commented arguments keeps the other comments",
        `<%= critiqs_tag(\n      backend: "https://team.example", # our server\n      project_id: "${PROJECT}" # staging\n    ) %>`,
        "env",
        '<%= critiqs_tag(\n      backend: "https://team.example" # our server\n    ) %>',
      ],
      [
        "dropping every argument, comments and all, leaves the plain call",
        `<%= critiqs_tag(\n      project_id: "${PROJECT}", # staging\n      require_project_id: false\n    ) %>`,
        "env",
        "<%= critiqs_tag %>",
      ],
      [
        "a trailing if stays outside the call",
        '<%= critiqs_tag version: ENV["GIT_SHA"] if Rails.env.staging? %>',
        literal(),
        `<%= critiqs_tag version: ENV["GIT_SHA"], project_id: "${PROJECT}" if Rails.env.staging? %>`,
      ],
      ["a trailing unless after no arguments", "<%= critiqs_tag unless Rails.env.production? %>", literal(), `<%= critiqs_tag(project_id: "${PROJECT}") unless Rails.env.production? %>`],
      [
        "a trailing rescue after parentheses",
        '<%= critiqs_tag(version: ENV.fetch("GIT_SHA")) rescue nil %>',
        literal(),
        `<%= critiqs_tag(version: ENV.fetch("GIT_SHA"), project_id: "${PROJECT}") rescue nil %>`,
      ],
      ["dropping the only argument before a modifier", `<%= critiqs_tag(project_id: "${PROJECT}") if Rails.env.staging? %>`, "env", "<%= critiqs_tag if Rails.env.staging? %>"],
      [
        "a string with a comma, a # and interpolation is one value",
        '<%= critiqs_tag version: "#{ENV["GIT_SHA"]}, #1", id: "critiqs" %>',
        literal(),
        `<%= critiqs_tag version: "#{ENV["GIT_SHA"]}, #1", id: "critiqs", project_id: "${PROJECT}" %>`,
      ],
      [
        "a backslash continuing the call onto a trailing if's line: the new argument goes before the backslash",
        '<%= critiqs_tag version: ENV["GIT_SHA"] \\\n    if Rails.env.staging? %>',
        literal(),
        `<%= critiqs_tag version: ENV["GIT_SHA"], project_id: "${PROJECT}" \\\n    if Rails.env.staging? %>`,
      ],
      [
        "an argument on its own line before a backslash: the new one goes on its own line, keeping the backslash last",
        '<%= critiqs_tag version: 1,\n                id: "critiqs" \\\n    if Rails.env.staging? %>',
        literal(),
        `<%= critiqs_tag version: 1,\n                id: "critiqs",\n                project_id: "${PROJECT}" \\\n    if Rails.env.staging? %>`,
      ],
      [
        "dropping the last argument on its own line keeps the backslash",
        `<%= critiqs_tag version: 1,\n                project_id: "${PROJECT}" \\\n    if Rails.env.staging? %>`,
        "env",
        "<%= critiqs_tag version: 1 \\\n    if Rails.env.staging? %>",
      ],
      [
        "a backslash after parentheses",
        "<%= critiqs_tag(version: 1) \\\n    if Rails.env.staging? %>",
        literal(),
        `<%= critiqs_tag(version: 1, project_id: "${PROJECT}") \\\n    if Rails.env.staging? %>`,
      ],
      ["a backslash after no arguments", "<%= critiqs_tag \\\n    unless Rails.env.production? %>", literal(), `<%= critiqs_tag(project_id: "${PROJECT}") \\\n    unless Rails.env.production? %>`],
    ])("%s", (_, call, settings, expected) => {
      const root = app({ Gemfile: gemfile, [LAYOUT_PATH]: withCall(call) });
      applyAndReplan(root, settings === "env" ? env(root) : settings);
      expect(read(root, LAYOUT_PATH)).toBe(withCall(expected));
    });

    test.each([
      ["a call that continues into other code", "<%= critiqs_tag(version: 1) + tag.hr %>"],
      ["a call joined with and", "<%= critiqs_tag version: 1 and true %>"],
      ["a heredoc", "<%= critiqs_tag version: <<~V.strip\n  1\nV\n%>"],
    ])("refuses %s", (_, call) => {
      const root = app({ Gemfile: gemfile, [LAYOUT_PATH]: withCall(call) });
      expect(rails.plan(root, literal(), noEntry)).toMatchObject({ ok: false, reason: "unreadable" });
    });
  });

  test.each([
    ["a group on the next line", `${GEMFILE}gem "critiqs-rails",\n  group: :development\n`],
    ["require: false on the next line", `${GEMFILE}gem "critiqs-rails", "~> 0.3",\n    require: false\n`],
    ["platforms on the next line", `${GEMFILE}gem "critiqs-rails",\n  platforms: :jruby\n`],
    ["a platforms option", `${GEMFILE}gem "critiqs-rails", platforms: %i[mri]\n`],
    ["parentheses across lines", `${GEMFILE}gem("critiqs-rails",\n  "~> 0.3",\n  groups: [:development])\n`],
    ["a comment-only line before require: false", `${GEMFILE}gem "critiqs-rails",\n  # loaded by hand in development\n  require: false\n`],
    ["a blank line before the group", `${GEMFILE}gem "critiqs-rails",\n\n  group: :development\n`],
    ["the name on the line after gem(", `${GEMFILE}gem(\n  "critiqs-rails",\n  group: :development\n)\n`],
  ])("reads a gem declaration across lines: refuses %s", (_, gemfile) => {
    const root = app({ Gemfile: gemfile });
    const plan = rails.plan(root, env(root), noEntry);
    expect(plan).toMatchObject({ ok: false, reason: "manual" });
    expect(!plan.ok && plan.message).toContain("(line 12)");
  });

  test("a gem declared across lines with only a version is enough", () => {
    const root = app({ Gemfile: `${GEMFILE}gem "critiqs-rails",\n  "~> 0.3" # every environment\n` });
    expect(applyAndReplan(root, env(root)).writes.map((write) => write.file)).toEqual([join(root, LAYOUT_PATH)]);
  });

  test.each([
    ["the name on the line after gem(", `${GEMFILE}gem(\n  "critiqs-rails"\n)\n`],
    ["a comment and a blank line inside the declaration", `${GEMFILE}gem "critiqs-rails",\n  # pinned for now\n\n  "~> 0.3"\n`],
  ])("a gem declared across lines with %s is enough, and isn't declared a second time", (_, gemfile) => {
    const root = app({ Gemfile: gemfile });
    expect(applyAndReplan(root, env(root)).writes.map((write) => write.file)).toEqual([join(root, LAYOUT_PATH)]);
    expect(read(root, "Gemfile")).toBe(gemfile);
  });

  test("finds the page's </body>, not one in an attribute value", () => {
    const layout = '<html>\n  <body data-template="</body>" title=\'</body>\'>\n    <%= yield %>\n  </body>\n</html>\n';
    const root = app({ [LAYOUT_PATH]: layout });
    applyAndReplan(root, env(root));
    expect(read(root, LAYOUT_PATH)).toBe(layout.replace("    <%= yield %>\n", "    <%= yield %>\n    <%= critiqs_tag %>\n"));
  });

  test("refuses when the only </body> is inside an attribute value, since the page leaves its end tag out", () => {
    const root = app({ [LAYOUT_PATH]: '<html>\n  <body data-template="</body>">\n    <%= yield %>\n</html>\n' });
    expect(rails.plan(root, env(root), noEntry)).toMatchObject({ ok: false, reason: "manual" });
  });

  test("finds the page's </body>, not one in a textarea or the title", () => {
    const layout = "<html>\n  <head><title>a</body>b</title></head>\n  <body>\n    <textarea></body></textarea>\n  </body>\n</html>\n";
    const root = app({ [LAYOUT_PATH]: layout });
    applyAndReplan(root, env(root));
    expect(read(root, LAYOUT_PATH)).toBe(layout.replace("</textarea>\n", "</textarea>\n    <%= critiqs_tag %>\n"));
  });

  test("refuses when the only </body> is inside a textarea, since the page leaves it out", () => {
    const root = app({ [LAYOUT_PATH]: "<html>\n  <body>\n    <%= yield %>\n    <textarea>\n</body>\n    </textarea>\n</html>\n" });
    expect(rails.plan(root, env(root), noEntry)).toMatchObject({ ok: false, reason: "manual" });
  });

  test("a chosen layout that isn't ERB gets instructions", () => {
    const root = app({ "app/views/layouts/admin.html.haml": "%html\n" });
    expect(rails.plan(root, env(root), { entry: "app/views/layouts/admin.html.haml" })).toMatchObject({ ok: false, reason: "manual" });
  });
});

describe("find", () => {
  test("reads each call's settings, with the helper's defaults", () => {
    const root = app({
      [LAYOUT_PATH]: LAYOUT.replace("<%= yield %>", "<%= yield %>\n    <%= critiqs_tag %>"),
      "app/views/layouts/admin.html.erb": `<%= critiqs_tag(project_id: '${PROJECT}', backend: "https://team.example", require_project_id: false) %>`,
    });
    expect(rails.find(root)).toEqual([
      { file: join(root, "app/views/layouts/admin.html.erb"), line: 1, projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: "https://team.example" }, requireProjectId: false },
      { file: join(root, LAYOUT_PATH), line: 18, projectId: { kind: "env", variable: "CRITIQS_PROJECT_ID" }, backend: null, requireProjectId: true },
    ]);
  });

  test("an app without Critiqs has no usages", () => {
    expect(rails.find(app())).toEqual([]);
  });
});

test("manual instructions name the gem, the layout, and the call", () => {
  const text = rails.manual(literal({ backend: "https://team.example" }));
  expect(text).toContain('gem "critiqs-rails"');
  expect(text).toContain(LAYOUT_PATH);
  expect(text).toContain(`<%= critiqs_tag(project_id: "${PROJECT}", backend: "https://team.example") %>`);
});
